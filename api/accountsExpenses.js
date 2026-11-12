"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — EXPENSES  (part of /api/v2/accounts)
//
//  Entered, approved or rejected, paid, cancelled.
//
//    GET   /expenses
//    GET   /expenses/:id
//    POST  /expenses
//    POST  /expenses/:id/approve
//    POST  /expenses/:id/reject
//    POST  /expenses/:id/pay
//    POST  /expenses/:id/cancel
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const mongoose = require("mongoose");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { saveIf, changedMeanwhile } = require("../utils/conditionalSave");
const { isAdmin }      = require("../middleware/auth");
const { escapeRegex }  = require("../utils/escapeRegex");
const { ACTION_CODES } = require("../utils/fingerprint");
const { stateCodeFromGstin } = require("../services/gst");
const { allocate } = require("../services/docNumbers");
const partyLedger  = require("../services/partyLedger");
const costCentres   = require("../services/costCentres");
const aiLedger      = require("../services/aiLedger");
const BankAccount     = require("../models/BankAccount");
const ExpenseCategory = require("../models/ExpenseCategory");
const Expense         = require("../models/Expense");
const Payment         = require("../models/Payment");
const Supplier        = require("../models/Supplier");
const {
  DAY,
  isId,
  readDate,
  reasonFrom,
  fp,
  withTxn,
  paging,
} = require("../services/accountsHelpers");
const settle = require("../services/settle");
const { replayOf, replayAfter } = require("../services/posting");
const { assertOpen } = require("../services/booksLock");
const { sellerStateCode, readLines, priced, prepareVoucher, writeVoucher, voucherAlreadyPosted } = require("./accountsCommon");
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  EXPENSES
// ══════════════════════════════════════════════════════════════════
router.get("/expenses", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.category)) q.category = req.query.category;
  if (isId(req.query.supplier)) q.supplier = req.query.supplier;
  if (range) q.date = range;
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [{ expenseNo: re }, { description: re }, { payeeName: re }, { refNo: re }, { categoryName: re }];
  }
  const [total, expenses, pendingCount] = await Promise.all([
    Expense.countDocuments(q),
    Expense.find(q).select("-attachments.data -lines").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    Expense.countDocuments({ status: "pending" }),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), pendingCount, expenses });
}));

router.get("/expenses/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Expense not found", 404));
  const expense = await Expense.findById(req.params.id).select("-attachments.data").populate("paidFrom", "name kind").lean();
  if (!expense) return next(new ErrorHandler("Expense not found", 404));
  const payments = await Payment.find({ "allocations.doc": expense._id, status: "posted" }).select("voucherNo date amount mode reference accountName").lean();
  res.json({ success: true, expense, payments });
}));

// What an account pays by when the request does not say: the cash box by
// cash, a card by card, a UPI handle by UPI, a bank by transfer.
const MODE_OF = { cash: "cash", card: "card", upi: "upi" };

/**
 * The voucher that pays an expense in full, PREPARED: checked and
 * numbered, nothing written. It is prepared by the one function that
 * prepares any voucher (accountsCommon.prepareVoucher), so paying an
 * expense is held to what every payment is held to: the account and the
 * mode agree, the date is a day the books are open on, the payment risk
 * checks have their say, and the number is drawn for the voucher's own
 * business day. The caller writes it inside its transaction with
 * writeVoucher(), next to whatever else it is doing.
 *
 * (Expenses used to build their own voucher here: a card account was
 * refused, a cash payment could be put through a bank account, the
 * supplier's changed bank account was not asked about, and the number
 * was drawn for the server's clock, not the voucher's date.)
 *
 * @param expense  the expense as it will stand when the voucher is
 *                 written. `pending: true` when that is not what the
 *                 database holds yet: one being created, or approved,
 *                 in the same transaction.
 * @returns what prepareVoucher returns: the prepared voucher, or
 *          { voucher, replay: true } for a request id seen before
 */
