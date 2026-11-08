"use strict";
// ══════════════════════════════════════════════════════════════════
//  INBOX, INSIGHTS, RECURRING, EXPORTS  (inside /api/v2/accounts)
//
//    GET  /inbox                  what needs someone today
//    POST /bills/check            flags on a bill before it is saved
//    POST /expenses/check         flags on an expense before it is saved
//    GET  /suggest/category       the likeliest head for an expense
//    GET  /forecast?weeks=6       cash in the coming weeks
//    GET  /close?month=YYYY-MM    what is left before the month closes
//    GET  /ai/stats               how often the AI drafts are kept as read
//    /recurring                   recurring expenses (list, add, edit, run)
//    GET  /export/:what           any list or report as Excel
// ══════════════════════════════════════════════════════════════════

const factoryDay = require("../utils/factoryDay");
const express = require("express");
const ExcelJS = require("exceljs");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAdmin } = require("../middleware/auth");
const { isId, r2, readDate, DAY } = require("../services/accountsHelpers");
const insights = require("../services/accountsInsights");
const recurring = require("../services/recurring");
const outstanding = require("../services/outstanding");
const collections = require("../services/collections");
const aiLedger = require("../services/aiLedger");

const SupplierBill = require("../models/SupplierBill");
const Expense = require("../models/Expense");
const Payment = require("../models/Payment");
const AccountNote = require("../models/AccountNote");
const BankStatement = require("../models/BankStatement");
const RecurringExpense = require("../models/RecurringExpense");
const ExpenseCategory = require("../models/ExpenseCategory");
const Supplier = require("../models/Supplier");
const msme = require("../services/msme");
const MachineServiceBill = require("../models/MachineServiceBill");

const ACCOUNTS_SURFACES = ["bill-ocr", "bank-statement-match", "collection-reminder"];

