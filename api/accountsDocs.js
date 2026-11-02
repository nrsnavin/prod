"use strict";
// ══════════════════════════════════════════════════════════════════
//  DOCUMENTS THE OTHER SIDE RECEIVES  (inside /api/v2/accounts)
//
//    GET  /notes/:id/pdf               credit / debit note, as a GST document
//    GET  /notes/:id/einvoice.json     the portal's JSON (CRN / DBN) for a
//                                      note to a customer
//    POST /notes/:id/register-irn      through the connected GSP
//    POST /notes/:id/irn               an IRN pasted from the portal
//    GET  /payments/:id/pdf            receipt / payment advice
//    GET  /statement/pdf               a party's statement of account
//    POST /share/draft                 the WhatsApp message that goes with
//                                      one of these, to edit and send
//                                      through /collections/send
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { renderPdf } = require("../utils/renderPdf");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { getDocumentSettings, getPdfBranding } = require("../services/documentSettings");
const { buildEinvoiceJson, readiness } = require("../services/einvoice");
const { getProvider } = require("../services/einvoiceProvider");
const { asInvoice } = require("../services/noteDocument");
const partyLedger = require("../services/partyLedger");
const outstanding = require("../services/outstanding");
const { e164 } = require("../services/collections");
const { isId, readDate, DAY } = require("../services/accountsHelpers");

const AccountNote = require("../models/AccountNote");
const Payment = require("../models/Payment");
const Customer = require("../models/Customer");
const Supplier = require("../models/Supplier");

const IRN_RE = /^[0-9a-f]{64}$/i;
const fileName = (s) => String(s || "document").replace(/[\/\\]/g, "-").replace(/"/g, "");
const money = (n) => (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d) => new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

async function loadNote(req, next) {
  if (!isId(req.params.id)) { next(new ErrorHandler("Note not found", 404)); return null; }
  const note = await AccountNote.findById(req.params.id).select("-attachments.data");
  if (!note) { next(new ErrorHandler("Note not found", 404)); return null; }
  return note;
}

const pdf = (res, name, buf) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName(name)}.pdf"`);
  res.send(buf);
};

// ── Notes ──────────────────────────────────────────────────────────
router.get("/notes/:id/pdf", catchAsyncErrors(async (req, res, next) => {
  const note = await loadNote(req, next);
  if (!note) return;
  const [branding, settings] = await Promise.all([getPdfBranding(), getDocumentSettings()]);
  const buf = await renderPdf("invoice", { invoice: await asInvoice(note.toObject()), branding, settings: { invoice: settings.invoice || {} } });
  pdf(res, note.noteNo, buf);
}));

function customerOnly(note, next) {
  if (note.partyType !== "customer") { next(new ErrorHandler("A note to a supplier is not an e-invoice — the supplier's own credit note goes on their return", 409)); return false; }
  return true;
}

router.get("/notes/:id/einvoice.json", catchAsyncErrors(async (req, res, next) => {
  const note = await loadNote(req, next);
  if (!note || !customerOnly(note, next)) return;
  const json = buildEinvoiceJson(await asInvoice(note.toObject()));
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName(note.noteNo)}-einvoice.json"`);
  res.send(JSON.stringify(json, null, 2));
}));

function stamp(note, reg, provider, req) {
  note.einvoice = {
    status: "registered", irn: reg.irn, ackNo: reg.ackNo || "", ackDate: reg.ackDate || new Date(), signedQr: reg.signedQr || "",
    provider, registeredAt: new Date(), registeredBy: req.user?._id,
  };
  note.fingerprints.push(buildFingerprint(ACTION_CODES.NOTE_IRN_REGISTERED, { entityId: note._id, actor: actorFromRequest(req), meta: { noteNo: note.noteNo, irn: reg.irn, provider } }));
}

