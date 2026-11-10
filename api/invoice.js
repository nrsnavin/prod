"use strict";
// ══════════════════════════════════════════════════════════════════
//  TAX INVOICES  —  /api/v2/invoice
//
//  An invoice is raised against an ORDER, for the delivery challans
//  that carried the goods out (dispatched or delivered, not yet on an
//  issued invoice). The lines are the challans' lines merged per
//  elastic, priced from the order (the agreed rate), classified from
//  the elastic (HSN / GST %, falling back to Settings → Invoice), and
//  split CGST+SGST or IGST from the seller's and buyer's state codes.
//
//    GET  /order-info?id=     what an invoice for this order would hold
//    POST /create             raise it (number drawn, status "issued")
//    GET  /list               paged, searchable
//    GET  /detail?id=         with e-invoice readiness
//    GET  /:id/pdf            the printed invoice (QR once registered)
//    GET  /:id/einvoice.json  the INV-01 JSON, for the portal / GSP
//    POST /:id/register-irn   through the connected GSP
//    POST /:id/irn            paste the IRN + signed QR from the portal
//    POST /:id/cancel         with a reason; frees the challans
//    GET  /by-order?id=       the order page's card
//    GET  /by-customer?id=    the customer page's card
//
//  Nothing on an issued invoice is edited: cancel and raise again.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const mongoose = require("mongoose");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { escapeRegex }  = require("../utils/escapeRegex");
const { renderPdf }    = require("../utils/renderPdf");
const { nextNumber }   = require("../utils/sequence");
const { financialYearLong } = require("../utils/financialYear");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { getDocumentSettings, getPdfBranding } = require("../services/documentSettings");
const { computeInvoice, amountInWords, stateCodeFromGstin } = require("../services/gst");
const { readDate, withTxn } = require("../services/accountsHelpers");
const { onceAtATime } = require("../utils/onceAtATime");
const { buildEinvoiceJson, readiness } = require("../services/einvoice");
const { getProvider } = require("../services/einvoiceProvider");
const partyLedger = require("../services/partyLedger");
const { assertOpen } = require("../services/booksLock");
const creditControl = require("../services/creditControl");
const exportSupply = require("../services/exportSupply");
const { getSettings: getBooksSettings } = require("../services/booksLock");

const Invoice         = require("../models/Invoice");
const Order           = require("../models/Order");
const DeliveryChallan = require("../models/DeliveryChallan");
const Customer        = require("../models/Customer");
const Elastic         = require("../models/Elastic");

const MIN_REASON = 8;
const IRN_RE = /^[0-9a-f]{64}$/i;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

// ── Snapshots ──────────────────────────────────────────────────
function sellerFrom(settings) {
  const s = settings || {};
  const inv = s.invoice || {};
  return {
    name:      s.companyName || "Balu Elastics",
    address:   (Array.isArray(s.addressLines) ? s.addressLines.filter(Boolean) : []).join(", "),
    city:      inv.city || "",
    pincode:   inv.pincode || "",
    stateCode: inv.stateCode || stateCodeFromGstin(s.gstin),
    gstin:     String(s.gstin || "").trim().toUpperCase(),
    phone:     s.phone || "",
    email:     s.email || "",
  };
}

function buyerFrom(customer) {
  const c = customer || {};
  return {
    name:      c.name || "",
    address:   c.address || "",
    city:      c.city || "",
    pincode:   c.pincode || "",
    stateCode: c.stateCode || stateCodeFromGstin(c.gstin),
    gstin:     String(c.gstin || "").trim().toUpperCase(),
    phone:     c.phoneNumber || "",
    email:     c.email || "",
  };
}

/** Where the goods went: the challans' consignee address, else the buyer's. */
function shipToFor(dcs, buyer) {
  const onChallan = (dcs || []).map((d) => String(d.customerAddress || "").trim()).find(Boolean);
  if (onChallan) return onChallan;
  return [buyer.address, [buyer.city, buyer.pincode].filter(Boolean).join(" - ")].filter(Boolean).join(", ");
}

