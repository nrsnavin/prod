'use strict';
// ─────────────────────────────────────────────────────────────
//  QUOTATIONS
//
//  A price offered to a customer for one metre of an elastic, with the
//  costing that produced it.
//
//  Two things this router insists on, both for the same reason — a
//  quote is a number somebody is held to:
//
//  1. The server recomputes every figure from the submitted weights and
//     rates. The browser calculates the same chain live as you type, but
//     what is stored and printed is what the server worked out. A price
//     the customer holds must be one this system stands behind, not one
//     a stale tab or a hand-edited request said it was.
//
//  2. The costing is FROZEN on the quote rather than referenced. Yarn
//     prices move; a quote reopened next month must still explain the
//     price it went out at, not restate itself at today's costs.
// ─────────────────────────────────────────────────────────────

const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const catchAsyncErrors = require('../middleware/catchAsyncErrors');
const ErrorHandler     = require('../utils/ErrorHandler');
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const { requireReason } = require('../utils/auditReason');
const { escapeRegex }   = require('../utils/escapeRegex');

const Quote    = require('../models/Quote');
const Customer = require('../models/Customer');
const { priceQuote } = require('../utils/quoteCosting');
const winLoss = require('../services/quoteWinLoss');
const { currentFinancialYear }  = require('../utils/financialYear');
const { nextNumber }            = require('../utils/sequence');
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');

const PdfTemplate           = require('../models/PdfTemplate');
const { renderTemplatePdf } = require('../services/pdf/templateRenderer');
const { starterTemplate }   = require('../services/pdf/docTypes');
const { getPdfBranding }    = require('../services/documentSettings');
const { quoteToContext }    = require('../services/pdf/quoteContext');

router.use(isAuthenticated);

// A quote shows cost and margin, so it sits behind the same gate as
// purchase orders rather than being a shop-floor screen.
const gate = isAdmin('admin', 'accounts');

const DEFAULT_VALIDITY_DAYS = 30;

async function nextSeq(financialYear) {
  return nextNumber(`quote:${financialYear}`, async () => {
    const last = await Quote.findOne({ financialYear })
      .sort({ sequence: -1 }).select('sequence').lean();
    return last?.sequence ?? 0;
  });
}

const buildQuoteNo = (fy, seq) => `QT-${fy}-${String(seq).padStart(4, '0')}`;

/**
 * Read one product line off the request and validate it.
 *
 * Returns { error } for anything that cannot be priced, so the caller
 * answers with one clear refusal naming the line rather than storing a
 * nonsense quote.
 */
function readLine(raw, index) {
  const where = `Product ${index + 1}`;

  const productName = String(raw?.productName ?? '').trim();
  if (!productName) return { error: `${where} has no name.` };

  const rawMaterials = Array.isArray(raw?.materials) ? raw.materials : [];

  // Rows with no weight AND no rate are dropped rather than refused —
  // the form ships with four named rows and leaving one unused is
  // normal. A row with figures but no name cannot be printed or
  // understood later, so that one is refused.
  const materials = [];
  for (const [i, m] of rawMaterials.entries()) {
    const label  = String(m?.label ?? '').trim();
    const weight = Number(m?.weightGrams);
    const rate   = Number(m?.ratePerKg);

    if (!weight && !rate) continue;

    if (!label) {
      return { error: `${where}, line ${i + 1} has figures but no material name.` };
    }
    if (!Number.isFinite(weight) || !Number.isFinite(rate)) {
      return { error: `${where}, line ${i + 1}: weight and rate must be numbers.` };
    }
    if (weight < 0 || rate < 0) {
      return { error: `${where}, line ${i + 1}: weight and rate cannot be negative.` };
    }
    materials.push({ label, weightGrams: weight, ratePerKg: rate });
  }

  if (materials.length === 0) {
    return { error: `${where} needs at least one material with a weight and a rate.` };
  }

  const marginPercent = Number(raw?.marginPercent);
  if (!Number.isFinite(marginPercent) || marginPercent < 0) {
    return { error: `${where}: margin % must be zero or more.` };
  }

  const conversionCost = Number(raw?.conversionCost) || 0;
  if (conversionCost < 0) {
    return { error: `${where}: conversion cost cannot be negative.` };
  }

  return {
    line: {
      elastic: mongoose.Types.ObjectId.isValid(raw?.elastic) ? raw.elastic : undefined,
      productName,
      productSpec: String(raw?.productSpec ?? '').trim(),
      materials,
      conversionCost,
      marginPercent,
      quantityMetres: Math.max(0, Number(raw?.quantityMetres) || 0),
    },
  };
}