// ── The inbox ──────────────────────────────────────────────────────
router.get("/inbox", catchAsyncErrors(async (req, res) => {
  // Recurring expenses fall due as the inbox is opened.
  for (let i = 0; i < 12; i++) { if (!(await recurring.runDue()).length) break; }
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * DAY);
  const mine = String(req.user?._id || "");
  const canApprove = ["admin", "accounts"].includes(req.user?.role);
  const [payables, pendingExpenses, claimsToPay, varianceBills, statements, chase, promisesDue, msmeDues] = await Promise.all([
    outstanding.payables(),
    Expense.find({ status: "pending" }).select("expenseNo date categoryName description totals.grand submittedBy submittedByName source").sort({ date: 1 }).limit(50).lean(),
    Expense.find({ status: "approved", source: "claim" }).select("expenseNo date description payeeName totals.grand paidAmount").sort({ date: 1 }).limit(20).lean(),
    SupplierBill.find({ status: { $in: ["open", "part_paid"] }, "variance.total": { $gt: 0 }, billDate: { $gte: new Date(now.getTime() - 60 * DAY) } }).select("billNo supplierName variance.total variance.note billDate").sort({ billDate: -1 }).limit(10).lean(),
    // Every statement of the last 90 days: a line counts as placed when any
    // upload of it was placed, since the same line comes again in the next one.
    BankStatement.find({ createdAt: { $gte: new Date(now.getTime() - 90 * DAY) } }).select("account accountName createdAt lines.status lines.key lines.amount").sort({ createdAt: -1 }).lean(),
    collections.overdue(),
    collections.overdue({ includeHeld: true }),
    msme.dues({ asOf: now }),
  ]);
  // Bills that came by mail, read and waiting to be checked and entered.
  const mailedBills = await require("../models/InboxBill").find({ status: "new", part: { $gt: 0 } }).select("supplierName from receivedAt grand alreadyEntered senderKnown read.billNo").sort({ receivedAt: -1 }).limit(50).lean();
  const serviceBills = await MachineServiceBill.find({ supplierBill: null, amount: { $gt: 0 } }).select("machine serviceLog kind vendor billNo billDate amount filename createdAt").sort({ createdAt: -1 }).limit(20).lean();
  // Cheques in the drawer whose date has come (or comes this week): to be deposited.
  const cheques = await Payment.find({ status: "posted", "cheque.status": "held", "cheque.date": { $lte: weekEnd } }).select("kind voucherNo partyName amount cheque.number cheque.bank cheque.date").sort({ "cheque.date": 1 }).limit(20).lean();
  const msmeSoon = msmeDues.rows.filter((r) => r.state !== "ok");
  // A bank account in use whose last statement is more than a week old
  // (or which has none): this week's download is due.
  const BankAccount = require("../models/BankAccount");
  const bankAccounts = await BankAccount.find({ active: { $ne: false }, kind: { $ne: "cash" } }).select("name").lean();
  const statementsDue = [];
  for (const a of bankAccounts) {
    const last = await BankStatement.findOne({ account: a._id }).sort({ to: -1 }).select("to").lean();
    if (last?.to && now - new Date(last.to) <= 7 * DAY) continue;
    // An account nothing moves through is not asked for.
    if (!last && !(await Payment.exists({ account: a._id, status: "posted", date: { $gte: new Date(now.getTime() - 60 * DAY) } }))) continue;
    statementsDue.push({ account: a._id, accountName: a.name, lastTo: last?.to || null });
  }
  const dueThisWeek = payables.filter((p) => new Date(p.dueDate) <= weekEnd).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const waitingOnMe = canApprove ? pendingExpenses.filter((e) => String(e.submittedBy || "") !== mine || req.user?.role === "admin") : [];
  // A suggested match ("matched") is not in the books until someone posts it.
  const placed = new Set();
  for (const s of statements) for (const l of s.lines) if (["recorded", "posted", "ignored"].includes(l.status)) placed.add(l.key);
  const unplaced = new Map();
  let latest = null;
  for (const s of statements) for (const l of s.lines) {
    if (placed.has(l.key) || unplaced.has(l.key)) continue;
    unplaced.set(l.key, l.amount || 0);
    if (!latest) latest = { statement: s._id, account: s.account, accountName: s.accountName };
  }
  const today = factoryDay.calendarDay(now);
  const promised = promisesDue.filter((r) => r.promise?.live && new Date(r.promise.date) <= new Date(today.getTime() + DAY - 1));
  res.json({
    success: true,
    billsDue: { count: dueThisWeek.length, overdue: dueThisWeek.filter((x) => x.overdueDays > 0).length, amount: r2(dueThisWeek.reduce((s, x) => s + x.outstanding, 0)), top: dueThisWeek.slice(0, 6) },
    approvals: { count: waitingOnMe.length, amount: r2(waitingOnMe.reduce((s, e) => s + (e.totals?.grand || 0), 0)), top: waitingOnMe.slice(0, 6) },
    claimsToPay: { count: claimsToPay.length, amount: r2(claimsToPay.reduce((s, e) => s + (e.totals?.grand || 0) - (e.paidAmount || 0), 0)), top: claimsToPay.slice(0, 6) },
    bankLines: { count: unplaced.size, amount: r2([...unplaced.values()].reduce((s, a) => s + a, 0)), ...(latest || {}) },
    toChase: { count: chase.filter((c) => !c.recentlyContacted).length, amount: r2(chase.filter((c) => !c.recentlyContacted).reduce((s, c) => s + c.overdue, 0)), top: chase.filter((c) => !c.recentlyContacted).slice(0, 5).map((c) => ({ party: c.party, partyName: c.partyName, overdue: c.overdue, oldestDays: c.oldestDays, next: c.next })) },
    promisesDue: { count: promised.length, top: promised.slice(0, 5).map((c) => ({ party: c.party, partyName: c.partyName, promise: c.promise })) },
    variances: { count: varianceBills.length, top: varianceBills },
    mailedBills: { count: mailedBills.length, amount: r2(mailedBills.reduce((t, x) => t + (x.grand || 0), 0)), top: mailedBills.slice(0, 6).map((x) => ({ _id: x._id, supplierName: x.supplierName, from: x.from, receivedAt: x.receivedAt, grand: x.grand, billNo: x.read?.billNo || "", alreadyEntered: x.alreadyEntered, senderKnown: !!x.senderKnown })) },
    serviceBills: { count: serviceBills.length, amount: r2(serviceBills.reduce((s, b) => s + (b.amount || 0), 0)), top: serviceBills.slice(0, 6) },
    statementsDue: { count: statementsDue.length, top: statementsDue.slice(0, 6) },
    chequesDue: { count: cheques.length, amount: r2(cheques.reduce((s, c) => s + c.amount, 0)), overdue: cheques.filter((c) => new Date(c.cheque.date) < today).length, top: cheques.slice(0, 6) },
    msmeDue: { count: msmeSoon.length, overdue: msmeDues.totals.overdueCount, amount: r2(msmeSoon.reduce((s, r) => s + r.outstanding, 0)), top: msmeSoon.slice(0, 6) },
  });
}));

// ── Flags before saving ────────────────────────────────────────────
router.post("/bills/check", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, flags: await insights.anomalies("bill", req.body || {}, req.user) });
}));
router.post("/payments/check", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, flags: await require("../services/paymentChecks").paymentFlags(req.body || {}, req.user) });
}));
router.post("/expenses/check", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, flags: await insights.anomalies("expense", req.body || {}, req.user) });
}));
router.get("/suggest/category", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, suggestion: await insights.suggestCategory({ supplier: req.query.supplier, payee: req.query.payee, description: req.query.description }) });
}));