/** The challans of this order that can go on an invoice: goods left, not yet invoiced. */
async function invoiceableDcs(order) {
  const match = [{ order: order._id }];
  if (order.orderNo != null) match.push({ orderNo: order.orderNo });
  const dcs = await DeliveryChallan.find({ $or: match, type: "elastic" })
    .select("dcNumber status dispatchDate items totalQuantity customerAddress")
    .sort({ dispatchDate: 1, createdAt: 1 })
    .lean();
  const onInvoices = await Invoice.find({ order: order._id, status: "issued" })
    .select("invoiceNumber dcs.dc")
    .lean();
  const invoiced = new Map();
  for (const inv of onInvoices) for (const d of inv.dcs || []) invoiced.set(String(d.dc), inv.invoiceNumber);
  return dcs.map((dc) => ({
    ...dc,
    invoicedOn: invoiced.get(String(dc._id)) || null,
    // Draft challans have not left; cancelled ones never did.
    eligible: (dc.status === "dispatched" || dc.status === "delivered") && !invoiced.has(String(dc._id)),
  }));
}

/**
 * The challans' lines merged per elastic, priced from the order.
 * `overrides` ({ [elasticId]: { rate, hsn, gstPercent } }) is what the
 * form changed before raising.
 */
async function buildLines(order, dcs, settings, overrides = {}) {
  const inv = settings.invoice || {};
  const orderRate = new Map((order.elasticOrdered || []).map((l) => [String(l.elastic?._id || l.elastic), Number(l.rate) || 0]));
  const byElastic = new Map();
  for (const dc of dcs) {
    for (const item of dc.items || []) {
      if (!item.elastic) continue;
      const key = String(item.elastic);
      const row = byElastic.get(key) || { elastic: item.elastic, name: item.elasticName || "", unit: item.unit || "m", quantity: 0, dcNumbers: [], dcRate: 0 };
      row.quantity = Math.round((row.quantity + (Number(item.quantity) || 0)) * 1000) / 1000;
      if (!row.dcNumbers.includes(dc.dcNumber)) row.dcNumbers.push(dc.dcNumber);
      if (!row.dcRate && Number(item.rate) > 0) row.dcRate = Number(item.rate);
      if (!row.name && item.elasticName) row.name = item.elasticName;
      byElastic.set(key, row);
    }
  }
  const ids = [...byElastic.keys()];
  const elastics = await Elastic.find({ _id: { $in: ids } }).select("name hsn gstPercent").lean();
  const cat = new Map(elastics.map((e) => [String(e._id), e]));
  return ids.map((key) => {
    const row = byElastic.get(key);
    const e = cat.get(key) || {};
    const o = overrides[key] || {};
    const rate = o.rate !== undefined && o.rate !== null && o.rate !== "" ? Number(o.rate) : (orderRate.get(key) || row.dcRate || 0);
    const gstPercent = o.gstPercent !== undefined && o.gstPercent !== null && o.gstPercent !== ""
      ? Number(o.gstPercent)
      : (e.gstPercent !== null && e.gstPercent !== undefined ? Number(e.gstPercent) : Number(inv.defaultGstPercent ?? 5));
    const hsn = o.hsn !== undefined && o.hsn !== null ? String(o.hsn).trim() : (e.hsn || inv.defaultHsn || "");
    return {
      elastic: row.elastic, name: e.name || row.name || "Elastic", unit: row.unit, quantity: row.quantity,
      rate, hsn, gstPercent, dcNumbers: row.dcNumbers,
      boxes: o.boxes !== undefined && o.boxes !== null && o.boxes !== "" ? Number(o.boxes) : 0,
      // Where the figure came from, for the form to say so.
      rateSource: o.rate !== undefined && o.rate !== "" ? "entered" : (orderRate.get(key) ? "order" : (row.dcRate ? "challan" : "none")),
    };
  });
}

function readOverrides(raw) {
  const out = {};
  if (!Array.isArray(raw)) return out;
  raw.forEach((l, i) => {
    if (!l || !isId(l.elastic)) throw new ErrorHandler(`Line ${i + 1}: elastic id is missing`, 400);
    const o = {};
    for (const k of ["rate", "gstPercent", "boxes"]) {
      if (l[k] === undefined || l[k] === null || l[k] === "") continue;
      const n = Number(l[k]);
      if (!Number.isFinite(n) || n < 0) throw new ErrorHandler(`Line ${i + 1}: ${k} must be a number of 0 or more`, 400);
      if (k === "boxes" && !Number.isInteger(n)) throw new ErrorHandler(`Line ${i + 1}: boxes must be a whole number`, 400);
      o[k] = n;
    }
    if (l.hsn !== undefined && l.hsn !== null) {
      const h = String(l.hsn).trim();
      if (h && !/^\d{4,8}$/.test(h)) throw new ErrorHandler(`Line ${i + 1}: HSN must be 4 to 8 digits`, 400);
      o.hsn = h;
    }
    out[String(l.elastic)] = o;
  });
  return out;
}