/**
 * Read every line off a request body and price the whole document.
 *
 * Accepts a single-product body too — productName/materials at the top
 * level — because that is what the first version of this route took and
 * what older clients still send. One shape reaching the pricing code
 * means there is no second arithmetic path to disagree with the first.
 */
function costingFromBody(body) {
  // An explicitly EMPTY lines array is somebody asking to quote nothing,
  // and saying "Product 1 has no name" about a product that was never
  // there sends them looking for the wrong mistake.
  if (Array.isArray(body?.lines) && body.lines.length === 0) {
    return { error: 'A quotation needs at least one product.' };
  }

  const rawLines = Array.isArray(body?.lines) && body.lines.length
    ? body.lines
    : [body];

  const lines = [];
  for (const [i, raw] of rawLines.entries()) {
    const { line, error } = readLine(raw, i);
    if (error) return { error };
    lines.push(line);
  }

  const gstPercent = body?.gstPercent === undefined || body?.gstPercent === null
    ? 5
    : Number(body.gstPercent);
  if (!Number.isFinite(gstPercent) || gstPercent < 0) {
    return { error: 'GST % must be zero or more.' };
  }

  const priced = priceQuote({ lines, gstPercent });

  // Marry the input back onto the priced result: the costing helper
  // knows about money, not about which elastic a line names.
  return {
    priced: {
      ...priced,
      lines: priced.lines.map((p, i) => ({
        elastic:        lines[i].elastic,
        productName:    lines[i].productName,
        productSpec:    lines[i].productSpec,
        conversionCost: p.conversionCost,
        marginPercent:  p.marginPercent,
        quantityMetres: p.quantityMetres,
        materials:      p.materials,
        totalWeightGrams: p.totalWeightGrams,
        materialCost:     p.materialCost,
        totalCost:        p.totalCost,
        marginAmount:     p.marginAmount,
        rateBeforeTax:    p.rateBeforeTax,
        gstAmount:        p.gstAmount,
        rateInclTax:      p.rateInclTax,
        valueBeforeTax:   p.valueBeforeTax,
        valueInclTax:     p.valueInclTax,
      })),
    },
  };
}

/** Everything the costing decides, ready to assign onto a document. */
const costingFields = (c) => ({
  lines:               c.priced.lines,
  gstPercent:          c.priced.gstPercent,
  subTotal:            c.priced.subTotal,
  gstAmount:           c.priced.gstAmount,
  grandTotal:          c.priced.grandTotal,
  totalQuantityMetres: c.priced.totalQuantityMetres,
});

function stamp(doc, code, req, meta) {
  const fp = buildFingerprint(code, {
    entityId: doc._id,
    actor:    actorFromRequest(req),
    meta,
  });
  doc.fingerprints = [...(doc.fingerprints || []), fp];
  doc.markModified('fingerprints');
}

// ─────────────────────────────────────────────────────────────
//  POST /create
// ─────────────────────────────────────────────────────────────
router.post(
  '/create',
  gate,
  catchAsyncErrors(async (req, res, next) => {
    const {
      customerName, customerAddress, customerGstin, customerPhone,
      customerRef, customer,
      date, validTill, remarks,
    } = req.body || {};

    // Either pick a customer from the master or type one. A quote often
    // goes to somebody who is not a customer yet — that is what quoting
    // is for — so the NAME is what is required and the link is what is
    // optional.
    const snapshot = {
      customerName:    String(customerName ?? '').trim(),
      customerAddress: String(customerAddress ?? '').trim(),
      customerGstin:   String(customerGstin ?? '').trim(),
      customerPhone:   String(customerPhone ?? '').trim(),
    };

    let customerId;
    if (mongoose.Types.ObjectId.isValid(customer)) {
      const master = await Customer.findById(customer)
        .select('name gstin phoneNumber email').lean();
      if (!master) return next(new ErrorHandler('Customer not found', 404));
      customerId = master._id;
      // The master fills the blanks; anything typed on the quote wins,
      // because a quote sometimes goes to a different address or a
      // different GSTIN of the same customer.
      snapshot.customerName  = snapshot.customerName  || master.name        || '';
      snapshot.customerGstin = snapshot.customerGstin || master.gstin       || '';
      snapshot.customerPhone = snapshot.customerPhone || master.phoneNumber || '';
      // The customer master holds no address — it never has. So the
      // delivery address is typed on the quote, which is right anyway:
      // a quotation often goes to a buying office rather than the mill.
      // Left as whatever was typed, never blanked from a field that
      // does not exist.
    }

    if (!snapshot.customerName) {
      return next(new ErrorHandler('Customer name is required', 400));
    }

    const costing = costingFromBody(req.body);
    if (costing.error) return next(new ErrorHandler(costing.error, 400));

    const quoteDate = date ? new Date(date) : new Date();
    if (isNaN(quoteDate.getTime())) {
      return next(new ErrorHandler('Quote date is not a valid date', 400));
    }

    let till = validTill ? new Date(validTill) : null;
    if (till && isNaN(till.getTime())) till = null;
    if (!till) {
      till = new Date(quoteDate);
      till.setDate(till.getDate() + DEFAULT_VALIDITY_DAYS);
    }
    if (till < quoteDate) {
      return next(new ErrorHandler(
        'The valid-until date is before the quote date — a price cannot expire before it is offered.',
        400
      ));
    }

    const financialYear = currentFinancialYear(quoteDate);
    const sequence      = await nextSeq(financialYear);
    const quoteNo       = buildQuoteNo(financialYear, sequence);

    const quote = new Quote({
      quoteNo, financialYear, sequence,
      date: quoteDate, validTill: till,
      customer: customerId,
      ...snapshot,
      customerRef: String(customerRef ?? '').trim(),
      remarks:     String(remarks ?? '').trim(),
      createdBy:   req.user?._id,
      ...costingFields(costing),
    });

    stamp(quote, ACTION_CODES.QUOTE_CREATED, req, {
      quoteNo,
      customer: quote.customerName,
      products: quote.lines.length,
      grandTotal: quote.grandTotal,
    });
    await quote.save();

    res.status(201).json({ success: true, quote });
  })
);

