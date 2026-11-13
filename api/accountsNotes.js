"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — CREDIT AND DEBIT NOTES  (part of /api/v2/accounts)
//
//  A credit note to a customer, a debit note to a supplier.
//
//    GET   /notes
//    GET   /notes/:id
//    POST  /notes
//    POST  /notes/:id/cancel
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const mongoose = require("mongoose");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { escapeRegex }  = require("../utils/escapeRegex");
const { ACTION_CODES } = require("../utils/fingerprint");
const { allocate, burn } = require("../services/docNumbers");
const partyLedger  = require("../services/partyLedger");
const creditNoteLimit = require("../services/creditNoteLimit");
const overdueInterest = require("../services/overdueInterest");
const SupplierBill    = require("../models/SupplierBill");
const AccountNote     = require("../models/AccountNote");
const Payment         = require("../models/Payment");
const Invoice         = require("../models/Invoice");
const {
  isId,
  r2,
  readDate,
  reasonFrom,
  fp,
  withTxn,
  paging,
} = require("../services/accountsHelpers");
const settle = require("../services/settle");
const { assertOpen } = require("../services/booksLock");
const { onceAtATime, perDocument } = require("../utils/onceAtATime");
const { replayOf, replayAfter } = require("../services/posting");
const { sellerStateCode, readLines, priced } = require("./accountsCommon");
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  CREDIT / DEBIT NOTES
// ══════════════════════════════════════════════════════════════════
//  credit → customer, against an invoice: lowers what they owe
//  debit  → supplier, against a bill:     lowers what we owe
//  debit  → customer, against an invoice: raises what they owe
//
//  A note that lowers is applied to its document up to what that still
//  owes; the rest is unapplied credit on the party, applied later
//  (POST /credits/apply). It can never come to more than the document
//  was for, less the notes already against it.
router.get("/notes", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.kind === "credit" || req.query.kind === "debit") q.kind = req.query.kind;
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.customer)) q.customer = req.query.customer;
  if (isId(req.query.supplier)) q.supplier = req.query.supplier;
  if (range) q.date = range;
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [{ noteNo: re }, { partyName: re }, { "against.docNo": re }, { reason: re }, { partyNoteNo: re }];
  }
  const [total, notes] = await Promise.all([
    AccountNote.countDocuments(q),
    AccountNote.find(q).select("-attachments.data -lines").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), notes });
}));

router.get("/notes/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Note not found", 404));
  const note = await AccountNote.findById(req.params.id).select("-attachments.data").lean();
  if (!note) return next(new ErrorHandler("Note not found", 404));
  res.json({ success: true, note });
}));