router.post("/notes/:id/register-irn", catchAsyncErrors(async (req, res, next) => {
  const note = await loadNote(req, next);
  if (!note || !customerOnly(note, next)) return;
  if (note.status === "cancelled") return next(new ErrorHandler("A cancelled note cannot be registered", 409));
  if (note.einvoice?.status === "registered") return next(new ErrorHandler(`Already registered — IRN ${note.einvoice.irn}`, 409));
  const doc = await asInvoice(note.toObject());
  const problems = readiness(doc);
  if (problems.length) {
    const err = new ErrorHandler(`The e-invoice cannot be registered yet: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ""}`, 409);
    err.code = "EINVOICE_NOT_READY"; err.details = { problems };
    return next(err);
  }
  let provider;
  try { provider = await getProvider(); } catch (err) { return next(err); }
  let reg;
  try {
    reg = await provider.register(buildEinvoiceJson(doc), { invoice: note });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    const e = new ErrorHandler(`The e-invoice provider could not be reached: ${err.message}`, 502);
    e.code = "EINVOICE_UNREACHABLE";
    return next(e);
  }
  stamp(note, reg, provider.name, req);
  await note.save();
  res.json({ success: true, note: note.toObject() });
}));

router.post("/notes/:id/irn", catchAsyncErrors(async (req, res, next) => {
  const note = await loadNote(req, next);
  if (!note || !customerOnly(note, next)) return;
  if (note.status === "cancelled") return next(new ErrorHandler("A cancelled note cannot be registered", 409));
  if (note.einvoice?.status === "registered") return next(new ErrorHandler(`Already registered — IRN ${note.einvoice.irn}`, 409));
  const irn = String(req.body?.irn || "").trim().toLowerCase();
  if (!IRN_RE.test(irn)) return next(new ErrorHandler("The IRN is 64 hexadecimal characters, as printed on the portal's acknowledgement", 400));
  let ackDate;
  try { ackDate = readDate(req.body?.ackDate, "ackDate", new Date()); } catch (err) { return next(err); }
  const clash = await AccountNote.findOne({ "einvoice.irn": irn, _id: { $ne: note._id } }).select("noteNo").lean();
  if (clash) return next(new ErrorHandler(`That IRN is already on ${clash.noteNo}`, 409));
  stamp(note, { irn, ackNo: String(req.body?.ackNo || "").trim().slice(0, 40), ackDate, signedQr: String(req.body?.signedQr || "").trim().slice(0, 4000) }, "manual", req);
  await note.save();
  res.json({ success: true, note: note.toObject() });
}));

// ── Receipts / payment advice ─────────────────────────────────────
async function partyOf(partyType, id) {
  if (!id) return null;
  if (partyType === "customer") {
    const c = await Customer.findById(id).select("name gstin address city pincode phoneNumber accountant").lean();
    return c && { name: c.name, gstin: c.gstin || "", address: [c.address, [c.city, c.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", "), phone: c.accountant?.mobile || c.phoneNumber || "" };
  }
  const s = await Supplier.findById(id).select("name gstin address phoneNumber").lean();
  return s && { name: s.name, gstin: s.gstin || "", address: s.address || "", phone: s.phoneNumber || "" };
}

router.get("/payments/:id/pdf", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Voucher not found", 404));
  const v = await Payment.findById(req.params.id).select("-attachments.data -fingerprints").lean();
  if (!v) return next(new ErrorHandler("Voucher not found", 404));
  const branding = await getPdfBranding();
  const party = await partyOf(v.partyType, v.customer || v.supplier);
  pdf(res, v.voucherNo, await renderPdf("voucher", { voucher: v, party: party || { name: v.partyName }, branding, company: branding.company }));
}));

// ── Statement of account ───────────────────────────────────────────
async function statementFor(q) {
  const partyType = q.partyType;
  if (!["customer", "supplier"].includes(partyType)) throw new ErrorHandler("partyType must be customer or supplier", 400);
  if (!isId(q.party)) throw new ErrorHandler("party is required", 400);
  const from = readDate(q.from, "from");
  let to = readDate(q.to, "to");
  if (to) to = new Date(new Date(to).setHours(0, 0, 0, 0) + DAY - 1);
  const party = await partyOf(partyType, q.party);
  if (!party) throw new ErrorHandler("Party not found", 404);
  const statement = await partyLedger.statement(partyType, q.party, { from, to });
  const open = outstanding.totals(partyType === "customer" ? await outstanding.receivables({ customer: q.party }) : await outstanding.payables({ supplier: q.party }));
  return { partyType, party, statement, from, to, open };
}

