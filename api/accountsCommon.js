"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — WHAT MORE THAN ONE ACCOUNTS FILE USES
//
//  The attachment upload, the helpers that read and price a document's
//  lines, and createVoucher — the one way a receipt or payment is made,
//  used by the voucher routes, the bank statement and the bank feed.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const multer   = require("multer");
const ErrorHandler     = require("../utils/ErrorHandler");
const { ACTION_CODES } = require("../utils/fingerprint");
const { computeInvoice, stateCodeFromGstin } = require("../services/gst");
const { getDocumentSettings } = require("../services/documentSettings");
const { allocate } = require("../services/docNumbers");
const partyLedger  = require("../services/partyLedger");
const outstanding  = require("../services/outstanding");
const BankAccount     = require("../models/BankAccount");
const ExpenseCategory = require("../models/ExpenseCategory");
const Expense         = require("../models/Expense");
const AccountNote     = require("../models/AccountNote");
const Payment         = require("../models/Payment");
const Supplier        = require("../models/Supplier");
const Customer        = require("../models/Customer");
const { MAX_ATTACHMENT_BYTES } = require("../models/accountsShared");
const { isId, r2, readDate, businessDay, fp, withTxn } = require("../services/accountsHelpers");
const settle = require("../services/settle");
const credits = require("../services/credits");
const { assertOpen } = require("../services/booksLock");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });

// ── Helpers ───────────────────────────────────────────────────────
/** The seller's state, off Settings. */
async function sellerStateCode() {
  const s = await getDocumentSettings();
  return s.invoice?.stateCode || stateCodeFromGstin(s.gstin);
}

/** Lines from the client, checked and priced. */
function readLines(raw, { defaultGst = 5 } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw new ErrorHandler("At least one line is required", 400);
  return raw.map((l, i) => {
    const description = String(l?.description || "").trim();
    if (!description) throw new ErrorHandler(`Line ${i + 1}: description is required`, 400);
    const quantity = l?.quantity === undefined || l?.quantity === "" ? 1 : Number(l.quantity);
    const rate = Number(l?.rate);
    const gstPercent = l?.gstPercent === undefined || l?.gstPercent === null || l?.gstPercent === "" ? defaultGst : Number(l.gstPercent);
    if (!Number.isFinite(quantity) || quantity < 0) throw new ErrorHandler(`Line ${i + 1}: quantity must be 0 or more`, 400);
    if (!Number.isFinite(rate) || rate < 0) throw new ErrorHandler(`Line ${i + 1}: rate must be 0 or more`, 400);
    if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) throw new ErrorHandler(`Line ${i + 1}: GST % must be between 0 and 100`, 400);
    const hsn = String(l?.hsn || "").trim();
    if (hsn && !/^\d{4,8}$/.test(hsn)) throw new ErrorHandler(`Line ${i + 1}: HSN is 4 to 8 digits`, 400);
    return {
      rawMaterial: isId(l?.rawMaterial) ? l.rawMaterial : undefined,
      description: description.slice(0, 200), hsn, unit: String(l?.unit || "").trim().slice(0, 10),
      quantity, rate, gstPercent,
    };
  });
}

function priced(lines, sellerState, partyState, extra = {}) {
  const p = computeInvoice(lines, { sellerStateCode: sellerState, buyerStateCode: partyState, ...extra });
  return {
    supplyType: p.supplyType,
    lines: p.lines.map((l) => ({
      rawMaterial: l.rawMaterial, description: l.description, hsn: l.hsn, unit: l.unit, quantity: l.quantity, rate: l.rate,
      taxable: l.taxable, gstPercent: l.gstPercent, cgst: l.cgst, sgst: l.sgst, igst: l.igst, amount: l.amount,
    })),
    totals: p.totals,
  };
}

// What a short payment can be settled by, besides the money.
const ADJUSTMENTS = {
  receipt: ["bank_charges", "discount", "tds_by_customer", "round_off", "write_off"],
  payment: ["discount", "round_off", "write_off"],
};
const ADJUSTMENT_LABELS = { bank_charges: "Bank charges", discount: "Discount", tds_by_customer: "TDS deducted by customer", round_off: "Round off", write_off: "Written off" };

