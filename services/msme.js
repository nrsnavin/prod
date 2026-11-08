'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAYING MICRO AND SMALL ENTERPRISES ON TIME
//
//  MSMED Act s.15: a buyer must pay a micro or small enterprise within
//  the agreed period, at most 45 days from the day of acceptance (15
//  days where nothing is agreed in writing). s.16: compound interest at
//  three times the RBI bank rate on what is late.
//
//  Income-tax Act s.43B(h): what is still unpaid past that day at the
//  year end is not an expense of that year; it is allowed in the year
//  it is paid. Paid late but inside the year: allowed, with interest due.
//
//  Companies file MSME Form I every half year (30 April for October to
//  March, 31 October for April to September) listing dues outstanding
//  more than 45 days at the half year's end.
//
//  dues()      every open bill to a micro or small supplier, its
//              statutory due day, and where it stands
//  yearEnd()   s.43B(h): bills of the year unpaid at 31 March past
//              their day, so disallowed, and what was paid late
//  formOne()   the half-year return's rows
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');
const Supplier = require('../models/Supplier');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const Payment = require('../models/Payment');

const DAY = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayStart = (d) => factoryDay.calendarDay(d) || new Date(NaN);

/** Days the law gives this supplier: what was agreed in writing (≤45), else 15. */
const statutoryDays = (s) => Math.min(45, Math.max(0, Number(s?.msme?.agreedDays) || 0) || 15);
const isMsme = (s) => ['micro', 'small'].includes(s?.msme?.category);

/** The micro and small suppliers, by id. */
async function msmeSuppliers() {
  const rows = await Supplier.find({ 'msme.category': { $in: ['micro', 'small'] } }).select('name msme').lean();
  return new Map(rows.map((s) => [String(s._id), s]));
}

/** Open documents to MSME suppliers, with the statutory due date. */
async function dues({ asOf = new Date() } = {}) {
  const suppliers = await msmeSuppliers();
  if (!suppliers.size) return { rows: [], totals: { count: 0, outstanding: 0, overdue: 0, overdueCount: 0, dueSoon: 0 }, suppliers: 0 };
  const ids = [...suppliers.keys()];
  const [bills, expenses] = await Promise.all([
    SupplierBill.find({ supplier: { $in: ids }, status: { $in: ['open', 'part_paid'] } }).select('billNo supplierBillNo supplier supplierName billDate totals paidAmount tdsAmount debitedAmount').lean(),
    Expense.find({ supplier: { $in: ids }, status: 'approved' }).select('expenseNo supplier payeeName date totals paidAmount').lean(),
  ]);
  const today = dayStart(asOf);
  const rows = [];
  const add = (doc, { docType, docNo, refNo, date, amount, outstanding }) => {
    const s = suppliers.get(String(doc.supplier));
    const days = statutoryDays(s);
    const due = new Date(dayStart(date).getTime() + days * DAY);
    const left = Math.round((due - today) / DAY);
    rows.push({
      docType, id: doc._id, docNo, refNo, date, amount: r2(amount), outstanding: r2(outstanding),
      party: doc.supplier, partyName: s.name, category: s.msme.category, udyam: s.msme.udyam || '',
      days, dueDate: due, daysLeft: left, state: left < 0 ? 'overdue' : left <= 7 ? 'dueSoon' : 'ok',
    });
  };
  for (const b of bills) {
    const outstanding = r2((b.totals?.grand || 0) - (b.paidAmount || 0) - (b.tdsAmount || 0) - (b.debitedAmount || 0));
    if (outstanding > 0.005) add(b, { docType: 'SupplierBill', docNo: b.billNo, refNo: b.supplierBillNo, date: b.billDate, amount: b.totals?.grand, outstanding });
  }
  for (const e of expenses) {
    const outstanding = r2((e.totals?.grand || 0) - (e.paidAmount || 0));
    if (outstanding > 0.005) add(e, { docType: 'Expense', docNo: e.expenseNo, refNo: '', date: e.date, amount: e.totals?.grand, outstanding });
  }
  rows.sort((a, b) => a.dueDate - b.dueDate);
  const overdue = rows.filter((r) => r.state === 'overdue');
  return {
    rows,
    totals: {
      count: rows.length, outstanding: r2(rows.reduce((t, r) => t + r.outstanding, 0)),
      overdue: r2(overdue.reduce((t, r) => t + r.outstanding, 0)), overdueCount: overdue.length,
      dueSoon: rows.filter((r) => r.state === 'dueSoon').length,
    },
    suppliers: suppliers.size,
  };
}

/** When each bill of these suppliers was settled, from the vouchers against it. */
async function settlementDates(docIds) {
  const pays = await Payment.find({ status: 'posted', 'allocations.doc': { $in: docIds } }).select('date allocations').lean();
  const byDoc = new Map();
  for (const p of pays) for (const a of p.allocations || []) {
    if (!docIds.some((id) => String(id) === String(a.doc))) continue;
    const list = byDoc.get(String(a.doc)) || [];
    list.push({ date: p.date, amount: r2((a.amount || 0)) });
    byDoc.set(String(a.doc), list);
  }
  return byDoc;
}

