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

const Quote = require('../models/Quote');
const { priceOneMetre, extend } = require('../utils/quoteCosting');
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
 * Read the costing off a request body and price it.
 *
 * Returns { error } for anything that cannot be priced, so the caller
 * answers with one clear refusal rather than storing a nonsense quote.
 */
function costingFromBody(body) {
  const raw = Array.isArray(body?.materials) ? body.materials : [];

  // An unlabelled row cannot be printed or understood later. Rows with
  // no weight AND no rate are dropped rather than refused — the form
  // ships with four named rows and leaving one unused is normal.
  const materials = [];
  for (const [i, m] of raw.entries()) {
    const label  = String(m?.label ?? '').trim();
    const weight = Number(m?.weightGrams);
    const rate   = Number(m?.ratePerKg);

    const blank = !weight && !rate;
    if (blank) continue;

    if (!label) {
      return { error: `Line ${i + 1} has figures but no material name.` };
    }
    if (weight < 0 || rate < 0) {
      return { error: `Line ${i + 1}: weight and rate cannot be negative.` };
    }
    if (!Number.isFinite(weight) || !Number.isFinite(rate)) {
      return { error: `Line ${i + 1}: weight and rate must be numbers.` };
    }
    materials.push({ label, weightGrams: weight, ratePerKg: rate });
  }

  if (materials.length === 0) {
    return { error: 'A quote needs at least one material with a weight and a rate.' };
  }

  const marginPercent = Number(body?.marginPercent);
  if (!Number.isFinite(marginPercent) || marginPercent < 0) {
    return { error: 'Margin % must be zero or more.' };
  }

  const gstPercent = body?.gstPercent === undefined || body?.gstPercent === null
    ? 5
    : Number(body.gstPercent);
  if (!Number.isFinite(gstPercent) || gstPercent < 0) {
    return { error: 'GST % must be zero or more.' };
  }

  const conversionCost = Number(body?.conversionCost) || 0;
  if (conversionCost < 0) {
    return { error: 'Conversion cost cannot be negative.' };
  }

  const priced = priceOneMetre({ materials, conversionCost, marginPercent, gstPercent });

  const quantityMetres = Math.max(0, Number(body?.quantityMetres) || 0);
  return {
    priced,
    quantityMetres,
    valueBeforeTax: extend(priced.rateBeforeTax, quantityMetres),
    valueInclTax:   extend(priced.rateInclTax,   quantityMetres),
  };
}

/** Everything the costing decides, ready to assign onto a document. */
const costingFields = (c) => ({
  materials:        c.priced.materials,
  totalWeightGrams: c.priced.totalWeightGrams,
  materialCost:     c.priced.materialCost,
  conversionCost:   c.priced.conversionCost,
  totalCost:        c.priced.totalCost,
  marginPercent:    c.priced.marginPercent,
  marginAmount:     c.priced.marginAmount,
  rateBeforeTax:    c.priced.rateBeforeTax,
  gstPercent:       c.priced.gstPercent,
  gstAmount:        c.priced.gstAmount,
  rateInclTax:      c.priced.rateInclTax,
  quantityMetres:   c.quantityMetres,
  valueBeforeTax:   c.valueBeforeTax,
  valueInclTax:     c.valueInclTax,
});

// buildFingerprint takes { entityId, actor, meta } — the actor goes in
// under its own key. Spreading actorFromRequest() across the options
// instead put id/name/role at the top level where nothing reads them,
// so `actor` arrived undefined and every quotation recorded "System" as
// the person who raised it. An audit trail that cannot name anybody is
// a log, not an audit.
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
      customerName, customerAddress, customerGstin, customerRef, customer,
      productName, productSpec, elastic,
      date, validTill, remarks,
    } = req.body || {};

    if (!String(customerName ?? '').trim()) {
      return next(new ErrorHandler('Customer name is required', 400));
    }
    if (!String(productName ?? '').trim()) {
      return next(new ErrorHandler('Product name is required', 400));
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
      customer: mongoose.Types.ObjectId.isValid(customer) ? customer : undefined,
      customerName:    String(customerName).trim(),
      customerAddress: String(customerAddress ?? '').trim(),
      customerGstin:   String(customerGstin ?? '').trim(),
      customerRef:     String(customerRef ?? '').trim(),
      elastic: mongoose.Types.ObjectId.isValid(elastic) ? elastic : undefined,
      productName: String(productName).trim(),
      productSpec: String(productSpec ?? '').trim(),
      remarks:     String(remarks ?? '').trim(),
      createdBy:   req.user?._id,
      ...costingFields(costing),
    });

    stamp(quote, ACTION_CODES.QUOTE_CREATED, req, {
      quoteNo, rate: quote.rateBeforeTax, customer: quote.customerName,
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

    const before = {
      rateBeforeTax: quote.rateBeforeTax,
      totalCost:     quote.totalCost,
      marginPercent: quote.marginPercent,
    };

    if (Array.isArray(req.body.materials)) {
      const costing = costingFromBody(req.body);
      if (costing.error) return next(new ErrorHandler(costing.error, 400));
      Object.assign(quote, costingFields(costing));
    }

    for (const f of ['customerName', 'customerAddress', 'customerGstin',
                     'customerRef', 'productName', 'productSpec', 'remarks']) {
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
      auditReason, before,
      after: {
        rateBeforeTax: quote.rateBeforeTax,
        totalCost:     quote.totalCost,
        marginPercent: quote.marginPercent,
      },
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
      filter.$or = [{ quoteNo: rx }, { customerName: rx }, { productName: rx }];
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