router.post("/notes", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  const kind = b.kind === "debit" ? "debit" : b.kind === "credit" ? "credit" : null;
  if (!kind) return next(new ErrorHandler("kind must be credit or debit", 400));
  // A credit note is to a customer; a debit note to a supplier unless it says customer.
  const partyType = kind === "credit" ? "customer" : b.partyType === "customer" ? "customer" : "supplier";
  const before = await replayOf(AccountNote, b.requestId, { select: "-attachments.data" });
  if (before) return res.status(200).json({ success: true, note: before, replay: true });
  const reason = String(b.reason || "").trim();
  if (reason.length < 3) return next(new ErrorHandler("reason is required", 400));
  if (!isId(b.against?.doc)) return next(new ErrorHandler("against.doc is required", 400));
  const docType = partyType === "customer" ? "Invoice" : "SupplierBill";
  const loadTarget = () => (docType === "Invoice" ? Invoice.findById(b.against.doc).lean() : SupplierBill.findById(b.against.doc).lean());
  let target = await loadTarget();
  if (!target) return next(new ErrorHandler(`${docType === "Invoice" ? "Invoice" : "Bill"} not found`, 404));
  if (docType === "Invoice" && target.status !== "issued") return next(new ErrorHandler("That invoice is cancelled", 409));
  if (docType === "SupplierBill" && target.status === "cancelled") return next(new ErrorHandler("That bill is cancelled", 409));
  let date, lines, interest = [];
  // s.34(2): a GST credit note for an invoice of one year is allowed until
  // 30 November of the next. After that it is a financial credit note, no tax.
  let financial = false;
  try {
    date = readDate(b.date, "date", new Date());
    // A debit note charging interest says which invoices and days it covered.
    if (kind === "debit" && partyType === "customer") interest = overdueInterest.readMarkers(b.interest);
    await assertOpen(date, req);
    lines = readLines(b.lines, { defaultGst: target.lines?.[0]?.gstPercent ?? 5 });
    if (kind === "credit" && docType === "Invoice") {
      const lim = creditNoteLimit.check(target.invoiceDate, date);
      if (lim.past && !b.financial) {
        const err = new ErrorHandler(`A GST credit note against ${target.invoiceNumber} could be declared only until ${lim.limit.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} (s.34(2)). Issue it as a financial credit note instead: the customer's account comes down, no GST moves.`, 400);
        err.code = "CN_TIME_LIMIT"; err.details = { limit: lim.limit };
        throw err;
      }
      if (b.financial) { financial = true; lines = lines.map((l) => ({ ...l, gstPercent: 0 })); }
    }
  } catch (err) { return next(err); }
  const partyState = docType === "Invoice" ? target.buyer?.stateCode : target.supplierStateCode;
  // A note against an export or SEZ invoice is priced as that invoice was: IGST, or nothing.
  const p = priced(lines, await sellerStateCode(), partyState, docType === "Invoice" ? require("../services/exportSupply").pricing(target.export) : {});
  const party = docType === "Invoice" ? target.customer : target.supplier;
  const partyName = docType === "Invoice" ? target.buyer?.name : target.supplierName;
  const partyGstin = docType === "Invoice" ? target.buyer?.gstin : target.supplierGstin;
  const docNo = docType === "Invoice" ? target.invoiceNumber : target.billNo;
  // Raises: a debit note to a customer. Lowers: the other two.
  const raises = kind === "debit" && partyType === "customer";
  // One note at a time against a document. How much room it has left for
  // notes is worked out and then the note is issued: two requests
  // together both found the room and both took it, and a paid invoice of
  // 10,500 carried 16,800 of credit notes. The second now waits for the
  // first and is measured against what the first left.
  const issue = () => onceAtATime(`note:${target._id}`, async () => {
  target = await loadTarget();
  if (!target || (docType === "Invoice" ? target.status !== "issued" : target.status === "cancelled")) return next(new ErrorHandler(`${docNo} was cancelled meanwhile`, 409));
  // The days an interest note says it covers are checked against the
  // books, not taken from the browser: its invoices are this customer's,
  // the days fall after each was due, and none were charged before.
  try { await overdueInterest.checkMarkers(interest, { customer: party, date }); } catch (err) { return next(err); }
  let applied = p.totals.grand;
  if (!raises) {
    const earlier = await AccountNote.aggregate([
      { $match: { "against.doc": target._id, kind, status: "issued" } },
      { $group: { _id: null, total: { $sum: "$totals.grand" } } },
    ]);
    const room = r2((target.totals?.grand || 0) + (target.debitedAmount && docType === "Invoice" ? target.debitedAmount : 0) - (earlier[0]?.total || 0));
    if (p.totals.grand > room + 0.005) {
      return next(new ErrorHandler(`${docNo} is for ₹${r2(target.totals?.grand).toFixed(2)}${earlier[0]?.total ? ` and already has notes for ₹${r2(earlier[0].total).toFixed(2)}` : ""} — a note can be for at most ₹${Math.max(0, room).toFixed(2)}`, 400));
    }
    applied = Math.min(p.totals.grand, Math.max(0, settle.outstanding(docType, target)));
  }
  applied = r2(applied);
  const unapplied = r2(p.totals.grand - applied);

  const { financialYear, sequence, number } = await allocate(AccountNote, kind === "credit" ? "CN" : "DN", { extra: { kind }, at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, kind, noteNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined, date,
    partyType, customer: partyType === "customer" ? party : undefined, supplier: partyType === "supplier" ? party : undefined,
    partyName, partyGstin: partyGstin || "", partyNoteNo: String(b.partyNoteNo || "").trim().slice(0, 40),
    against: { docType, doc: target._id, docNo },
    reason: reason.slice(0, 200), supplyType: p.supplyType, lines: p.lines, totals: p.totals, financial, interest,
    applied, unapplied, notes: String(b.notes || "").trim().slice(0, 500), createdBy: req.user?._id,
  };
  data.fingerprints = [fp(ACTION_CODES.NOTE_ISSUED, { _id }, req, { noteNo: number, against: docNo, grand: p.totals.grand, unapplied, reason })];
  try {
    await withTxn(async (session) => {
      await AccountNote.create([data], { session });
      if (applied > 0) {
        const field = raises ? "debitedAmount" : docType === "Invoice" ? "creditedAmount" : "debitedAmount";
        await settle.apply(docType, target._id, { [field]: applied }, session, { docNo });
      }
      // Lowers what a customer owes / what we owe a supplier, or raises a customer's.
      const side = partyType === "customer" ? (raises ? "debit" : "credit") : "debit";
      await partyLedger.post({ partyType, party, date, docType: "AccountNote", doc: _id, docNo: number, [side]: p.totals.grand, narration: `${reason} (${docNo})` }, session);
    });
  } catch (err) {
    // The number drawn for this note is gone with it: noted, so the gap
    // in the series is accounted for (models/BurntNumber.js). A note to
    // a supplier is not a document the GST return lists.
    await burn(partyType === "customer" ? `${kind}-note` : `${kind}-note-supplier`, { number, financialYear, sequence, date, reason: err?.message, req });
    const dup = await replayAfter(err, AccountNote, b.requestId, { select: "-attachments.data" });
    if (dup) return res.status(200).json({ success: true, note: dup, replay: true });
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  const issued = await AccountNote.findById(_id).select("-attachments.data").lean();
  // Issued from a customer's debit note read from a photo: what was kept scores the read.
  if (b.debitNoteSuggestion && mongoose.isValidObjectId(String(b.debitNoteSuggestion))) {
    const intake = require("../services/debitNoteIntake");
    require("../services/aiLedger").settle(b.debitNoteSuggestion, { accepted: intake.accepted(issued), decidedBy: req.user?._id, expectSurface: intake.SURFACE }).catch(() => null);
  }
  res.status(201).json({ success: true, note: issued });
  }, { what: "A note against this document" });
  // One interest note at a time for a customer: two together would each
  // find the same days uncharged, and both charge them.
  if (interest.length) await onceAtATime(`interest:${party}`, issue, { what: "Interest for this customer" });
  else await issue();
}));

