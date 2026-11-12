"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — REPORTS  (part of /api/v2/accounts)
//
//    GET  /reports/gst
//    GET  /reports/tds
//    GET  /reports/expenses
//    GET  /reports/cashbook
//    GET  /reports/daybook
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const cal = require("../utils/bizDates");
const tdsBooks = require("../services/tds");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const BankAccount     = require("../models/BankAccount");
const ExpenseCategory = require("../models/ExpenseCategory");
const SupplierBill    = require("../models/SupplierBill");
const Expense         = require("../models/Expense");
const AccountNote     = require("../models/AccountNote");
const Payment         = require("../models/Payment");
const Contra          = require("../models/Contra");
const Invoice         = require("../models/Invoice");
const { DAY, isId, r2, readDate } = require("../services/accountsHelpers");
const gstSummary = require("../services/gstSummary");
const bankBalances = require("../services/bankBalances");
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════════════
function rangeOf(req) {
  // From the first of this month to today, by the books' calendar, unless asked otherwise.
  const from = readDate(req.query.from, "from") || cal.monthRange(cal.monthKey()).from;
  let to = readDate(req.query.to, "to") || cal.today();
  to = new Date(to.getTime() + DAY - 1);
  return { from, to };
}

/** Output tax from sales, input credit from purchases and expenses, by rate. */
router.get("/reports/gst", catchAsyncErrors(async (req, res, next) => {
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  res.json({ success: true, ...(await gstSummary.summary({ from: r.from, to: r.to })) });
}));

/** What was deducted, from whom, under which section. */
router.get("/reports/tds", catchAsyncErrors(async (req, res, next) => {
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  const vouchers = await Payment.find({ status: "posted", kind: "payment", "tds.amount": { $gt: 0 }, date: { $gte: r.from, $lte: r.to } })
    .select("voucherNo date supplier partyName amount tds allocations").sort({ date: 1 }).lean();
  const byDeductee = new Map();
  // Section by section: a voucher that paid bills under two sections is in both (services/tds.js sectionsOf).
  for (const v of vouchers) {
    const parts = tdsBooks.sectionsOf(v);
    for (const part of parts) {
      const key = `${v.supplier || v.partyName}|${part.section}|${part.rate}`;
      const g = byDeductee.get(key) || { supplier: v.supplier, partyName: v.partyName, section: part.section, rate: part.rate, gross: 0, base: 0, tds: 0, vouchers: [] };
      // What was paid with this part's tax: the whole voucher when it has one section, else this part's documents.
      const gross = parts.length === 1 ? r2(v.amount + v.tds.amount) : r2((v.allocations || []).filter((a) => a.tds > 0 && (a.section || "") === part.section && (a.rate || 0) === part.rate).reduce((t, a) => t + a.amount, 0));
      g.gross = r2(g.gross + gross); g.base = r2(g.base + part.base); g.tds = r2(g.tds + part.tds);
      g.vouchers.push({ _id: v._id, voucherNo: v.voucherNo, date: v.date, gross, base: part.base, tds: part.tds, docs: part.docs });
      byDeductee.set(key, g);
    }
  }
  const rows = [...byDeductee.values()];
  res.json({ success: true, from: r.from, to: r.to, rows, total: { gross: r2(rows.reduce((s, g) => s + g.gross, 0)), base: r2(rows.reduce((s, g) => s + g.base, 0)), tds: r2(rows.reduce((s, g) => s + g.tds, 0)) } });
}));

router.get("/reports/expenses", catchAsyncErrors(async (req, res, next) => {
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  const rows = await Expense.aggregate([
    { $match: { status: { $in: ["approved", "paid"] }, date: { $gte: r.from, $lte: r.to } } },
    { $group: { _id: "$category", categoryName: { $first: "$categoryName" }, amount: { $sum: "$totals.grand" }, taxable: { $sum: "$totals.taxable" }, itc: { $sum: "$itc.amount" }, count: { $sum: 1 }, paid: { $sum: "$paidAmount" } } },
    { $sort: { amount: -1 } },
  ]);
  const bills = await SupplierBill.aggregate([
    { $match: { status: { $ne: "cancelled" }, kind: "service", billDate: { $gte: r.from, $lte: r.to } } },
    { $group: { _id: "$category", amount: { $sum: "$totals.grand" }, count: { $sum: 1 } } },
  ]);
  const cats = await ExpenseCategory.find({}).select("name").lean();
  const name = new Map(cats.map((c) => [String(c._id), c.name]));
  res.json({
    success: true, from: r.from, to: r.to,
    rows: rows.map((x) => ({ category: x._id, categoryName: x.categoryName || name.get(String(x._id)) || "—", amount: r2(x.amount), taxable: r2(x.taxable), itc: r2(x.itc), count: x.count, unpaid: r2(x.amount - x.paid) })),
    serviceBills: bills.map((x) => ({ category: x._id, categoryName: name.get(String(x._id)) || "Uncategorised", amount: r2(x.amount), count: x.count })),
    total: r2(rows.reduce((s, x) => s + x.amount, 0)),
  });
}));