/** The field a voucher's allocation moves on each kind of document. */
const VOUCHER_FIELD = { Invoice: "paidAmount", SupplierBill: "paidAmount", Expense: "paidAmount", OpeningBalance: "settledAmount" };
/** The credits a refund can pay back, by their type. */
const REFUND_SOURCES = { Payment, AccountNote, OpeningBalance: require("../models/OpeningBalance") };

/**
 * Post a receipt or payment voucher from a request body. Throws an
 * ErrorHandler for anything the caller got wrong; returns the voucher
 * (or the one a replayed requestId already made).
 *
 * Settled on the documents = money + TDS + adjustments. TDS on a
 * payment is deducted on each document's value net of GST.
 *
 * `opts.bankLine`: the bank line this voucher answers, when it is posted
 * from a statement line (services/bankLines.js). It comes from the
 * server's own reading of the stored line, never from the request body.
 * A line that a live voucher already answers gets that voucher back
 * (replay), whatever request id it was first posted under.
 */
async function createVoucher(b, req, opts = {}) {
  const kind = b.kind === "receipt" ? "receipt" : b.kind === "payment" ? "payment" : null;
  if (!kind) throw new ErrorHandler("kind must be receipt or payment", 400);
  const bankLine = opts.bankLine ? String(opts.bankLine) : null;
  if (bankLine) {
    const held = await Payment.findOne({ bankLine, status: "posted" }).select("-attachments.data").lean();
    if (held) return { voucher: held, replay: true };
  }
  if (b.requestId) {
    const dup = await Payment.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
    if (dup) return { voucher: dup, replay: true };
  }
  const amount = r2(b.amount);
  if (!(amount > 0)) throw new ErrorHandler("amount must be more than 0", 400);
  if (!["cash", "bank", "upi", "cheque", "card"].includes(b.mode)) throw new ErrorHandler("mode must be cash, bank, upi, cheque or card", 400);
  if (!isId(b.account)) throw new ErrorHandler("account is required", 400);
  const account = await BankAccount.findById(b.account).lean();
  if (!account || !account.active) throw new ErrorHandler("Account not found", 404);
  // Cash goes through the cash box, and only cash does: a cash receipt
  // put into the bank waits forever on the bank reconciliation, and a
  // transfer put into the cash box makes the cash book wrong.
  if (b.mode === "cash" && account.kind !== "cash") throw new ErrorHandler(`Cash is received into and paid from a cash account — ${account.name} is a ${account.kind} account`, 400);
  if (b.mode !== "cash" && account.kind === "cash") throw new ErrorHandler(`${account.name} is the cash box — a ${b.mode === "upi" ? "UPI" : b.mode} ${kind} goes through a bank account`, 400);
  // A credit card account is spent on by card, and nothing else; a card
  // receipt (a customer paying at the counter) settles into a bank account.
  if (account.kind === "card" && b.mode !== "card") throw new ErrorHandler(`${account.name} is a credit card — what is paid on it is paid by card. Paying the card bill is a transfer from the bank`, 400);
  if (b.mode === "card" && !["card", "bank"].includes(account.kind)) throw new ErrorHandler(`A card ${kind} goes through a credit card or bank account`, 400);
  const date = readDate(b.date, "date", new Date());
  await assertOpen(date, req);
  // A cheque: its number, bank and date. One received is in hand until
  // someone deposits it (cheque.deposited / depositedOn says it already
  // was); one issued is with the party from the voucher date. Dated
  // after today, either is held until its date.
  let cheque;
  if (b.mode === "cheque") {
    const c = b.cheque || {};
    const chequeDate = c.date ? readDate(c.date, "cheque.date") : date;
    const postDated = chequeDate > businessDay(new Date());
    const depositedOn = c.depositedOn ? readDate(c.depositedOn, "cheque.depositedOn") : null;
    const deposited = !postDated && (kind === "payment" || c.deposited === true || !!depositedOn);
    cheque = {
      number: String(c.number || b.reference || "").trim().slice(0, 20), bank: String(c.bank || "").trim().slice(0, 80), date: chequeDate,
      status: deposited ? "deposited" : "held", receivedOn: date, ...(deposited ? { depositedOn: depositedOn || date } : {}),
    };
  }

  // The party.
  const partyType = b.partyType;
  let party = null;
  let partyName = String(b.partyName || "").trim();
  // Money the other way — paid back to a customer, or paid back to us by
  // a supplier — is a refund, and comes out of what they have on account.
  const refunding = (partyType === "customer" && kind === "payment") || (partyType === "supplier" && kind === "receipt");
  if (refunding && !(Array.isArray(b.refunds) && b.refunds.length)) {
    throw new ErrorHandler(partyType === "customer"
      ? "A customer pays us by a receipt — to pay a customer back, refund what they have on account"
      : "A supplier is paid by a payment — money a supplier pays back is a refund of what we have with them", 400);
  }
  if (partyType === "customer") {
    if (!isId(b.customer)) throw new ErrorHandler("customer is required", 400);
    party = await Customer.findById(b.customer).select("name").lean();
    if (!party) throw new ErrorHandler("Customer not found", 404);
    partyName = party.name;
  } else if (partyType === "supplier") {
    if (!isId(b.supplier)) throw new ErrorHandler("supplier is required", 400);
    party = await Supplier.findById(b.supplier).select("name").lean();
    if (!party) throw new ErrorHandler("Supplier not found", 404);
    partyName = party.name;
  } else if (partyType === "other") {
    if (!partyName) throw new ErrorHandler("partyName is required for an other-party voucher", 400);
  } else {
    throw new ErrorHandler("partyType must be customer, supplier or other", 400);
  }

  // A refund: which credits it pays back, each no more than is left on it.
  const refundLines = [];
  if (refunding) {
    if ((Array.isArray(b.allocations) && b.allocations.length) || (Array.isArray(b.adjustments) && b.adjustments.some((a) => r2(a?.amount))) || Number(b.tds?.rate)) {
      throw new ErrorHandler("A refund pays back credit on account — it settles no documents and carries no TDS or adjustments", 400);
    }
    const seenSrc = new Set();
    for (const [i, x] of b.refunds.entries()) {
      const Model = REFUND_SOURCES[x?.sourceType];
      if (!Model) throw new ErrorHandler(`Refund ${i + 1}: sourceType must be Payment, AccountNote or OpeningBalance`, 400);
      if (!isId(x.id) || seenSrc.has(String(x.id))) throw new ErrorHandler(`Refund ${i + 1}: a credit, once`, 400);
      seenSrc.add(String(x.id));
      const amt = r2(x.amount);
      if (!(amt > 0)) throw new ErrorHandler(`Refund ${i + 1}: amount must be more than 0`, 400);
      const src = await Model.findById(x.id).lean();
      const live = src && (x.sourceType === "AccountNote" ? src.status === "issued" : src.status === "posted");
      if (!live) throw new ErrorHandler(`Refund ${i + 1}: that credit is not available`, 404);
      const rules = credits.rulesFor(x.sourceType, src);
      if (rules.partyType !== partyType || String(rules.party) !== String(party._id)) throw new ErrorHandler(`Refund ${i + 1}: that credit belongs to another party`, 400);
      // A refund voucher is not itself a credit to refund again.
      if (x.sourceType === "Payment" && src.kind !== (partyType === "customer" ? "receipt" : "payment")) throw new ErrorHandler(`Refund ${i + 1}: that is not money they have on account`, 400);
      const field = x.sourceType === "Payment" ? "unallocated" : "unapplied";
      const no = x.sourceType === "Payment" ? src.voucherNo : x.sourceType === "AccountNote" ? src.noteNo : src.docNo;
      if (amt > r2(src[field]) + 0.005) throw new ErrorHandler(`Refund ${i + 1}: ${no} has only ₹${r2(src[field]).toFixed(2)} on account`, 400);
      refundLines.push({ sourceType: x.sourceType, source: src._id, docNo: no, amount: amt, field });
    }
    const total = r2(refundLines.reduce((t, x) => t + x.amount, 0));
    if (Math.abs(total - amount) > 0.005) throw new ErrorHandler(`The refund is for ₹${amount.toFixed(2)} but the credits picked come to ₹${total.toFixed(2)}`, 400);
  }

  // TDS, on payments only.
  const tdsRate = kind === "payment" && !refunding ? Number(b.tds?.rate) || 0 : 0;
  if (tdsRate < 0 || tdsRate > 100) throw new ErrorHandler("TDS rate must be between 0 and 100", 400);
  const tdsSection = String(b.tds?.section || "").trim().slice(0, 8);

  // Adjustments: what settles the documents besides the money.
  const adjustments = [];
  for (const [i, a] of (Array.isArray(b.adjustments) ? b.adjustments : []).entries()) {
    const amt = r2(a?.amount);
    if (!amt) continue;
    if (!ADJUSTMENTS[kind].includes(a?.kind)) throw new ErrorHandler(`Adjustment ${i + 1}: a ${kind} cannot carry "${a?.kind || "?"}"`, 400);
    if (amt < 0) throw new ErrorHandler(`Adjustment ${i + 1}: amount must be more than 0`, 400);
    if (a.kind === "write_off" && req.user?.role !== "admin") throw new ErrorHandler("Only an admin can write an amount off", 403);
    adjustments.push({ kind: a.kind, label: ADJUSTMENT_LABELS[a.kind], amount: amt, note: String(a.note || "").trim().slice(0, 80) });
  }
  const adjTotal = r2(adjustments.reduce((s, a) => s + a.amount, 0));

  // The allocations: each names an open document of this party, for a
  // GROSS amount (what the document is settled by); TDS comes off it.
  const rawAlloc = Array.isArray(b.allocations) ? b.allocations : [];
  // Money coming in from someone not on file (interest, a refund, a
  // loan) settles nothing: only a payment to an other party pays an expense.
  const allowedTypes = partyType === "customer" ? ["Invoice", "OpeningBalance"] : partyType === "supplier" ? ["SupplierBill", "Expense", "OpeningBalance"] : kind === "payment" ? ["Expense"] : [];
  const allocations = [];
  const seen = new Set();
  // The section the TDS is under: the voucher's, else the bill's own when the rate came from there.
  let sectionFromDoc = "";
  for (const [i, a] of rawAlloc.entries()) {
    if (!allowedTypes.includes(a?.docType)) throw new ErrorHandler(`Allocation ${i + 1}: a ${kind} to this party cannot settle a ${a?.docType || "?"}`, 400);
    if (!isId(a.doc)) throw new ErrorHandler(`Allocation ${i + 1}: doc is required`, 400);
    if (seen.has(String(a.doc))) throw new ErrorHandler(`Allocation ${i + 1}: the same document twice`, 400);
    seen.add(String(a.doc));
    const gross = r2(a.amount);
    if (!(gross > 0)) throw new ErrorHandler(`Allocation ${i + 1}: amount must be more than 0`, 400);
    const doc = await settle.load(a.docType, a.doc);
    if (!doc) throw new ErrorHandler(`Allocation ${i + 1}: document not found`, 404);
    const docNo = settle.numberOf(a.docType, doc);
    const docParty = settle.kindOf(a.docType).party(doc);
    if (party && String(docParty) !== String(party._id)) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} belongs to another party`, 400);
    // An expense to a supplier on file is paid to that supplier, so it is on their account.
    if (!party && docParty) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} is to a supplier on file — pay it as a payment to that supplier`, 400);
    if (a.docType === "OpeningBalance" && doc.partyType !== partyType) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} belongs to another party`, 400);
    if (!settle.isOpen(a.docType, doc)) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} is not open`, 409);
    const left = settle.outstanding(a.docType, doc);
    if (gross > left + 0.005) throw new ErrorHandler(`Allocation ${i + 1}: ${docNo} has only ${left.toFixed(2)} outstanding`, 400);
    let rate = 0;
    if (kind === "payment") rate = a.docType === "SupplierBill" ? (tdsRate || (doc.tds?.applicable ? doc.tds.rate : 0)) : tdsRate;
    if (kind === "payment" && a.docType === "SupplierBill" && !tdsRate && rate > 0 && !sectionFromDoc) sectionFromDoc = String(doc.tds?.section || "").trim().slice(0, 8);
    const tdsBase = rate > 0 ? r2(gross * (a.docType === "OpeningBalance" ? 1 : outstanding.ratio(doc.totals))) : 0;
    const tds = rate > 0 ? r2(tdsBase * rate / 100) : 0;
    allocations.push({ docType: a.docType, doc: doc._id, docNo, amount: gross, tds, tdsBase, rate });
  }
  const tdsAmount = r2(allocations.reduce((s, a) => s + a.tds, 0));
  const tdsBase = r2(allocations.reduce((s, a) => s + a.tdsBase, 0));
  const gross = r2(allocations.reduce((s, a) => s + a.amount, 0));
  // A discount, a write-off, bank charges: each settles a document, so
  // the ticked documents must absorb every adjustment (with the TDS on
  // them). Otherwise the adjustment would sit as money the party has on
  // account — a discount they could spend on the next invoice.
  if (adjTotal > 0 && adjTotal > gross + 0.005) throw new ErrorHandler("Adjustments settle documents — tick the documents they settle", 400);
  const settledTotal = r2(amount + tdsAmount + adjTotal);
  if (gross > settledTotal + 0.005) {
    throw new ErrorHandler(`The allocations need ${r2(gross - tdsAmount - adjTotal).toFixed(2)} but the voucher is for ${amount.toFixed(2)}`, 400);
  }
  // A refund pays credit back: none of it stays on account.
  const unallocated = refunding ? 0 : r2(settledTotal - gross);
  // Bank charges and TDS the customer deducted are money that really
  // left the payment, whatever it settles; a discount, a write-off or a
  // round-off only ever explains why a document was settled short, so
  // with money left on account there was nothing to explain.
  const explains = adjustments.filter((a) => ["discount", "write_off", "round_off"].includes(a.kind));
  if (explains.length && unallocated > 0.005) {
    throw new ErrorHandler(`Adjustments settle documents — ₹${unallocated.toFixed(2)} would be left on account. Tick the documents the ${explains.map((a) => a.label.toLowerCase()).join(", ")} settles, or take it off`, 400);
  }

  // Someone not on file: a payment's expense head, a receipt's income.
  let head = null;
  if (partyType === "other" && kind === "payment" && b.head) {
    if (!isId(b.head)) throw new ErrorHandler("head is not an id", 400);
    head = await ExpenseCategory.findById(b.head).select("name").lean();
    if (!head) throw new ErrorHandler("Expense head not found", 404);
  }
  const incomeLedger = partyType === "other" && kind === "receipt" && b.incomeLedger === "interest" ? "interest" : undefined;

  // Before money goes out: a bank account changed lately, or shared with
  // another supplier, stops it until someone says how they confirmed it.
  // A payment recorded from the bank statement has already left: nothing to stop.
  let risk = null;
  if (kind === "payment" && b.source !== "statement") {
    const danger = (await require("../services/paymentChecks").paymentFlags({ ...b, kind, partyType, supplier: partyType === "supplier" ? party?._id : undefined, partyName, amount, allocations }, req.user)).filter((f) => f.severity === "danger");
    if (danger.length) {
      const note = String(b.riskNote || "").trim();
      if (!b.confirmRisk || note.length < 8) {
        const err = new ErrorHandler(`${danger.map((f) => f.message).join(" · ")} — say how you confirmed it to pay`, 409);
        err.code = "PAYMENT_RISK";
        err.details = { flags: danger };
        throw err;
      }
      risk = { flags: danger.map((f) => f.code), note: note.slice(0, 300), byName: req.user?.name || "" };
    }
  }

  const { financialYear, sequence, number } = await allocate(Payment, kind === "receipt" ? "RCT" : "PAY", { extra: { kind }, at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, kind, voucherNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined, date,
    partyType, customer: partyType === "customer" ? party._id : undefined, supplier: partyType === "supplier" ? party._id : undefined, partyName,
    ...(head ? { head: head._id, headName: head.name } : {}), ...(incomeLedger ? { incomeLedger } : {}),
    amount, mode: b.mode, account: account._id, accountName: account.name, reference: String(b.reference || cheque?.number || "").trim().slice(0, 60),
    ...(cheque ? { cheque } : {}),
    tds: { section: tdsAmount > 0 ? tdsSection || sectionFromDoc || "" : "", rate: tdsAmount > 0 ? (tdsRate || allocations.find((a) => a.tds > 0)?.rate || 0) : 0, amount: tdsAmount, base: tdsBase },
    adjustments, allocations, unallocated, narration: String(b.narration || "").trim().slice(0, 300),
    ...(refundLines.length ? { refunds: refundLines.map(({ field, ...x }) => x) } : {}),
    source: b.source === "statement" ? "statement" : "manual", statementLine: String(b.statementLine || "").slice(0, 200),
    clearedOn: b.clearedOn ? readDate(b.clearedOn, "clearedOn") : undefined,
    ...(bankLine ? { bankLine } : {}),
    createdBy: req.user?._id,
    ...(risk ? { risk } : {}),
  };
  data.fingerprints = [fp(ACTION_CODES.PAYMENT_POSTED, { _id }, req, { voucherNo: number, amount, tds: tdsAmount, adjustments: adjTotal, docs: allocations.map((a) => a.docNo), ...(risk ? { risk: risk.flags, riskNote: risk.note } : {}) })];

  let voucher;
  try {
    await withTxn(async (session) => {
      [voucher] = await Payment.create([data], { session });
      // A refund takes what it pays back off each credit, conditionally:
      // two refunds of the same advance cannot both spend it.
      for (const x of refundLines) {
        const Model = REFUND_SOURCES[x.sourceType];
        const res = await Model.updateOne({ _id: x.source, [x.field]: { $gte: x.amount - 0.005 } }, { $inc: { [x.field]: -x.amount } }, { session });
        if (res.matchedCount === 0) throw new ErrorHandler(`${x.docNo} no longer has ₹${x.amount.toFixed(2)} on account`, 409);
        await Model.updateOne({ _id: x.source }, [{ $set: { [x.field]: { $round: [`$${x.field}`, 2] } } }], { session });
      }
      for (const a of allocations) {
        if (a.docType === "SupplierBill") {
          await settle.apply("SupplierBill", a.doc, { paidAmount: r2(a.amount - a.tds), tdsAmount: a.tds }, session, { docNo: a.docNo });
        } else if (a.docType === "Expense") {
          await settle.apply("Expense", a.doc, { paidAmount: a.amount }, session, { docNo: a.docNo, extraSet: { paidFrom: account._id, paidAt: date } });
          await Expense.updateOne({ _id: a.doc }, { $push: { fingerprints: fp(ACTION_CODES.EXPENSE_PAID, { _id: a.doc }, req, { voucherNo: number, amount: a.amount }) } }, { session });
        } else {
          await settle.apply(a.docType, a.doc, { [VOUCHER_FIELD[a.docType]]: a.amount }, session, { docNo: a.docNo });
        }
      }
      if (party) {
        await partyLedger.post({
          partyType, party: party._id, date, docType: "Payment", doc: _id, docNo: number,
          ...(kind === "receipt" ? { credit: settledTotal } : { debit: settledTotal }),
          narration: data.narration || (refundLines.length ? `Refund of ${refundLines.map((x) => x.docNo).join(", ")} by ${b.mode}` : null) || `${kind === "receipt" ? "Received" : "Paid"} by ${b.mode}${data.reference ? ` · ${data.reference}` : ""}${adjTotal ? ` · adjusted ₹${adjTotal.toFixed(2)}` : ""}`,
        }, session);
      }
    });
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await Payment.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
      if (dup) return { voucher: dup, replay: true };
    }
    // The same bank line posted by two requests together: the index let
    // one in, and this one is handed the voucher that won.
    if (err?.code === 11000 && bankLine) {
      const held = await Payment.findOne({ bankLine, status: "posted" }).select("-attachments.data").lean();
      if (held) return { voucher: held, replay: true };
    }
    throw err;
  }
  return { voucher, replay: false };
}

module.exports = {
  upload,
  sellerStateCode,
  readLines,
  priced,
  createVoucher,
};