// ─────────────────────────────────────────────────────────────
//  PUT /update — repricing an existing quote.
//
//  Allowed while the quote is a draft or has merely been sent. Once a
//  customer has ACCEPTED it, the price is the agreement; changing it
//  would rewrite what was agreed, so it is refused and a fresh quote is
//  the answer.
// ─────────────────────────────────────────────────────────────
router.put(
  '/update',
  gate,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid quote id is required', 400));
    }
    const auditReason = requireReason(req);
    if (!auditReason) {
      return next(new ErrorHandler('A reason (min 3 chars) is required to edit', 400));
    }

    const quote = await Quote.findById(id);
    if (!quote) return next(new ErrorHandler('Quote not found', 404));

    if (['accepted', 'cancelled'].includes(quote.status)) {
      return next(new ErrorHandler(
        `Quote ${quote.quoteNo} is ${quote.status} — its price is settled. Raise a fresh quote instead.`,
        409
      ));
    }

    const snapshotOf = (q) => ({
      products:   q.lines.map((l) => l.productName),
      subTotal:   q.subTotal,
      grandTotal: q.grandTotal,
      rates:      q.lines.map((l) => l.rateBeforeTax),
    });
    const before = snapshotOf(quote);

    if (Array.isArray(req.body.lines) || Array.isArray(req.body.materials)) {
      // A reprice usually sends figures, not names: "same products, 30%
      // margin". Each incoming line inherits what it does not restate
      // from the line already in that position, so changing a margin
      // cannot blank the product it belongs to.
      const existing = quote.lines || [];
      const incoming = Array.isArray(req.body.lines) && req.body.lines.length
        ? req.body.lines
        : [req.body];

      const merged = incoming.map((raw, i) => ({
        ...raw,
        productName: raw?.productName ?? existing[i]?.productName,
        productSpec: raw?.productSpec ?? existing[i]?.productSpec,
        elastic:     raw?.elastic     ?? existing[i]?.elastic,
        conversionCost: raw?.conversionCost ?? existing[i]?.conversionCost,
        marginPercent:  raw?.marginPercent  ?? existing[i]?.marginPercent,
        quantityMetres: raw?.quantityMetres ?? existing[i]?.quantityMetres,
        materials: Array.isArray(raw?.materials) ? raw.materials : existing[i]?.materials,
      }));

      const costing = costingFromBody({
        lines: merged,
        gstPercent: req.body.gstPercent ?? quote.gstPercent,
      });
      if (costing.error) return next(new ErrorHandler(costing.error, 400));
      Object.assign(quote, costingFields(costing));
    }

    for (const f of ['customerName', 'customerAddress', 'customerGstin',
                     'customerPhone', 'customerRef', 'remarks']) {
      if (req.body[f] !== undefined) quote[f] = String(req.body[f]).trim();
    }
    if (req.body.validTill !== undefined) {
      const d = new Date(req.body.validTill);
      if (!isNaN(d.getTime())) {
        if (d < quote.date) {
          return next(new ErrorHandler(
            'The valid-until date is before the quote date.', 400
          ));
        }
        quote.validTill = d;
      }
    }

    stamp(quote, ACTION_CODES.QUOTE_UPDATED, req, {
      auditReason, before, after: snapshotOf(quote),
    });
    await quote.save();

    res.json({ success: true, quote });
  })
);