async function prepareExpensePayment(expense, { account, mode, reference, date, requestId, confirmRisk, riskNote }, req, { pending = false } = {}) {
  if (!isId(account)) throw new ErrorHandler("Pick the account the money went from", 400);
  const before = await replayOf(Payment, requestId, { select: "-attachments.data" });
  if (before) return { voucher: before, replay: true };
  if (expense.status !== "approved") throw new ErrorHandler(`Only an approved expense can be paid (this one is ${expense.status})`, 409);
  const amount = settle.outstanding("Expense", expense);
  if (amount <= 0) throw new ErrorHandler("Nothing left to pay on this expense", 409);
  const acct = await BankAccount.findById(account).select("kind active").lean();
  if (!acct || !acct.active) throw new ErrorHandler("Pick the account the money went from", 400);
  return prepareVoucher({
    kind: "payment",
    partyType: expense.supplier ? "supplier" : "other", supplier: expense.supplier ? String(expense.supplier) : undefined,
    partyName: expense.payeeName || expense.categoryName || "Expense",
    amount, mode: mode || MODE_OF[acct.kind] || "bank", account: String(account), reference, date,
    allocations: [{ docType: "Expense", doc: String(expense._id), amount }],
    narration: `${expense.categoryName}: ${expense.description}`,
    requestId, confirmRisk, riskNote,
  }, req, { pending: pending ? [expense] : undefined });
}

