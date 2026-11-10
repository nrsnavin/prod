"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — RECEIPTS AND PAYMENTS, CREDITS, LEDGERS  (part of /api/v2/accounts)
//
//  Vouchers with their allocations and TDS, credits applied to
//  documents, a party's statement, who owes what, and the overview.
//
//    GET   /payments/open-docs
//    GET   /payments
//    GET   /payments/:id
//    POST  /payments
//    POST  /payments/:id/cancel
//    GET   /credits
//    POST  /credits/apply
//    GET   /statement
//    GET   /outstanding
//    GET   /overview
//    POST  /ledger/rebuild
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAdmin }      = require("../middleware/auth");
const { escapeRegex }  = require("../utils/escapeRegex");
const partyLedger  = require("../services/partyLedger");
const outstanding  = require("../services/outstanding");
const { ensureSeed } = require("../services/accountsSeed");
const { cancelVoucher } = require("../services/voucherCancel");
const aiLedger      = require("../services/aiLedger");
const BankAccount     = require("../models/BankAccount");
const SupplierBill    = require("../models/SupplierBill");
const Expense         = require("../models/Expense");
const Payment         = require("../models/Payment");
const Invoice         = require("../models/Invoice");
const Supplier        = require("../models/Supplier");
const Customer        = require("../models/Customer");
const { DAY, isId, r2, readDate, reasonFrom, paging } = require("../services/accountsHelpers");
const credits = require("../services/credits");
const bankBalances = require("../services/bankBalances");
const { createVoucher } = require("./accountsCommon");
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  RECEIPTS AND PAYMENTS
// ══════════════════════════════════════════════════════════════════

/** The open documents a voucher for this party could settle, and the credits it has. */
router.get("/payments/open-docs", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.query.partyType;
  if (!isId(req.query.party)) return next(new ErrorHandler("party is required", 400));
  if (partyType !== "customer" && partyType !== "supplier") return next(new ErrorHandler("partyType must be customer or supplier", 400));
  const rows = partyType === "customer" ? await outstanding.receivables({ customer: req.query.party }) : await outstanding.payables({ supplier: req.query.party });
  const balance = (await partyLedger.balances(partyType, [req.query.party])).get(String(req.query.party)) || 0;
  res.json({ success: true, docs: rows, balance, credits: await credits.openFor(partyType, req.query.party) });
}));

router.get("/payments", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip, range } = paging(req);
  const q = {};
  if (req.query.kind === "receipt" || req.query.kind === "payment") q.kind = req.query.kind;
  if (req.query.status && req.query.status !== "all") q.status = String(req.query.status);
  if (isId(req.query.customer)) q.customer = req.query.customer;
  if (isId(req.query.supplier)) q.supplier = req.query.supplier;
  if (isId(req.query.account)) q.account = req.query.account;
  if (range) q.date = range;
  const search = String(req.query.search || "").trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), "i");
    q.$or = [{ voucherNo: re }, { partyName: re }, { reference: re }, { narration: re }, { "allocations.docNo": re }];
  }
  const [total, payments] = await Promise.all([
    Payment.countDocuments(q),
    Payment.find(q).select("-attachments.data").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), payments });
}));

router.get("/payments/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Voucher not found", 404));
  const payment = await Payment.findById(req.params.id).select("-attachments.data").lean();
  if (!payment) return next(new ErrorHandler("Voucher not found", 404));
  res.json({ success: true, payment });
}));

router.post("/payments", catchAsyncErrors(async (req, res, next) => {
  let out;
  try { out = await createVoucher(req.body || {}, req); } catch (err) { if (err instanceof ErrorHandler) return next(err); throw err; }
  const v = out.voucher.toObject ? out.voucher.toObject() : out.voucher;
  // Entered from a payment advice: what was kept of the reading scores it.
  if (!out.replay && isId(req.body?.adviceSuggestion)) {
    aiLedger.settle(req.body.adviceSuggestion, {
      accepted: { amount: v.amount, date: new Date(v.date).toISOString().slice(0, 10), reference: v.reference || "", invoices: (v.allocations || []).filter((a) => a.docType === "Invoice").map((a) => a.docNo), tds: (v.adjustments || []).filter((a) => a.kind === "tds_by_customer").reduce((s, a) => s + a.amount, 0) },
      decidedBy: req.user?._id, expectSurface: "payment-advice", ignoreMissing: true,
    }).catch(() => {});
  }
  res.status(out.replay ? 200 : 201).json({ success: true, payment: v, ...(out.replay ? { replay: true } : {}) });
}));

router.post("/payments/:id/cancel", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Voucher not found", 404));
  const v = await Payment.findById(req.params.id).lean();
  if (!v) return next(new ErrorHandler("Voucher not found", 404));
  if (v.status === "cancelled") return next(new ErrorHandler("Already cancelled", 409));
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  let payment;
  try { payment = await cancelVoucher(v, reason, req); } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.json({ success: true, payment });
}));

// ══════════════════════════════════════════════════════════════════
//  CREDITS: ADVANCES, UNAPPLIED NOTES, OPENING ADVANCES
// ══════════════════════════════════════════════════════════════════
//  GET  /credits?partyType=&party=   what a party has on account
//  POST /credits/apply               set some of it against open documents
router.get("/credits", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.query.partyType;
  if (partyType !== "customer" && partyType !== "supplier") return next(new ErrorHandler("partyType must be customer or supplier", 400));
  if (!isId(req.query.party)) return next(new ErrorHandler("party is required", 400));
  res.json({ success: true, credits: await credits.openFor(partyType, req.query.party) });
}));