const populateOrder = (q) => q
  .populate("customer", "name email gstin contactName phoneNumber address city pincode stateCode country sez currency")
  .populate("elasticOrdered.elastic", "name hsn gstPercent");

function nextInvoiceSeq(fy) {
  return nextNumber(`invoice:${fy}`, async () => {
    const last = await Invoice.findOne({ financialYear: fy }).sort({ sequence: -1 }).select("sequence").lean();
    return last?.sequence ?? 0;
  });
}
const invoiceNumber = (fy, seq) => `INV/${fy}/${String(seq).padStart(4, "0")}`;

function publicInvoice(inv) {
  const o = inv.toObject ? inv.toObject() : { ...inv };
  o.einvoice = o.einvoice || {};
  o.einvoiceProblems = readiness(o);
  return o;
}

// ── GET /order-info ────────────────────────────────────────────
router.get(
  "/order-info",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.query.id)) return next(new ErrorHandler("Order not found", 404));
    const order = await populateOrder(Order.findById(req.query.id).select("orderNo po customer status elasticOrdered")).lean();
    if (!order) return next(new ErrorHandler("Order not found", 404));
    const settings = await getDocumentSettings();
    const dcs = await invoiceableDcs(order);
    const eligible = dcs.filter((d) => d.eligible);
    const lines = await buildLines(order, eligible, settings);
    const seller = sellerFrom(settings);
    const buyer = buyerFrom(order.customer);
    const priced = computeInvoice(lines, { sellerStateCode: seller.stateCode, buyerStateCode: buyer.stateCode });
    const preview = { seller, buyer, lines: priced.lines, status: "issued" };
    const books = await getBooksSettings();
    res.json({
      // Export / SEZ: what the customer's file suggests, the kinds, and the LUT on file.
      export: {
        suggested: exportSupply.suggestFor(order.customer), kinds: exportSupply.options(),
        lut: { number: books.lut?.number || "", validFrom: books.lut?.validFrom || null, validTo: books.lut?.validTo || null },
        currency: order.customer?.currency || "", country: order.customer?.country || "", sez: !!order.customer?.sez,
      },
      success: true,
      order: { _id: order._id, orderNo: order.orderNo, po: order.po, status: order.status, customer: order.customer?._id },
      seller, buyer,
      shipTo: shipToFor(eligible, buyer),
      supplyType: priced.supplyType,
      placeOfSupply: priced.placeOfSupply,
      dcs: dcs.map((d) => ({
        _id: d._id, dcNumber: d.dcNumber, status: d.status, dispatchDate: d.dispatchDate, totalQuantity: d.totalQuantity,
        invoicedOn: d.invoicedOn, eligible: d.eligible,
        items: (d.items || []).map((i) => ({ elastic: i.elastic, elasticName: i.elasticName, quantity: i.quantity, unit: i.unit })),
      })),
      lines,
      defaults: { hsn: settings.invoice?.defaultHsn || "", gstPercent: settings.invoice?.defaultGstPercent ?? 5 },
      // What the portal would refuse, so the form can say it before raising.
      problems: readiness(preview).filter((p) => !/no lines|no rate/i.test(p)),
    });
  })
);