router.post("/expenses", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  const before = await replayOf(Expense, b.requestId, { select: "-attachments.data" });
  if (before) return res.status(200).json({ success: true, expense: before, replay: true });
  if (!isId(b.category)) return next(new ErrorHandler("category is required", 400));
  const category = await ExpenseCategory.findById(b.category).lean();
  if (!category) return next(new ErrorHandler("Category not found", 404));
  const description = String(b.description || "").trim();
  if (!description) return next(new ErrorHandler("description is required", 400));
  let date, lines, dueDate;
  try {
    date = readDate(b.date, "date", new Date());
    await assertOpen(date, req);
    // A plain amount is one line; itemised bills send lines.
    const raw = Array.isArray(b.lines) && b.lines.length ? b.lines : [{ description, quantity: 1, rate: b.amount, gstPercent: b.gstPercent ?? 0 }];
    lines = readLines(raw, { defaultGst: 0 });
  } catch (err) { return next(err); }
  let supplier = null;
  if (b.supplier) {
    if (!isId(b.supplier)) return next(new ErrorHandler("supplier is not an id", 400));
    supplier = await Supplier.findById(b.supplier).lean();
    if (!supplier) return next(new ErrorHandler("Supplier not found", 404));
  }
  try {
    dueDate = readDate(b.dueDate, "dueDate", new Date(date.getTime() + (supplier ? (supplier.paymentTermsDays ?? 30) : 0) * DAY));
  } catch (err) { return next(err); }
  const payeeGstin = String(b.payeeGstin || supplier?.gstin || "").trim().toUpperCase();
  const p = priced(lines, await sellerStateCode(), stateCodeFromGstin(payeeGstin));
  const itcEligible = b.itcEligible === undefined ? !!category.itcEligible && p.totals.tax > 0 : !!b.itcEligible;
  const needsApproval = category.approvalAbove === 0 || p.totals.grand > category.approvalAbove;

  let costCentre;
  try { costCentre = await costCentres.read(b.costCentre); } catch (err) { return next(err); }

  const { financialYear, sequence, number } = await allocate(Expense, "EXP", { at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, expenseNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined,
    date, dueDate, category: category._id, categoryName: category.name, description: description.slice(0, 200),
    supplier: supplier?._id, payeeName: String(b.payeeName || supplier?.name || "").trim().slice(0, 120), payeeGstin,
    refNo: String(b.refNo || "").trim().slice(0, 40),
    ...(costCentre ? { costCentre } : {}),
    supplyType: p.supplyType, lines: p.lines, totals: p.totals,
    itc: { eligible: itcEligible, amount: itcEligible ? p.totals.tax : 0 },
    status: needsApproval ? "pending" : "approved",
    approval: { required: needsApproval },
    submittedBy: req.user?._id, submittedByName: req.user?.name || "",
    notes: String(b.notes || "").trim().slice(0, 500), source: b.source === "scan" ? "scan" : "manual",
    aiSuggestion: isId(b.aiSuggestion) ? b.aiSuggestion : undefined,
    fingerprints: [fp(ACTION_CODES.EXPENSE_SUBMITTED, { _id }, req, { expenseNo: number, category: category.name, grand: p.totals.grand, needsApproval })],
  };
  let voucher = null;
  const payNow = b.payNow && !needsApproval ? b.payNow : null;
  if (payNow && !isId(payNow.account)) return next(new ErrorHandler("payNow.account is required", 400));
  // Paid on the spot (petty cash, UPI from the phone): the voucher
  // comes with it — but only once it needs no approval. Prepared here,
  // against the expense as it is about to be stored, and written with it.
  let payment = null;
  if (payNow) {
    try {
      payment = await prepareExpensePayment(data, { account: payNow.account, mode: payNow.mode, reference: payNow.reference, date, confirmRisk: payNow.confirmRisk, riskNote: payNow.riskNote }, req, { pending: true });
    } catch (err) { return next(err); }
  }
  try {
    await withTxn(async (session) => {
      await Expense.create([data], { session });
      if (!needsApproval && supplier) {
        await partyLedger.post({ partyType: "supplier", party: supplier._id, date, docType: "Expense", doc: _id, docNo: number, credit: p.totals.grand, narration: `${category.name}: ${description}` }, session);
      }
      if (payment) voucher = await writeVoucher(payment, req, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    const dup = await replayAfter(err, Expense, b.requestId, { select: "-attachments.data" });
    if (dup) return res.status(200).json({ success: true, expense: dup, replay: true });
    throw err;
  }
  const expense = await Expense.findById(_id).select("-attachments.data").lean();
  if (data.aiSuggestion) {
    aiLedger.settle(data.aiSuggestion, {
      accepted: { supplierGstin: payeeGstin, billNo: data.refNo, billDate: date.toISOString().slice(0, 10), lines: data.lines.map((l) => ({ description: l.description, quantity: l.quantity, rate: l.rate, gstPercent: l.gstPercent })), totals: { taxable: data.totals.taxable, grand: data.totals.grand } },
      decidedBy: req.user?._id, expectSurface: "bill-ocr", ignoreMissing: true,
    }).catch(() => {});
    await require("../services/billImages").link(data.aiSuggestion, { docType: "Expense", docId: expense._id, docNo: expense.expenseNo, partyName: expense.payeeName || expense.categoryName, amount: expense.totals?.grand, date: expense.date });
  }
  res.status(201).json({ success: true, expense, voucher: voucher ? { _id: voucher._id, voucherNo: voucher.voucherNo } : null });
}));

async function loadExpense(req, next) {
  if (!isId(req.params.id)) { next(new ErrorHandler("Expense not found", 404)); return null; }
  const e = await Expense.findById(req.params.id);
  if (!e) { next(new ErrorHandler("Expense not found", 404)); return null; }
  return e;
}

router.post("/expenses/:id/approve", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  if (e.status !== "pending") return next(new ErrorHandler(`This expense is ${e.status}, not waiting for approval`, 409));
  if (String(e.submittedBy || "") === String(req.user?._id || "") && req.user?.role !== "admin") {
    return next(new ErrorHandler("An expense is approved by someone other than the person who entered it", 403));
  }
  const approval = { required: true, by: req.user?._id, byName: req.user?.name || "", at: new Date(), note: String(req.body?.note || "").trim().slice(0, 200) };
  const mark = fp(ACTION_CODES.EXPENSE_APPROVED, e, req, { expenseNo: e.expenseNo, grand: e.totals.grand });
  let voucher = null;
  const payNow = req.body?.payNow?.account ? req.body.payNow : null;
  if (payNow && !isId(payNow.account)) return next(new ErrorHandler("payNow.account is required", 400));
  // Approved and paid in one go: the voucher is prepared against the
  // expense as it will stand once approved, dated today (the business
  // day, which is also the day its number is drawn for).
  let payment = null;
  if (payNow) {
    try {
      payment = await prepareExpensePayment({ ...e.toObject(), status: "approved" }, { account: payNow.account, mode: payNow.mode, reference: payNow.reference, confirmRisk: payNow.confirmRisk, riskNote: payNow.riskNote }, req, { pending: true });
    } catch (err) { return next(err); }
  }
  try {
    await withTxn(async (session) => {
      // Approved only while it is still waiting: the check above was
      // made on a copy read before this transaction, and a rejection
      // landing in between used to be written over, and posted.
      const waiting = await Expense.updateOne({ _id: e._id, status: "pending" }, { $set: { status: "approved", approval }, $push: { fingerprints: mark } }, { session });
      if (waiting.matchedCount === 0) throw changedMeanwhile(`Expense ${e.expenseNo}`, "approved or rejected");
      if (e.supplier) {
        await partyLedger.post({ partyType: "supplier", party: e.supplier, date: e.date, docType: "Expense", doc: e._id, docNo: e.expenseNo, credit: e.totals.grand, narration: `${e.categoryName}: ${e.description}` }, session);
      }
      if (payment) voucher = await writeVoucher(payment, req, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, expense: await Expense.findById(e._id).select("-attachments.data").lean(), voucher: voucher ? { _id: voucher._id, voucherNo: voucher.voucherNo } : null });
}));

router.post("/expenses/:id/reject", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  if (e.status !== "pending") return next(new ErrorHandler(`This expense is ${e.status}, not waiting for approval`, 409));
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  e.status = "rejected";
  e.approval = { required: true, by: req.user?._id, byName: req.user?.name || "", at: new Date(), note: reason };
  e.fingerprints.push(fp(ACTION_CODES.EXPENSE_REJECTED, e, req, { expenseNo: e.expenseNo, reason }));
  // Saved only while it is still waiting. Approved by somebody else in
  // the moment between the check above and here — and perhaps paid with
  // it — this used to write "rejected" over an expense already in the
  // books.
  if (!(await saveIf(e, { status: "pending" }))) {
    return next(changedMeanwhile(`Expense ${e.expenseNo}`, "approved or rejected"));
  }
  res.json({ success: true, expense: e.toObject() });
}));