/** The field a note moves on the document it is applied to. */
function noteField(note, docType) {
  if (docType === "OpeningBalance") return "settledAmount";
  if (note.kind === "debit" && note.partyType === "customer") return "debitedAmount";
  return docType === "Invoice" ? "creditedAmount" : "debitedAmount";
}

// Under the note's portal lease (api/accountsDocs.js): a cancel sent
// while the note is being registered waits, and then cancels a note
// that says it holds an IRN.
router.post("/notes/:id/cancel", perDocument("note-portal", async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Note not found", 404));
  const note = await AccountNote.findById(req.params.id).lean();
  if (!note) return next(new ErrorHandler("Note not found", 404));
  if (note.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); await assertOpen(note.date, req, { cancelling: true }); } catch (err) { return next(err); }
  const cancel = { reason, at: new Date(), by: req.user?._id };
  const mark = fp(ACTION_CODES.NOTE_CANCELLED, note, req, { noteNo: note.noteNo, reason });
  // A debit note to a customer raised their invoice; once that was paid,
  // taking it off would leave the invoice settled past what it owes and
  // the money stranded on it. The receipt comes off first.
  const raised = note.kind === "debit" && note.partyType === "customer";
  try {
    await withTxn(async (session) => {
      // Money already refunded out of a note's unapplied credit is gone: the
      // refund comes off first. Asked inside the transaction, so a refund
      // posted a moment ago is seen.
      const refundedBy = raised ? null : await Payment.findOne({ status: "posted", "refunds.source": note._id }).select("voucherNo").session(session).lean();
      if (refundedBy) throw new ErrorHandler(`${note.noteNo} was refunded by ${refundedBy.voucherNo} — cancel that first`, 409);
      // Marked cancelled by a write that hands back the note as it stood at
      // that moment: what is reversed is what it holds NOW. A credit of it
      // applied to another invoice between this route's first read and
      // here is on that record, and comes off with the rest. (Conditional
      // on it still being issued: two cancels at once cannot both reverse it.)
      const was = await AccountNote.findOneAndUpdate(
        { _id: note._id, status: "issued" },
        { $set: { status: "cancelled", cancel, unapplied: 0 }, $push: { fingerprints: mark } },
        { session, new: false }
      ).select("kind partyType against applied unapplied applications totals").lean();
      if (!was) throw new ErrorHandler("Already cancelled", 409);
      // What it applied to its own document — older notes carry no `applied`: all of it.
      // Only when nothing shows where it went: applied 0, nothing left and no
      // later application. A note applied 0 then set wholly against another
      // invoice is not that — reversing its total off its own document took
      // credit off an invoice that never had it.
      const legacy = was.applied === undefined || was.applied === null || (was.applied === 0 && !was.unapplied && !(was.applications || []).length);
      const onAgainst = legacy ? was.totals.grand : was.applied;
      if (raised && onAgainst > 0) {
        const inv = await Invoice.findById(was.against.doc).session(session).lean();
        const left = inv ? settle.outstanding("Invoice", inv) : 0;
        if (inv && inv.status === "issued" && left < onAgainst - 0.005) {
          throw new ErrorHandler(`${was.against.docNo} has been paid past ₹${r2(left).toFixed(2)} of this note — cancel the receipt that paid it first`, 409);
        }
      }
      if (onAgainst > 0) await settle.apply(was.against.docType, was.against.doc, { [noteField(was, was.against.docType)]: -onAgainst }, session);
      for (const a of was.applications || []) {
        await settle.apply(a.docType, a.doc, { [noteField(was, a.docType)]: -a.amount }, session);
      }
      await partyLedger.reverse("AccountNote", note._id, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  // A registered IRN is not cancelled from here: the person is told to do it at the portal.
  const portalNote = note.einvoice?.status === "registered"
    ? `This note holds IRN ${String(note.einvoice.irn || "").slice(0, 12)}… — cancel it on the e-invoice portal as well (within 24 hours of registration).`
    : "";
  res.json({ success: true, note: await AccountNote.findById(note._id).select("-attachments.data").lean(), ...(portalNote ? { portalNote } : {}) });
}, { what: "This note", ttlMs: 75_000 }));

module.exports = router;