// ── Forecast, month end, AI ────────────────────────────────────────
router.get("/forecast", catchAsyncErrors(async (req, res) => {
  const weeks = Math.min(13, Math.max(2, Number(req.query.weeks) || 6));
  res.json({ success: true, ...(await insights.forecast({ weeks })) });
}));

router.get("/close", catchAsyncErrors(async (req, res) => {
  const d = new Date(); const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  res.json({ success: true, ...(await insights.closeChecklist(month)) });
}));

router.get("/ai/stats", catchAsyncErrors(async (req, res) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
  const all = await aiLedger.stats({ days });
  const rows = (Array.isArray(all) ? all : all.surfaces || []).filter((r) => ACCOUNTS_SURFACES.includes(r.surface));
  res.json({ success: true, days, surfaces: rows, weakFields: await aiLedger.weakFields({ surface: "bill-ocr", days, limit: 8 }) });
}));

// ── Recurring expenses ─────────────────────────────────────────────
function readRecurring(b) {
  const out = {};
  if (b.name !== undefined) out.name = String(b.name || "").trim().slice(0, 80);
  if (b.category !== undefined) { if (!isId(b.category)) throw new ErrorHandler("category is required", 400); out.category = b.category; }
  if (b.description !== undefined) out.description = String(b.description || "").trim().slice(0, 200);
  if (b.supplier !== undefined) out.supplier = isId(b.supplier) ? b.supplier : null;
  if (b.payeeName !== undefined) out.payeeName = String(b.payeeName || "").trim().slice(0, 120);
  if (b.amount !== undefined) { out.amount = r2(b.amount); if (!(out.amount > 0)) throw new ErrorHandler("amount must be more than 0", 400); }
  if (b.gstPercent !== undefined) out.gstPercent = Math.min(100, Math.max(0, Number(b.gstPercent) || 0));
  if (b.every !== undefined) { out.every = Number(b.every); if (![1, 3, 6, 12].includes(out.every)) throw new ErrorHandler("every is 1, 3, 6 or 12 months", 400); }
  if (b.dayOfMonth !== undefined) out.dayOfMonth = Math.min(28, Math.max(1, Number(b.dayOfMonth) || 1));
  if (b.nextDate !== undefined) { out.nextDate = readDate(b.nextDate, "nextDate"); if (!out.nextDate) throw new ErrorHandler("nextDate is required", 400); }
  if (b.endDate !== undefined) out.endDate = readDate(b.endDate, "endDate", null);
  if (b.active !== undefined) out.active = !!b.active;
  return out;
}

router.get("/recurring", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, rows: await RecurringExpense.find({}).populate("category", "name").populate("supplier", "name").sort({ active: -1, nextDate: 1 }).lean() });
}));

router.post("/recurring", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  let body;
  try { body = readRecurring(req.body || {}); } catch (err) { return next(err); }
  for (const f of ["name", "category", "description", "amount", "nextDate"]) if (!body[f]) return next(new ErrorHandler(`${f} is required`, 400));
  if (!(await ExpenseCategory.exists({ _id: body.category }))) return next(new ErrorHandler("Category not found", 404));
  if (body.supplier && !(await Supplier.exists({ _id: body.supplier }))) return next(new ErrorHandler("Supplier not found", 404));
  if (!body.dayOfMonth) body.dayOfMonth = Math.min(28, new Date(body.nextDate).getDate());
  res.status(201).json({ success: true, row: await RecurringExpense.create({ ...body, createdBy: req.user?._id }) });
}));

router.put("/recurring/:id", isAdmin("admin", "accounts"), catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  let body;
  try { body = readRecurring(req.body || {}); } catch (err) { return next(err); }
  const row = await RecurringExpense.findByIdAndUpdate(req.params.id, { $set: body }, { new: true, runValidators: true }).lean();
  if (!row) return next(new ErrorHandler("Not found", 404));
  res.json({ success: true, row });
}));

router.post("/recurring/run", catchAsyncErrors(async (_req, res) => {
  const drafted = [];
  for (let i = 0; i < 12; i++) { const d = await recurring.runDue(); if (!d.length) break; drafted.push(...d); }
  res.json({ success: true, drafted });
}));