router.get("/statement/pdf", catchAsyncErrors(async (req, res, next) => {
  let s;
  try { s = await statementFor(req.query); } catch (err) { return next(err); }
  const branding = await getPdfBranding();
  pdf(res, `Statement ${s.party.name}`, await renderPdf("partyStatement", { ...s, branding, company: branding.company }));
}));

// ── WhatsApp drafts ────────────────────────────────────────────────
router.post("/share/draft", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  const settings = await getDocumentSettings();
  const company = settings.companyName || "Balu Elastics";
  let message = "";
  let to = "";
  if (b.kind === "payment") {
    if (!isId(b.id)) return next(new ErrorHandler("id is required", 400));
    const v = await Payment.findById(b.id).select("-attachments.data -fingerprints").lean();
    if (!v) return next(new ErrorHandler("Voucher not found", 404));
    const party = await partyOf(v.partyType, v.customer || v.supplier);
    to = party?.phone || "";
    const docs = (v.allocations || []).map((a) => `• ${a.docNo} — ₹${money(a.amount)}${a.tds ? ` (TDS ₹${money(a.tds)})` : ""}`);
    message = v.kind === "receipt"
      ? [`Dear ${party?.name || v.partyName},`, "", `Thank you — we have received ₹${money(v.amount)} on ${dmy(v.date)}${v.reference ? ` (ref ${v.reference})` : ""}, receipt ${v.voucherNo}.`, ...(docs.length ? ["", "Set against:", ...docs] : []), ...(v.unallocated > 0.005 ? [`₹${money(v.unallocated)} is held on account.`] : []), "", company].join("\n")
      : [`Dear ${party?.name || v.partyName},`, "", `We have paid ₹${money(v.amount)} on ${dmy(v.date)}${v.reference ? ` (UTR ${v.reference})` : ""}, voucher ${v.voucherNo}.`, ...(docs.length ? ["", "Against your bills:", ...docs] : []), ...(v.tds?.amount ? [`TDS of ₹${money(v.tds.amount)} deducted u/s ${v.tds.section || "—"}.`] : []), "", company].join("\n");
  } else if (b.kind === "note") {
    if (!isId(b.id)) return next(new ErrorHandler("id is required", 400));
    const n = await AccountNote.findById(b.id).select("-attachments.data -fingerprints").lean();
    if (!n) return next(new ErrorHandler("Note not found", 404));
    const party = await partyOf(n.partyType, n.customer || n.supplier);
    to = party?.phone || "";
    message = [`Dear ${party?.name || n.partyName},`, "", `${n.kind === "credit" ? "Credit" : "Debit"} note ${n.noteNo} dated ${dmy(n.date)} for ₹${money(n.totals?.grand)} against ${n.against?.docNo}: ${n.reason}.`, "", company].join("\n");
  } else if (b.kind === "statement") {
    let s;
    try { s = await statementFor(b); } catch (err) { return next(err); }
    to = s.party.phone || "";
    const owes = s.statement.closing;
    message = [`Dear ${s.party.name},`, "", `Your statement of account with ${company}${s.from ? ` from ${dmy(s.from)}` : ""} to ${dmy(s.to || new Date())}:`,
      `Opening ₹${money(Math.abs(s.statement.opening))} · ${s.statement.rows.length} entries · closing ₹${money(Math.abs(owes))} ${s.partyType === "customer" ? (owes >= 0 ? "due from you" : "held for you") : (owes >= 0 ? "due to you" : "paid ahead")}.`,
      ...(s.open.overdue > 0 && s.partyType === "customer" ? [`Of this, ₹${money(s.open.overdue)} is past due.`] : []),
      "", "Please let us know if anything does not agree with your books.", "", company].join("\n");
  } else {
    return next(new ErrorHandler("kind must be payment, note or statement", 400));
  }
  res.json({ success: true, to: e164(to), message });
}));

module.exports = router;
