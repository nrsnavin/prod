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
  businessDay,
  reasonFrom,
  fp,
  withTxn,
  paging,
} = require("../services/accountsHelpers");
const settle = require("../services/settle");
const { assertOpen } = require("../services/booksLock");
const { sellerStateCode, readLines, priced } = require("./accountsCommon");
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

/** The voucher that pays an expense, inside the caller's transaction. */
//
// The voucher number is drawn BEFORE the transaction (payVoucherNo) —
// withTransaction retries a transient conflict by running the callback
// again, and a number drawn inside it would be burnt on every retry.
async function payVoucherNo(when) { return allocate(Payment, "PAY", { extra: { kind: "payment" }, at: when || new Date() }); }

async function payExpense(expenseId, { account, mode, reference, date, req, voucherNo }, session) {
  const expense = await Expense.findById(expenseId).session(session);
  if (!expense) throw new ErrorHandler("Expense not found", 404);
  const acct = await BankAccount.findById(account).session(session);
  if (!acct || !acct.active) throw new ErrorHandler("Pick the account the money went from", 400);
  const amount = expense.outstanding();
  if (amount <= 0) throw new ErrorHandler("Nothing left to pay on this expense", 409);
  const when = date || new Date();
  const { financialYear, sequence, number } = voucherNo;
  if (expense.status !== "approved") throw new ErrorHandler(`Only an approved expense can be paid (this one is ${expense.status})`, 409);
  if (mode !== undefined && mode !== null && mode !== "" && !["cash", "bank", "upi", "cheque"].includes(mode)) throw new ErrorHandler("mode must be cash, bank, upi or cheque", 400);
  const partyType = expense.supplier ? "supplier" : "other";
  const vId = new mongoose.Types.ObjectId();
  const voucherData = {
    _id: vId, kind: "payment", voucherNo: number, financialYear, sequence, date: when,
    partyType, supplier: expense.supplier || undefined, partyName: expense.payeeName || expense.categoryName || "Expense",
    amount, mode: mode || (acct.kind === "cash" ? "cash" : acct.kind === "upi" ? "upi" : "bank"), account: acct._id, accountName: acct.name,
    reference: String(reference || "").trim().slice(0, 60),
    allocations: [{ docType: "Expense", doc: expense._id, docNo: expense.expenseNo, amount, tds: 0 }],
    unallocated: 0, narration: `${expense.categoryName}: ${expense.description}`, createdBy: req.user?._id,
    fingerprints: [fp(ACTION_CODES.PAYMENT_POSTED, { _id: vId }, req, { voucherNo: number, amount, expense: expense.expenseNo })],
  };
  const [voucher] = await Payment.create([voucherData], { session });
  await settle.apply("Expense", expense._id, { paidAmount: amount }, session, { docNo: expense.expenseNo, extraSet: { paidFrom: acct._id, paidAt: when } });
  await Expense.updateOne({ _id: expense._id }, { $push: { fingerprints: fp(ACTION_CODES.EXPENSE_PAID, expense, req, { voucherNo: number, amount, account: acct.name }) } }, { session });
  if (expense.supplier) {
    await partyLedger.post({ partyType: "supplier", party: expense.supplier, date: when, docType: "Payment", doc: vId, docNo: number, debit: amount, narration: voucherData.narration }, session);
  }
  return voucher;
}

router.post("/expenses", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (b.requestId) {
    const dup = await Expense.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
    if (dup) return res.status(200).json({ success: true, expense: dup, replay: true });
  }
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
  const payNo = payNow ? await payVoucherNo(date) : null;
  try {
    await withTxn(async (session) => {
      await Expense.create([data], { session });
      if (!needsApproval && supplier) {
        await partyLedger.post({ partyType: "supplier", party: supplier._id, date, docType: "Expense", doc: _id, docNo: number, credit: p.totals.grand, narration: `${category.name}: ${description}` }, session);
      }
      // Paid on the spot (petty cash, UPI from the phone): the voucher
      // comes with it — but only once it needs no approval.
      if (payNow) {
        voucher = await payExpense(_id, { account: payNow.account, mode: payNow.mode, reference: payNow.reference, date, req, voucherNo: payNo }, session);
      }
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    if (err?.code === 11000 && b.requestId) {
      const dup = await Expense.findOne({ requestId: String(b.requestId) }).select("-attachments.data").lean();
      if (dup) return res.status(200).json({ success: true, expense: dup, replay: true });
    }
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
  const payNo = payNow ? await payVoucherNo(new Date()) : null;
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
      if (payNow) {
        voucher = await payExpense(e._id, { account: payNow.account, mode: payNow.mode, reference: payNow.reference, date: businessDay(new Date()), req, voucherNo: payNo }, session);
      }
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
  if (e.status !== "approved") return next(new ErrorHandler(`Only an approved expense can be paid (this one is ${e.status})`, 409));
  if (!isId(req.body?.account)) return next(new ErrorHandler("account is required", 400));
  let date;
  try { date = readDate(req.body?.date, "date", new Date()); await assertOpen(date, req); } catch (err) { return next(err); }
  let voucher;
  const payNo = await payVoucherNo(date);
  try {
    await withTxn(async (session) => {
      voucher = await payExpense(e._id, { account: req.body.account, mode: req.body.mode, reference: req.body.reference, date, req, voucherNo: payNo }, session);
    });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, expense: await Expense.findById(e._id).select("-attachments.data").lean(), voucher: { _id: voucher._id, voucherNo: voucher.voucherNo } });
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