// ── POST /create ───────────────────────────────────────────────
router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId, dcIds, invoiceDate, notes, requestId } = req.body || {};
    if (!isId(orderId)) return next(new ErrorHandler("orderId is required", 400));
    if (!Array.isArray(dcIds) || !dcIds.length) return next(new ErrorHandler("Pick at least one delivery challan", 400));
    if (dcIds.some((id) => !isId(id))) return next(new ErrorHandler("A challan id is not valid", 400));
    let overrides;
    try { overrides = readOverrides(req.body.lines); } catch (err) { return next(err); }
    // The day in India, kept as that day's UTC midnight: an invoice raised
    // at 1 am on the 1st belongs to the 1st in the GST return and in Tally.
    let when;
    try { when = readDate(invoiceDate, "invoiceDate", new Date()); } catch (err) { return next(err); }
    try { await assertOpen(when, req); } catch (err) { return next(err); }

    // One invoice at a time for an order. Which challans are still to be
    // invoiced is worked out and then the invoice is created: two requests
    // together both found the same challan free and both invoiced it. The
    // second now waits for the first, and is then told the challan is
    // taken — or, for a resend, handed the invoice that was just raised.
    await onceAtATime(`invoice:order:${orderId}`, async () => {
      if (requestId) {
        const dup = await Invoice.findOne({ requestId: String(requestId) });
        if (dup) return res.status(200).json({ success: true, invoice: publicInvoice(dup), replay: true });
      }

      const order = await populateOrder(Order.findById(orderId).select("orderNo po customer status elasticOrdered")).lean();
      if (!order) return next(new ErrorHandler("Order not found", 404));
      if (!order.customer) return next(new ErrorHandler("The order has no customer", 409));
      let creditOverride = null;
      try { creditOverride = await creditControl.enforce(order.customer._id || order.customer, req, "this invoice"); } catch (err) { return next(err); }

      const all = await invoiceableDcs(order);
      const wanted = new Set(dcIds.map(String));
      const chosen = all.filter((d) => wanted.has(String(d._id)));
      if (chosen.length !== wanted.size) return next(new ErrorHandler("A chosen challan does not belong to this order", 400));
      const bad = chosen.find((d) => !d.eligible);
      if (bad) {
        return next(new ErrorHandler(
          bad.invoicedOn
            ? `${bad.dcNumber} is already on invoice ${bad.invoicedOn}`
            : `${bad.dcNumber} is ${bad.status} — only despatched or delivered challans can be invoiced`,
          409
        ));
      }

      const settings = await getDocumentSettings();
      const seller = sellerFrom(settings);
      const buyer = buyerFrom(order.customer);
      const lines = await buildLines(order, chosen, settings, overrides);
      if (!lines.length) return next(new ErrorHandler("Those challans carry no elastic lines", 409));
      const unpriced = lines.filter((l) => !(l.rate > 0));
      if (unpriced.length) {
        return next(new ErrorHandler(
          `No rate for ${unpriced.map((l) => l.name).join(", ")} — price the order line, or enter a rate on the invoice.`, 409));
      }
      // An export, SEZ or deemed-export supply: zero-rated under LUT, or IGST.
      let exp;
      try { exp = exportSupply.read(req.body.export, { lut: (await getBooksSettings()).lut, invoiceDate: when, customer: order.customer }); } catch (err) { return next(err); }
      const priced = computeInvoice(lines, { sellerStateCode: seller.stateCode, buyerStateCode: buyer.stateCode, ...exportSupply.pricing(exp) });

      const fy = financialYearLong(when);
      const sequence = await nextInvoiceSeq(fy);
      const number = invoiceNumber(fy, sequence);

      const actor = actorFromRequest(req);
      const _id = new mongoose.Types.ObjectId();
      const data = {
        _id,
        invoiceNumber: number, requestId: requestId ? String(requestId) : undefined, financialYear: fy, sequence,
        invoiceDate: when,
        ...(creditOverride ? { creditOverride } : {}),
        order: order._id, orderNo: order.orderNo, customer: order.customer._id, customerPo: order.po || "",
        // The customer's payment terms ("30" days) decide when it falls due.
        dueDate: new Date(when.getTime() + (Math.max(0, parseInt(order.customer.paymentTerms, 10) || 0)) * 86_400_000),
        seller, buyer,
        shipTo: String(req.body.shipTo ?? "").trim().slice(0, 300) || shipToFor(chosen, buyer),
        supplyType: priced.supplyType, placeOfSupply: priced.placeOfSupply,
        ...(exp ? { export: exp } : {}),
        dcs: chosen.map((d) => ({ dc: d._id, dcNumber: d.dcNumber, dispatchDate: d.dispatchDate })),
        lines: priced.lines.map((l) => ({
          elastic: l.elastic, name: l.name, hsn: l.hsn, unit: l.unit, quantity: l.quantity, boxes: l.boxes || 0, rate: l.rate,
          taxable: l.taxable, gstPercent: l.gstPercent, cgst: l.cgst, sgst: l.sgst, igst: l.igst, amount: l.amount, dcNumbers: l.dcNumbers,
        })),
        totalBoxes: priced.lines.reduce((a, l) => a + (l.boxes || 0), 0),
        totals: priced.totals,
        amountInWords: amountInWords(priced.totals.grand),
        notes: String(notes || "").trim().slice(0, 500),
        createdBy: req.user?._id,
        fingerprints: [buildFingerprint(ACTION_CODES.INVOICE_CREATED, {
          entityId: _id, actor,
          meta: { invoiceNumber: number, orderNo: order.orderNo, dcs: chosen.map((d) => d.dcNumber), grand: priced.totals.grand, ...(exp ? { export: exp.kind } : {}) },
        })],
      };
      // The invoice and its row on the customer's account, together: it
      // is on the account from the day it is issued, or it was not issued.
      // (They were two writes; one failing between them left an invoice
      // the customer's balance did not know about, and a resend handed
      // back the invoice without ever posting the row.)
      let doc;
      try {
        await withTxn(async (session) => {
          [doc] = await Invoice.create([data], { session });
          await partyLedger.post({
            partyType: "customer", party: data.customer, date: data.invoiceDate, docType: "Invoice", doc: _id,
            docNo: number, debit: priced.totals.grand, narration: `Sales — order #${order.orderNo}`,
          }, session);
        });
      } catch (err) {
        // A retry that lost the race above: hand back the one that won.
        if (err?.code === 11000 && requestId) {
          const dup = await Invoice.findOne({ requestId: String(requestId) });
          if (dup) return res.status(200).json({ success: true, invoice: publicInvoice(dup), replay: true });
        }
        throw err;
      }
      res.status(201).json({ success: true, invoice: publicInvoice(doc) });
    }, { what: "An invoice for this order" });
  })
);