// ─────────────────────────────────────────────────────────────
//  PATCH /status
// ─────────────────────────────────────────────────────────────
router.patch(
  '/status',
  gate,
  catchAsyncErrors(async (req, res, next) => {
    const { id, status } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid quote id is required', 400));
    }
    const allowed = ['draft', 'sent', 'accepted', 'declined', 'expired', 'cancelled'];
    if (!allowed.includes(status)) {
      return next(new ErrorHandler(`status must be one of: ${allowed.join(', ')}`, 400));
    }

    const quote = await Quote.findById(id);
    if (!quote) return next(new ErrorHandler('Quote not found', 404));

    const from = quote.status;
    quote.status = status;
    stamp(quote, ACTION_CODES.QUOTE_UPDATED, req, { change: 'status', from, to: status });
    await quote.save();

    res.json({ success: true, quote });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /list
// ─────────────────────────────────────────────────────────────
router.get(
  '/list',
  gate,
  catchAsyncErrors(async (req, res) => {
    const page  = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const filter = {};
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    if (req.query.search) {
      const rx = new RegExp(escapeRegex(String(req.query.search)), 'i');
      // The product name lives on the lines now, so searching the top
      // level found quotes by customer and never by what was quoted.
      filter.$or = [
        { quoteNo: rx },
        { customerName: rx },
        { 'lines.productName': rx },
      ];
    }

    const [quotes, total] = await Promise.all([
      Quote.find(filter).sort({ date: -1, sequence: -1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      Quote.countDocuments(filter),
    ]);

    res.json({ success: true, quotes, total, page });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /detail
// ─────────────────────────────────────────────────────────────
router.get(
  '/detail',
  gate,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid quote id is required', 400));
    }
    const quote = await Quote.findById(id).lean();
    if (!quote) return next(new ErrorHandler('Quote not found', 404));
    res.json({ success: true, quote });
  })
);

// ─────────────────────────────────────────────────────────────
//  POST /price — price a costing without saving anything.
//
//  So the form can show the server's figure before a quote number is
//  burnt. Without this the only way to see the authoritative price is
//  to create a document, and a sales desk trying three margins would
//  leave three quote numbers behind.
// ─────────────────────────────────────────────────────────────
router.post(
  '/price',
  gate,
  catchAsyncErrors(async (req, res, next) => {
    const costing = costingFromBody(req.body);
    if (costing.error) return next(new ErrorHandler(costing.error, 400));
    res.json({ success: true, costing: costingFields(costing) });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /win-loss — what your own quotes say about your pricing
//
//  Read-only, and deliberately nowhere near the write paths above. It
//  reports what happened to prices you already named; it does not
//  price anything, and no route consults it to decide a figure. That
//  separation is the whole safety property: a model that has seen forty
//  quotes has no business overriding somebody who has seen the customer.
//
//  ?days=      window, default all history
//  ?customerId / ?productName   narrow the picture
// ─────────────────────────────────────────────────────────────
router.get(
  '/win-loss',
  gate,
  catchAsyncErrors(async (req, res) => {
    const days = Number(req.query.days);
    const out = await winLoss.analyse({
      days: Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : undefined,
      customerId: mongoose.Types.ObjectId.isValid(req.query.customerId)
        ? req.query.customerId : undefined,
      productName: req.query.productName ? String(req.query.productName).slice(0, 120) : undefined,
    });
    res.json({ success: true, ...out });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /win-loss/for-quote — the same picture beside one live quote
// ─────────────────────────────────────────────────────────────
router.get(
  '/win-loss/for-quote',
  gate,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid quote id is required', 400));
    }
    const out = await winLoss.forQuote(id);
    if (!out) return next(new ErrorHandler('Quote not found', 404));
    res.json({ success: true, ...out });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /:id/pdf
// ─────────────────────────────────────────────────────────────
router.get(
  '/:id/pdf',
  gate,
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler('A valid quote id is required', 400));
    }
    const quote = await Quote.findById(id).lean();
    if (!quote) return next(new ErrorHandler('Quote not found', 404));

    const [saved, branding] = await Promise.all([
      PdfTemplate.findOne({ docType: 'quotation' }).lean(),
      getPdfBranding(),
    ]);
    const template = saved && saved.enabled ? saved : starterTemplate('quotation');
    const pdf = await renderTemplatePdf(template, quoteToContext(quote, branding));

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${String(quote.quoteNo).replace(/[^\w.-]/g, '_')}.pdf"`
    );
    res.send(pdf);
  })
);

module.exports = router;
