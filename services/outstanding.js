'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHO OWES WHAT, AND FOR HOW LONG
//
//  Receivables are the issued invoices less what was received and
//  credited against them; payables are the open bills (and approved
//  expenses to a supplier) less what was paid, deducted and debited.
//  Both are read off the documents themselves — the amounts the
//  vouchers and notes keep up to date — so an outstanding figure never
//  disagrees with the document it is about.
//
//  Ageing buckets by days past the due date (invoice date + the
//  customer's payment terms; bill date + 30 when the bill has none).
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY = 86_400_000;
const BUCKETS = [
  { key: 'current', label: 'Not due', max: 0 },
  { key: 'd30', label: '1–30 days', max: 30 },
  { key: 'd60', label: '31–60 days', max: 60 },
  { key: 'd90', label: '61–90 days', max: 90 },
  { key: 'over90', label: 'Over 90 days', max: Infinity },
];

function bucketOf(overdueDays) {
  if (overdueDays <= 0) return 'current';
  for (const b of BUCKETS) if (overdueDays <= b.max) return b.key;
  return 'over90';
}

function emptyAgeing() {
  return Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
}

/** Open invoices with their outstanding, optionally for one customer. */
async function receivables({ customer, asOf = new Date() } = {}) {
  const q = { status: 'issued' };
  if (customer) q.customer = customer;
  const invoices = await Invoice.find(q)
    .select('invoiceNumber invoiceDate dueDate customer buyer.name orderNo totals paidAmount creditedAmount')
    .sort({ invoiceDate: 1 })
    .lean();
  const rows = [];
  for (const inv of invoices) {
    const outstanding = r2((inv.totals?.grand || 0) - (inv.paidAmount || 0) - (inv.creditedAmount || 0));
    if (outstanding <= 0.005) continue;
    const due = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.invoiceDate);
    const overdueDays = Math.floor((asOf - due) / DAY);
    rows.push({
      docType: 'Invoice', id: inv._id, docNo: inv.invoiceNumber, date: inv.invoiceDate, dueDate: due,
      party: inv.customer, partyName: inv.buyer?.name || '', orderNo: inv.orderNo ?? null,
      amount: inv.totals?.grand || 0, outstanding, overdueDays: Math.max(0, overdueDays), bucket: bucketOf(overdueDays),
    });
  }
  return rows;
}

/** Open bills and approved supplier expenses, optionally for one supplier. */
async function payables({ supplier, asOf = new Date() } = {}) {
  const bq = { status: { $in: ['open', 'part_paid'] } };
  if (supplier) bq.supplier = supplier;
  const bills = await SupplierBill.find(bq)
    .select('billNo supplierBillNo billDate dueDate supplier supplierName poNo totals paidAmount tdsAmount debitedAmount tds')
    .sort({ billDate: 1 })
    .lean();
  const eq = { status: 'approved', supplier: { $ne: null } };
  if (supplier) eq.supplier = supplier;
  const expenses = await Expense.find(eq)
    .select('expenseNo date supplier payeeName description totals paidAmount')
    .sort({ date: 1 })
    .lean();
  const rows = [];
  for (const b of bills) {
    const outstanding = r2((b.totals?.grand || 0) - (b.paidAmount || 0) - (b.tdsAmount || 0) - (b.debitedAmount || 0));
    if (outstanding <= 0.005) continue;
    const due = b.dueDate ? new Date(b.dueDate) : new Date(new Date(b.billDate).getTime() + 30 * DAY);
    const overdueDays = Math.floor((asOf - due) / DAY);
    rows.push({
      docType: 'SupplierBill', id: b._id, docNo: b.billNo, refNo: b.supplierBillNo, date: b.billDate, dueDate: due,
      party: b.supplier, partyName: b.supplierName, poNo: b.poNo ?? null,
      amount: b.totals?.grand || 0, outstanding, overdueDays: Math.max(0, overdueDays), bucket: bucketOf(overdueDays),
      tds: b.tds?.applicable ? { section: b.tds.section, rate: b.tds.rate } : null,
    });
  }
  for (const e of expenses) {
    const outstanding = r2((e.totals?.grand || 0) - (e.paidAmount || 0));
    if (outstanding <= 0.005) continue;
    const due = new Date(new Date(e.date).getTime() + 30 * DAY);
    const overdueDays = Math.floor((asOf - due) / DAY);
    rows.push({
      docType: 'Expense', id: e._id, docNo: e.expenseNo, refNo: '', date: e.date, dueDate: due,
      party: e.supplier, partyName: e.payeeName, description: e.description,
      amount: e.totals?.grand || 0, outstanding, overdueDays: Math.max(0, overdueDays), bucket: bucketOf(overdueDays), tds: null,
    });
  }
  return rows;
}

/** Rows grouped per party with an ageing split and a total. */
function byParty(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = String(r.party);
    const g = map.get(key) || { party: r.party, partyName: r.partyName, total: 0, overdue: 0, oldestDays: 0, count: 0, ageing: emptyAgeing(), docs: [] };
    g.total = r2(g.total + r.outstanding);
    if (r.overdueDays > 0) g.overdue = r2(g.overdue + r.outstanding);
    g.oldestDays = Math.max(g.oldestDays, r.overdueDays);
    g.count += 1;
    g.ageing[r.bucket] = r2(g.ageing[r.bucket] + r.outstanding);
    g.docs.push(r);
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function totals(rows) {
  const t = { total: 0, overdue: 0, count: rows.length, ageing: emptyAgeing() };
  for (const r of rows) {
    t.total = r2(t.total + r.outstanding);
    if (r.overdueDays > 0) t.overdue = r2(t.overdue + r.outstanding);
    t.ageing[r.bucket] = r2(t.ageing[r.bucket] + r.outstanding);
  }
  return t;
}

module.exports = { receivables, payables, byParty, totals, BUCKETS, bucketOf };