// ── GET /list ──────────────────────────────────────────────────
router.get(
  "/list",
  catchAsyncErrors(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const q = {};
    if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
    if (req.query.einvoice && req.query.einvoice !== "all") q["einvoice.status"] = String(req.query.einvoice);
    if (isId(req.query.customer)) q.customer = req.query.customer;
    if (isId(req.query.order)) q.order = req.query.order;
    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(escapeRegex(search), "i");
      q.$or = [{ invoiceNumber: re }, { "buyer.name": re }, { "buyer.gstin": re }, { "einvoice.irn": re }, { "dcs.dcNumber": re }];
      if (/^\d+$/.test(search)) q.$or.push({ orderNo: Number(search) });
    }
    const [total, invoices] = await Promise.all([
      Invoice.countDocuments(q),
      Invoice.find(q)
        // Payment fields too, so the list can say paid, part paid or
        // overdue as services/outstanding.js reckons it.
        .select("invoiceNumber invoiceDate dueDate orderNo order customer buyer.name buyer.gstin supplyType totals status einvoice.status einvoice.irn dcs createdAt paidAmount creditedAmount debitedAmount")
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ]);
    res.json({ success: true, invoices, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  })
);

// ── GET /detail ────────────────────────────────────────────────
router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.query.id)) return next(new ErrorHandler("Invoice not found", 404));
    const inv = await Invoice.findById(req.query.id).populate("customer", "name").lean();
    if (!inv) return next(new ErrorHandler("Invoice not found", 404));
    res.json({ success: true, invoice: publicInvoice(inv) });
  })
);

async function loadInvoice(id, next) {
  if (!isId(id)) { next(new ErrorHandler("Invoice not found", 404)); return null; }
  const inv = await Invoice.findById(id);
  if (!inv) { next(new ErrorHandler("Invoice not found", 404)); return null; }
  return inv;
}