router.post("/credits/apply", catchAsyncErrors(async (req, res, next) => {
  try {
    const out = await credits.apply(req.body || {}, req);
    res.json({ success: true, ...out });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
}));

// ══════════════════════════════════════════════════════════════════
//  LEDGERS AND OVERVIEW
// ══════════════════════════════════════════════════════════════════
router.get("/statement", catchAsyncErrors(async (req, res, next) => {
  const partyType = req.query.partyType;
  if (!["customer", "supplier"].includes(partyType)) return next(new ErrorHandler("partyType must be customer or supplier", 400));
  if (!isId(req.query.party)) return next(new ErrorHandler("party is required", 400));
  let from, to;
  try {
    from = readDate(req.query.from, "from");
    to = readDate(req.query.to, "to");
    if (to) to = new Date(to.getTime() + DAY - 1);
  } catch (err) { return next(err); }
  const Model = partyType === "customer" ? Customer : Supplier;
  const party = await Model.findById(req.query.party).select("name gstin").lean();
  if (!party) return next(new ErrorHandler("Party not found", 404));
  // The ledger account as Tally prints it: particulars, voucher type, references, totals, Dr/Cr.
  const s = await require("../services/partyStatement").ledgerAccount(partyType, party._id, { from, to });
  const open = partyType === "customer" ? await outstanding.receivables({ customer: party._id }) : await outstanding.payables({ supplier: party._id });
  res.json({ success: true, party: { _id: party._id, name: party.name, gstin: party.gstin || "" }, partyType, ...s, open: outstanding.totals(open) });
}));

router.get("/outstanding", catchAsyncErrors(async (req, res, next) => {
  const type = req.query.type === "payable" ? "payable" : req.query.type === "receivable" ? "receivable" : null;
  if (!type) return next(new ErrorHandler("type must be receivable or payable", 400));
  const party = isId(req.query.party) ? req.query.party : undefined;
  const rows = type === "receivable" ? await outstanding.receivables({ customer: party }) : await outstanding.payables({ supplier: party });
  res.json({ success: true, type, rows, byParty: outstanding.byParty(rows), totals: outstanding.totals(rows), buckets: outstanding.BUCKETS });
}));

router.get("/overview", catchAsyncErrors(async (_req, res) => {
  await ensureSeed();
  const now = new Date();
  // The first days of a month are spent finishing the last one: until the
  // 10th, the month figures are last month's.
  const back = now.getDate() < 10 ? 1 : 0;
  const monthStart = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() - back + 1, 0, 23, 59, 59, 999);
  const inMonth = { $gte: monthStart, $lte: monthEnd };
  const [recv, pay, accounts, pendingExpenses, monthExpenses, monthInvoices, monthBills, recentPayments] = await Promise.all([
    outstanding.receivables(),
    outstanding.payables(),
    BankAccount.find({ active: true }).lean(),
    Expense.countDocuments({ status: "pending" }),
    Expense.aggregate([{ $match: { status: { $in: ["approved", "paid"] }, date: inMonth } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } }]),
    Invoice.aggregate([{ $match: { status: "issued", invoiceDate: inMonth } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, tax: { $sum: "$totals.tax" }, count: { $sum: 1 } } }]),
    SupplierBill.aggregate([{ $match: { status: { $ne: "cancelled" }, billDate: inMonth } }, { $group: { _id: null, amount: { $sum: "$totals.grand" }, itc: { $sum: "$itc.amount" }, count: { $sum: 1 } } }]),
    Payment.find({ status: "posted" }).select("kind voucherNo date partyName amount mode accountName").sort({ date: -1, createdAt: -1 }).limit(8).lean(),
  ]);
  const [balances, customerCredits, supplierCredits] = await Promise.all([
    bankBalances.withBalances(accounts), credits.byParty("customer"), credits.byParty("supplier"),
  ]);
  // What a party paid ahead, or was paid ahead, sits beside what is open:
  // the documents stay open until the credit is set against them.
  const withAhead = (groups, map) => groups.map((g) => ({ ...g, paidAhead: map.get(String(g.party))?.available || 0 }));
  const aheadTotal = (rows, map) => { const parties = new Set(rows.map((x) => String(x.party))); return r2([...map.entries()].filter(([k]) => parties.has(k)).reduce((s, [, v]) => s + v.available, 0)); };
  res.json({
    success: true,
    receivables: { ...outstanding.totals(recv), paidAhead: aheadTotal(recv, customerCredits), top: withAhead(outstanding.byParty(recv).slice(0, 5), customerCredits) },
    payables: { ...outstanding.totals(pay), paidAhead: aheadTotal(pay, supplierCredits), top: withAhead(outstanding.byParty(pay).slice(0, 5), supplierCredits) },
    accounts: balances.map((a) => ({ _id: a._id, name: a.name, kind: a.kind, balance: a.balance })),
    pendingExpenses,
    month: {
      from: monthStart, to: monthEnd, current: back === 0,
      expenses: { amount: r2(monthExpenses[0]?.amount || 0), count: monthExpenses[0]?.count || 0 },
      sales: { amount: r2(monthInvoices[0]?.amount || 0), outputTax: r2(monthInvoices[0]?.tax || 0), count: monthInvoices[0]?.count || 0 },
      purchases: { amount: r2(monthBills[0]?.amount || 0), inputCredit: r2(monthBills[0]?.itc || 0), count: monthBills[0]?.count || 0 },
    },
    recentPayments,
  });
}));

router.post("/ledger/rebuild", isAdmin("admin"), catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, rows: await partyLedger.rebuild() });
}));

module.exports = router;