/**
 * s.43B(h) for a financial year: each bill of the year to a micro or
 * small supplier, its statutory due day, when it was paid, and whether
 * it is allowed (paid by the due day, or late but by 31 March — with
 * interest owed) or disallowed (unpaid at 31 March past its day).
 */
async function yearEnd(fy) {
  const [y1] = String(fy || '').split('-').map(Number);
  const from = new Date(y1, 3, 1);
  const to = new Date(y1 + 1, 2, 31, 23, 59, 59, 999);
  const suppliers = await msmeSuppliers();
  if (!suppliers.size) return { fy, rows: [], totals: { allowed: 0, late: 0, disallowed: 0, interest: 0 } };
  const ids = [...suppliers.keys()];
  const bills = await SupplierBill.find({ supplier: { $in: ids }, status: { $ne: 'cancelled' }, billDate: { $gte: from, $lte: to } }).select('billNo supplierBillNo supplier supplierName billDate totals paidAmount tdsAmount debitedAmount').lean();
  const settled = await settlementDates(bills.map((b) => b._id));
  const rows = [];
  for (const b of bills) {
    const s = suppliers.get(String(b.supplier));
    const days = statutoryDays(s);
    const due = new Date(dayStart(b.billDate).getTime() + days * DAY);
    const grand = r2(b.totals?.grand || 0);
    const debited = r2(b.debitedAmount || 0);
    const owed = r2(grand - debited);
    const pays = (settled.get(String(b._id)) || []).sort((a, c) => a.date - c.date);
    const byDue = r2(pays.filter((p) => p.date <= new Date(due.getTime() + DAY - 1)).reduce((t, p) => t + p.amount, 0));
    const byYearEnd = r2(pays.filter((p) => p.date <= to).reduce((t, p) => t + p.amount, 0));
    const late = r2(Math.max(0, Math.min(owed, byYearEnd) - byDue));
    const disallowed = r2(Math.max(0, owed - byYearEnd));
    const lastPaid = pays.length ? pays[pays.length - 1].date : null;
    rows.push({
      id: b._id, docNo: b.billNo, refNo: b.supplierBillNo, party: b.supplier, partyName: s.name, category: s.msme.category,
      date: b.billDate, dueDate: due, amount: owed, paidByDue: byDue, paidLate: late, disallowed, lastPaid,
      status: disallowed > 0.005 ? 'disallowed' : late > 0.005 ? 'late' : 'allowed',
    });
  }
  rows.sort((a, b) => a.date - b.date);
  return {
    fy, from, to, rows,
    totals: {
      allowed: r2(rows.reduce((t, r) => t + (r.status === 'allowed' ? r.amount : 0), 0)),
      late: r2(rows.reduce((t, r) => t + r.paidLate, 0)),
      disallowed: r2(rows.reduce((t, r) => t + r.disallowed, 0)),
      count: rows.length, disallowedCount: rows.filter((r) => r.status === 'disallowed').length,
    },
  };
}

/**
 * MSME Form I: dues to micro and small suppliers outstanding more than
 * 45 days at the half-year end (30 September or 31 March).
 */
async function formOne(asOfInput) {
  const asOf = asOfInput ? dayStart(asOfInput) : null;
  const now = new Date();
  // Default: the last half-year end that has passed.
  const end = asOf || (now.getMonth() >= 9 ? new Date(now.getFullYear(), 8, 30) : now.getMonth() >= 3 ? new Date(now.getFullYear(), 2, 31) : new Date(now.getFullYear() - 1, 8, 30));
  const endOfDay = new Date(end.getTime() + DAY - 1);
  const suppliers = await msmeSuppliers();
  if (!suppliers.size) return { asOf: end, rows: [], total: 0 };
  const ids = [...suppliers.keys()];
  const bills = await SupplierBill.find({ supplier: { $in: ids }, status: { $ne: 'cancelled' }, billDate: { $lte: new Date(end.getTime() - 45 * DAY) } }).select('billNo supplierBillNo supplier billDate totals debitedAmount').lean();
  const settled = await settlementDates(bills.map((b) => b._id));
  const rows = [];
  for (const b of bills) {
    const paidByEnd = r2((settled.get(String(b._id)) || []).filter((p) => p.date <= endOfDay).reduce((t, p) => t + p.amount, 0));
    const left = r2((b.totals?.grand || 0) - (b.debitedAmount || 0) - paidByEnd);
    if (left <= 0.005) continue;
    const s = suppliers.get(String(b.supplier));
    rows.push({ party: b.supplier, partyName: s.name, udyam: s.msme.udyam || '', category: s.msme.category, docNo: b.billNo, refNo: b.supplierBillNo, date: b.billDate, amount: left, daysOutstanding: Math.floor((end - dayStart(b.billDate)) / DAY), reason: 'Payment pending' });
  }
  rows.sort((a, b) => a.partyName.localeCompare(b.partyName) || a.date - b.date);
  return { asOf: end, rows, total: r2(rows.reduce((t, r) => t + r.amount, 0)) };
}

module.exports = { dues, yearEnd, formOne, statutoryDays, isMsme };