// ── GET /:id/pdf ───────────────────────────────────────────────
router.get(
  "/:id/pdf",
  catchAsyncErrors(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    const [branding, settings] = await Promise.all([getPdfBranding(), getDocumentSettings()]);
    const pdf = await renderPdf("invoice", { invoice: inv, branding, settings: { invoice: settings.invoice || {} } });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${inv.invoiceNumber.replace(/\//g, "-")}.pdf"`);
    res.send(pdf);
  })
);

// ── GET /:id/einvoice.json ─────────────────────────────────────
router.get(
  "/:id/einvoice.json",
  catchAsyncErrors(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    const json = buildEinvoiceJson(inv.toObject());
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${inv.invoiceNumber.replace(/\//g, "-")}-einvoice.json"`);
    res.send(JSON.stringify(json, null, 2));
  })
);

function notReady(problems) {
  const err = new ErrorHandler(`The e-invoice cannot be registered yet: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`, 409);
  err.code = "EINVOICE_NOT_READY";
  err.details = { problems };
  return err;
}

function stampRegistration(inv, reg, provider, req) {
  inv.einvoice.status = "registered";
  inv.einvoice.irn = reg.irn;
  inv.einvoice.ackNo = reg.ackNo || "";
  inv.einvoice.ackDate = reg.ackDate || new Date();
  inv.einvoice.signedQr = reg.signedQr || "";
  inv.einvoice.provider = provider;
  inv.einvoice.registeredAt = new Date();
  inv.einvoice.registeredBy = req.user?._id;
  inv.fingerprints.push(buildFingerprint(ACTION_CODES.INVOICE_IRN_REGISTERED, {
    entityId: inv._id, actor: actorFromRequest(req),
    meta: { invoiceNumber: inv.invoiceNumber, irn: reg.irn, ackNo: reg.ackNo || "", provider },
  }));
}

// ── One step at a time with the tax portal ─────────────────────
// Registering an IRN, cancelling, an e-way bill: each read the invoice,
// called out to the provider — which takes seconds — and then wrote what
// came back. Nothing held the invoice in between. A second click read
// "not registered" as well and registered the invoice at the portal
// again; a cancel landing in the gap cancelled an invoice whose IRN then
// arrived, live, on a cancelled document.
//
// The lease is per invoice (utils/onceAtATime.js), so the second request
// runs after the first and is answered by what the first one did:
// "Already registered — IRN …", or a cancellation that takes the IRN
// with it. Held a little longer than the provider is given to answer.
const PORTAL_LEASE_MS = 75_000;
const portalStep = (handler) => catchAsyncErrors((req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return handler(req, res, next);
  return onceAtATime(`invoice-portal:${req.params.id}`, () => handler(req, res, next), {
    what: "This invoice's registration",
    ttlMs: PORTAL_LEASE_MS,
  });
});

// ── POST /:id/register-irn ─────────────────────────────────────
router.post(
  "/:id/register-irn",
  portalStep(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    if (inv.status === "cancelled") return next(new ErrorHandler("A cancelled invoice cannot be registered", 409));
    if (inv.einvoice.status === "registered") return next(new ErrorHandler(`Already registered — IRN ${inv.einvoice.irn}`, 409));
    const problems = readiness(inv.toObject());
    if (problems.length) return next(notReady(problems));
    let provider;
    try { provider = await getProvider(); } catch (err) { return next(err); }
    let reg;
    try {
      reg = await provider.register(buildEinvoiceJson(inv.toObject()), { invoice: inv });
    } catch (err) {
      if (err instanceof ErrorHandler) return next(err);
      const e = new ErrorHandler(`The e-invoice provider could not be reached: ${err.message}`, 502);
      e.code = "EINVOICE_UNREACHABLE";
      return next(e);
    }
    stampRegistration(inv, reg, provider.name, req);
    await inv.save();
    res.json({ success: true, invoice: publicInvoice(inv) });
  })
);

// ── Export details that come later: the shipping bill, the port ──
// Customs issue the shipping bill after the invoice; it changes no
// value, so it is the one thing an issued invoice takes afterwards.
router.post(
  "/:id/export",
  catchAsyncErrors(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    if (inv.supplyType !== "export") return next(new ErrorHandler("Only an export invoice carries a shipping bill", 409));
    const b = req.body || {};
    const number = String(b.shippingBill?.number ?? b.shippingBillNo ?? "").trim().slice(0, 20);
    if (!number) return next(new ErrorHandler("shippingBill.number is required", 400));
    let date;
    try { date = readDate(b.shippingBill?.date ?? b.shippingBillDate, "shippingBill.date", inv.invoiceDate); } catch (err) { return next(err); }
    inv.export.shippingBill = { number, date };
    if (b.portCode !== undefined) inv.export.portCode = String(b.portCode || "").trim().toUpperCase().slice(0, 10);
    inv.fingerprints.push(buildFingerprint(ACTION_CODES.INVOICE_EXPORT, { entityId: inv._id, actor: actorFromRequest(req), meta: { invoiceNumber: inv.invoiceNumber, shippingBill: number, portCode: inv.export.portCode } }));
    await inv.save();
    res.json({ success: true, invoice: publicInvoice(inv) });
  })
);

// ── E-way bill (CGST Rule 138) ─────────────────────────────────
const ewaybill = require("../services/ewaybill");

// Generate from the IRN through the connected provider.
router.post(
  "/:id/ewaybill",
  portalStep(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    if (inv.status === "cancelled") return next(new ErrorHandler("A cancelled invoice moves no goods", 409));
    let d;
    try { d = await ewaybill.generate(inv, req.body || {}); } catch (err) {
      if (err instanceof ErrorHandler) return next(err);
      const e = new ErrorHandler(`The e-way bill provider could not be reached: ${err.message}`, 502);
      e.code = "EWB_UNREACHABLE";
      return next(e);
    }
    inv.fingerprints.push(buildFingerprint(ACTION_CODES.INVOICE_EWB, { entityId: inv._id, actor: actorFromRequest(req), meta: { invoiceNumber: inv.invoiceNumber, ewb: inv.ewaybill.number, vehicleNo: d.vehicleNo, provider: inv.ewaybill.provider } }));
    await inv.save();
    res.json({ success: true, invoice: publicInvoice(inv) });
  })
);