router.post("/expenses/:id/pay", catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  const b = req.body || {};
  if (!isId(b.account)) return next(new ErrorHandler("account is required", 400));
  // The same request sent twice (a double tap, a retry on a slow line)
  // is answered with the voucher the first one made.
  const answer = async (voucher, replay) => res.json({ success: true, expense: await Expense.findById(e._id).select("-attachments.data").lean(), voucher: { _id: voucher._id, voucherNo: voucher.voucherNo }, ...(replay ? { replay: true } : {}) });
  let payment;
  try {
    payment = await prepareExpensePayment(e.toObject(), { account: b.account, mode: b.mode, reference: b.reference, date: b.date, requestId: b.requestId, confirmRisk: b.confirmRisk, riskNote: b.riskNote }, req);
  } catch (err) { return next(err); }
  if (payment.replay) return answer(payment.voucher, true);
  let voucher;
  try {
    await withTxn(async (session) => { voucher = await writeVoucher(payment, req, session); });
  } catch (err) {
    const dup = await voucherAlreadyPosted(err, payment);
    if (dup) return answer(dup, true);
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  return answer(voucher, false);
}));

router.post("/expenses/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  const e = await loadExpense(req, next);
  if (!e) return;
  if (e.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  if (e.paidAmount > 0) return next(new ErrorHandler("This expense has been paid — cancel the payment voucher first.", 409));
  let reason;
  try { reason = reasonFrom(req); await assertOpen(e.date, req, { cancelling: true }); } catch (err) { return next(err); }
  const mark = fp(ACTION_CODES.EXPENSE_CANCELLED, e, req, { expenseNo: e.expenseNo, reason });
  try {
    await withTxn(async (session) => {
      const r = await Expense.updateOne(
        { _id: e._id, status: { $ne: "cancelled" }, $or: [{ paidAmount: { $lte: 0 } }, { paidAmount: null }] },
        { $set: { status: "cancelled" }, $push: { fingerprints: mark } }, { session }
      );
      if (r.matchedCount === 0) throw new ErrorHandler("This expense was paid meanwhile — cancel the payment voucher first.", 409);
      await partyLedger.reverse("Expense", e._id, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, expense: await Expense.findById(e._id).select("-attachments.data").lean() });
}));

module.exports = router;