/** The cash / bank book for one account: every voucher with a running balance. */
router.get("/reports/cashbook", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.query.account)) return next(new ErrorHandler("account is required", 400));
  const account = await BankAccount.findById(req.query.account).lean();
  if (!account) return next(new ErrorHandler("Account not found", 404));
  let r;
  try { r = rangeOf(req); } catch (err) { return next(err); }
  const opening = await bankBalances.balanceBefore(account, r.from);
  const [vouchers, contras] = await Promise.all([
    Payment.find({ status: "posted", account: account._id, date: { $gte: r.from, $lte: r.to } })
      .select("kind voucherNo date partyName amount mode reference narration allocations clearedOn createdAt").lean(),
    Contra.find({ status: "posted", $or: [{ from: account._id }, { to: account._id }], date: { $gte: r.from, $lte: r.to } }).lean(),
  ]);
  // A contra is a row like a voucher: in when the money came to this account.
  const moves = [
    ...vouchers.map((v) => ({ ...v, docType: "Payment", inflow: v.kind === "receipt" ? v.amount : 0, outflow: v.kind === "payment" ? v.amount : 0 })),
    ...contras.map((c) => {
      const incoming = String(c.to) === String(account._id);
      return { _id: c._id, docType: "Contra", kind: "contra", voucherNo: c.contraNo, date: c.date, createdAt: c.createdAt, partyName: incoming ? `From ${c.fromName}` : `To ${c.toName}`, amount: c.amount, mode: c.mode, reference: c.reference, narration: c.narration, allocations: [], clearedOn: incoming ? c.toClearedOn : c.fromClearedOn, inflow: incoming ? c.amount : 0, outflow: incoming ? 0 : c.amount };
    }),
  ].sort((a, b) => new Date(a.date) - new Date(b.date) || new Date(a.createdAt) - new Date(b.createdAt));
  let running = opening;
  const rows = moves.map((v) => {
    running = r2(running + v.inflow - v.outflow);
    return { ...v, balance: running };
  });
  res.json({ success: true, account: { _id: account._id, name: account.name, kind: account.kind }, from: r.from, to: r.to, opening, rows, closing: running,
    inflow: r2(rows.reduce((s, x) => s + x.inflow, 0)), outflow: r2(rows.reduce((s, x) => s + x.outflow, 0)) });
}));

/** Everything dated one day. */
router.get("/reports/daybook", catchAsyncErrors(async (req, res, next) => {
  let day;
  try { day = readDate(req.query.date, "date", new Date()); } catch (err) { return next(err); }
  const from = day;   // a document date is its day's UTC midnight
  const to = new Date(from.getTime() + DAY - 1);
  const range = { $gte: from, $lte: to };
  const [invoices, bills, expenses, notes, payments] = await Promise.all([
    Invoice.find({ status: "issued", invoiceDate: range }).select("invoiceNumber buyer.name totals.grand orderNo").lean(),
    SupplierBill.find({ status: { $ne: "cancelled" }, billDate: range }).select("billNo supplierName supplierBillNo totals.grand").lean(),
    Expense.find({ status: { $ne: "cancelled" }, date: range }).select("expenseNo categoryName description payeeName totals.grand status").lean(),
    AccountNote.find({ status: "issued", date: range }).select("kind noteNo partyName totals.grand against.docNo reason").lean(),
    Payment.find({ status: "posted", date: range }).select("kind voucherNo partyName amount mode accountName tds.amount allocations.docNo").lean(),
  ]);
  res.json({ success: true, date: from, invoices, bills, expenses, notes, payments,
    totals: {
      sales: r2(invoices.reduce((s, x) => s + (x.totals?.grand || 0), 0)), purchases: r2(bills.reduce((s, x) => s + (x.totals?.grand || 0), 0)),
      expenses: r2(expenses.reduce((s, x) => s + (x.totals?.grand || 0), 0)),
      received: r2(payments.filter((p) => p.kind === "receipt").reduce((s, x) => s + x.amount, 0)),
      paid: r2(payments.filter((p) => p.kind === "payment").reduce((s, x) => s + x.amount, 0)),
    } });
}));

module.exports = router;