// ── Excel ──────────────────────────────────────────────────────────
const dmy = (d) => (d ? new Date(d) : null);
const EXPORTS = {
  bills: {
    sheet: "Supplier bills",
    columns: [["Bill", "billNo", 16], ["Supplier", "supplierName", 28], ["Their no.", "supplierBillNo", 14], ["Date", "billDate", 12, "date"], ["Due", "dueDate", 12, "date"], ["PO", "poNo", 8], ["Taxable", "totals.taxable", 14, "money"], ["Tax", "totals.tax", 12, "money"], ["Total", "totals.grand", 14, "money"], ["Paid", "paidAmount", 14, "money"], ["TDS", "tdsAmount", 12, "money"], ["Debited", "debitedAmount", 12, "money"], ["Status", "status", 10]],
    rows: (q) => SupplierBill.find(q.range ? { billDate: q.range } : {}).select("-attachments -lines -fingerprints").sort({ billDate: 1 }).lean(),
  },
  expenses: {
    sheet: "Expenses",
    columns: [["Expense", "expenseNo", 16], ["Date", "date", 12, "date"], ["Head", "categoryName", 18], ["Description", "description", 32], ["Payee", "payeeName", 22], ["Taxable", "totals.taxable", 12, "money"], ["Tax", "totals.tax", 10, "money"], ["Total", "totals.grand", 12, "money"], ["ITC", "itc.amount", 10, "money"], ["Paid", "paidAmount", 12, "money"], ["Status", "status", 10], ["Entered by", "submittedByName", 16]],
    rows: (q) => Expense.find(q.range ? { date: q.range } : {}).select("-attachments -lines -fingerprints").sort({ date: 1 }).lean(),
  },
  vouchers: {
    sheet: "Receipts and payments",
    columns: [["Voucher", "voucherNo", 16], ["Date", "date", 12, "date"], ["Kind", "kind", 9], ["Party", "partyName", 26], ["Amount", "amount", 14, "money"], ["TDS", "tds.amount", 10, "money"], ["Mode", "mode", 8], ["Account", "accountName", 16], ["Reference", "reference", 16], ["Settles", (r) => (r.allocations || []).map((a) => a.docNo).join(", "), 30], ["On account", "unallocated", 12, "money"], ["Status", "status", 10]],
    rows: (q) => Payment.find(q.range ? { date: q.range } : {}).select("-attachments -fingerprints").sort({ date: 1 }).lean(),
  },
  notes: {
    sheet: "Credit and debit notes",
    columns: [["Note", "noteNo", 16], ["Kind", (r) => `${r.kind} (${r.partyType})`, 18], ["Date", "date", 12, "date"], ["Party", "partyName", 26], ["Against", "against.docNo", 18], ["Reason", "reason", 30], ["Taxable", "totals.taxable", 12, "money"], ["Tax", "totals.tax", 10, "money"], ["Total", "totals.grand", 12, "money"], ["Unapplied", "unapplied", 12, "money"], ["Status", "status", 10]],
    rows: (q) => AccountNote.find(q.range ? { date: q.range } : {}).select("-attachments -lines -fingerprints").sort({ date: 1 }).lean(),
  },
  receivables: {
    sheet: "Receivables",
    columns: [["Customer", "partyName", 28], ["Document", "docNo", 18], ["Date", "date", 12, "date"], ["Due", "dueDate", 12, "date"], ["Amount", "amount", 14, "money"], ["Outstanding", "outstanding", 14, "money"], ["Days overdue", "overdueDays", 12], ["Bucket", "bucket", 10]],
    rows: () => outstanding.receivables(),
  },
  payables: {
    sheet: "Payables",
    columns: [["Supplier", "partyName", 28], ["Document", "docNo", 18], ["Their no.", "refNo", 14], ["Date", "date", 12, "date"], ["Due", "dueDate", 12, "date"], ["Amount", "amount", 14, "money"], ["Outstanding", "outstanding", 14, "money"], ["Days overdue", "overdueDays", 12], ["Bucket", "bucket", 10]],
    rows: () => outstanding.payables(),
  },
};

const pick = (row, path) => (typeof path === "function" ? path(row) : path.split(".").reduce((o, k) => (o == null ? o : o[k]), row));

router.get("/export/:what", catchAsyncErrors(async (req, res, next) => {
  const spec = EXPORTS[req.params.what];
  if (!spec) return next(new ErrorHandler(`Nothing called ${req.params.what} to export`, 404));
  let range = null;
  try {
    const from = readDate(req.query.from, "from");
    const to = readDate(req.query.to, "to");
    if (from || to) range = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: factoryDay.calendarDayEnd(to) } : {}) };
  } catch (err) { return next(err); }
  const rows = await spec.rows({ range });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(spec.sheet);
  ws.columns = spec.columns.map(([header, , width]) => ({ header, width: width || 14 }));
  for (const r of rows) {
    ws.addRow(spec.columns.map(([, path, , type]) => {
      const v = pick(r, path);
      if (type === "date") return dmy(v);
      if (type === "money") return v == null ? null : r2(v);
      return v ?? "";
    }));
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  spec.columns.forEach(([, , , type], i) => {
    if (type === "money") ws.getColumn(i + 1).numFmt = "#,##0.00";
    if (type === "date") ws.getColumn(i + 1).numFmt = "dd-mm-yyyy";
  });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.what}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

module.exports = router;