// The number from the portal, pasted in.
router.post(
  "/:id/ewaybill/paste",
  catchAsyncErrors(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    if (inv.status === "cancelled") return next(new ErrorHandler("A cancelled invoice moves no goods", 409));
    let d;
    try { d = ewaybill.paste(inv, req.body || {}); } catch (err) { return next(err); }
    inv.fingerprints.push(buildFingerprint(ACTION_CODES.INVOICE_EWB, { entityId: inv._id, actor: actorFromRequest(req), meta: { invoiceNumber: inv.invoiceNumber, ewb: inv.ewaybill.number, vehicleNo: d.vehicleNo, provider: "manual" } }));
    await inv.save();
    res.json({ success: true, invoice: publicInvoice(inv) });
  })
);

// What the portal needs, to key in or for a provider's bulk upload.
router.get(
  "/:id/ewaybill.json",
  catchAsyncErrors(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    const d = { vehicleNo: req.query.vehicleNo || inv.ewaybill?.vehicleNo || "", transporterId: req.query.transporterId || inv.ewaybill?.transporterId || "", transporterName: inv.ewaybill?.transporterName || "", distanceKm: Number(req.query.distanceKm) || inv.ewaybill?.distanceKm || 0, mode: inv.ewaybill?.mode || "road", transDocNo: inv.ewaybill?.transDocNo || "" };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="EWB_${inv.invoiceNumber.replace(/[\/\\]/g, "-")}.json"`);
    res.send(JSON.stringify({ byIrn: ewaybill.payload(inv.toObject(), d), needed: ewaybill.needed(inv.toObject()), value: ewaybill.valueOf(inv.toObject()), limit: ewaybill.LIMIT }, null, 2));
  })
);

// ── POST /:id/irn  (pasted from the portal) ────────────────────
router.post(
  "/:id/irn",
  portalStep(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    if (inv.status === "cancelled") return next(new ErrorHandler("A cancelled invoice cannot be registered", 409));
    if (inv.einvoice.status === "registered") return next(new ErrorHandler(`Already registered — IRN ${inv.einvoice.irn}`, 409));
    const irn = String(req.body?.irn || "").trim().toLowerCase();
    if (!IRN_RE.test(irn)) return next(new ErrorHandler("The IRN is 64 hexadecimal characters, as printed on the portal's acknowledgement", 400));
    let ackDate = new Date();
    if (req.body?.ackDate) {
      ackDate = new Date(req.body.ackDate);
      if (Number.isNaN(ackDate.getTime())) return next(new ErrorHandler("ackDate is not a date", 400));
    }
    const clash = await Invoice.findOne({ "einvoice.irn": irn, _id: { $ne: inv._id } }).select("invoiceNumber").lean();
    if (clash) return next(new ErrorHandler(`That IRN is already on invoice ${clash.invoiceNumber}`, 409));
    stampRegistration(inv, {
      irn, ackNo: String(req.body?.ackNo || "").trim().slice(0, 40), ackDate,
      signedQr: String(req.body?.signedQr || "").trim().slice(0, 4000),
    }, "manual", req);
    await inv.save();
    res.json({ success: true, invoice: publicInvoice(inv) });
  })
);

// ── POST /:id/cancel ───────────────────────────────────────────
router.post(
  "/:id/cancel",
  portalStep(async (req, res, next) => {
    const inv = await loadInvoice(req.params.id, next);
    if (!inv) return;
    if (inv.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
    // Money has been received or credited against it: that has to be
    // undone first, or the receipt would settle an invoice that no
    // longer exists.
    if ((inv.paidAmount || 0) > 0 || (inv.creditedAmount || 0) > 0 || (inv.debitedAmount || 0) > 0) {
      return next(new ErrorHandler(
        "Receipts or credit / debit notes are allocated to this invoice — cancel those first.", 409));
    }
    try { await assertOpen(inv.invoiceDate, req, { cancelling: true }); } catch (err) { return next(err); }
    const reason = String(req.body?.reason || req.body?.auditReason || "").trim();
    if (reason.length < MIN_REASON) {
      return next(new ErrorHandler(`Give a reason for cancelling (at least ${MIN_REASON} characters)`, 400));
    }
    // A registered IRN is cancelled at the portal too, through the same
    // provider that registered it; one pasted in is cancelled there by
    // hand, and the invoice says so.
    let portalNote = "";
    if (inv.einvoice.status === "registered") {
      if (inv.einvoice.provider && inv.einvoice.provider !== "manual") {
        let provider;
        try { provider = await getProvider(); } catch (err) { return next(err); }
        try {
          await provider.cancel(inv.einvoice.irn, { reason, invoice: inv });
        } catch (err) {
          if (err instanceof ErrorHandler) return next(err);
          const e = new ErrorHandler(`The e-invoice provider could not be reached: ${err.message}`, 502);
          e.code = "EINVOICE_UNREACHABLE";
          return next(e);
        }
      } else {
        portalNote = "The IRN was pasted in, so cancel it on the e-invoice portal as well (within 24 hours of registration).";
      }
    }
    const einvoiceSet = inv.einvoice.status === "registered" ? { "einvoice.status": "cancelled", "einvoice.cancelledAt": new Date() } : {};
    const mark = buildFingerprint(ACTION_CODES.INVOICE_CANCELLED, {
      entityId: inv._id, actor: actorFromRequest(req),
      meta: { invoiceNumber: inv.invoiceNumber, reason, irn: inv.einvoice.irn || "" },
    });
    // One conditional write, so a receipt landing between the check
    // above and here cannot settle a cancelled invoice: the write is
    // refused once anything is set against it. (No transaction: the
    // ledger row is dropped after, idempotently; a voucher's own write
    // is refused by the status once this lands.)
    const none = (field) => ({ $or: [{ [field]: { $lte: 0 } }, { [field]: null }] });
    const r = await Invoice.updateOne(
      { _id: inv._id, status: { $ne: "cancelled" }, $and: [none("paidAmount"), none("creditedAmount"), none("debitedAmount")] },
      { $set: { status: "cancelled", cancel: { reason, at: new Date(), by: req.user?._id }, ...einvoiceSet }, $push: { fingerprints: mark } }
    );
    if (r.matchedCount === 0) return next(new ErrorHandler("A receipt or note was set against this invoice meanwhile — cancel that first.", 409));
    await partyLedger.reverse("Invoice", inv._id);
    res.json({ success: true, invoice: publicInvoice(await Invoice.findById(inv._id)), portalNote });
  })
);

// ── GET /by-order ──────────────────────────────────────────────
const SUMMARY = "invoiceNumber invoiceDate orderNo status totals supplyType einvoice.status einvoice.irn dcs lines.name lines.quantity lines.unit buyer.name createdAt";

router.get(
  "/by-order",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.query.id)) return next(new ErrorHandler("Order not found", 404));
    const order = await Order.findById(req.query.id).select("orderNo").lean();
    if (!order) return next(new ErrorHandler("Order not found", 404));
    const invoices = await Invoice.find({ order: order._id }).select(SUMMARY).sort({ createdAt: -1 }).lean();
    const dcs = await invoiceableDcs(order);
    const live = invoices.filter((i) => i.status === "issued");
    res.json({
      success: true,
      invoices,
      totals: {
        count: invoices.length,
        cancelled: invoices.length - live.length,
        invoiced: Math.round(live.reduce((a, i) => a + (i.totals?.grand || 0), 0) * 100) / 100,
        registered: live.filter((i) => i.einvoice?.status === "registered").length,
      },
      // Challans that have left and are not yet on an invoice: the
      // reason the "Raise invoice" button is or is not offered.
      uninvoicedDcs: dcs.filter((d) => d.eligible).map((d) => ({ _id: d._id, dcNumber: d.dcNumber, totalQuantity: d.totalQuantity })),
    });
  })
);

// ── GET /by-customer ───────────────────────────────────────────
router.get(
  "/by-customer",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.query.id)) return next(new ErrorHandler("Customer not found", 404));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const [invoices, total, live] = await Promise.all([
      Invoice.find({ customer: req.query.id }).select(SUMMARY).sort({ createdAt: -1 }).limit(limit).lean(),
      Invoice.countDocuments({ customer: req.query.id }),
      Invoice.aggregate([
        { $match: { customer: new mongoose.Types.ObjectId(String(req.query.id)), status: "issued" } },
        { $group: { _id: null, amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } },
      ]),
    ]);
    res.json({ success: true, invoices, total, invoiced: { amount: live[0]?.amount || 0, count: live[0]?.count || 0 } });
  })
);

module.exports = router;
module.exports.sellerFrom = sellerFrom;
module.exports.buyerFrom = buyerFrom;
