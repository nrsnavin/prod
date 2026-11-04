'use strict';
// ══════════════════════════════════════════════════════════════════
//  COST CENTRES
//
//  A supplier bill or an expense can be booked to a cost centre: the
//  customer order it was bought for (dyeing, job work, the transport
//  on one consignment), the machine it was spent on (spares, a
//  service), or a department (office, canteen, security). The order's
//  P&L then carries what was bought for it besides the yarn and labour
//  drawn from inside (services/orderPnl.js), the machine's spend shows
//  it, and the department report says what each cost. Tally takes the
//  same allocation on the voucher when the setting is on.
//
//  A document names at most one centre. Nothing here posts anything:
//  the centre is a tag on the document, read back here.
// ══════════════════════════════════════════════════════════════════

const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const Order = require('../models/Order');
const Machine = require('../models/Machine');
const ErrorHandler = require('../utils/ErrorHandler');
const { isId } = require('./accountsHelpers');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The centre from a request body, resolved: { order, orderNo } | { machine, machineName } | { department }. */
async function read(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  if (isId(raw.order)) {
    const o = await Order.findById(raw.order).select('orderNo').lean();
    if (!o) throw new ErrorHandler('Cost centre: order not found', 404);
    return { kind: 'order', order: o._id, orderNo: o.orderNo ?? null, name: `Order #${o.orderNo ?? ''}`.trim() };
  }
  if (isId(raw.machine)) {
    const m = await Machine.findById(raw.machine).select('ID manufacturer').lean();
    if (!m) throw new ErrorHandler('Cost centre: machine not found', 404);
    return { kind: 'machine', machine: m._id, name: `Machine ${m.ID || ''}`.trim() };
  }
  const department = String(raw.department || '').trim().slice(0, 60);
  if (department) return { kind: 'department', department, name: department };
  return undefined;
}

/** Bills and expenses booked to an order, with what they came to (net of GST claimed). */
async function forOrder(orderId) {
  if (!isId(orderId)) return { rows: [], total: 0 };
  const [bills, expenses] = await Promise.all([
    SupplierBill.find({ 'costCentre.order': orderId, status: { $ne: 'cancelled' } }).select('billNo supplierBillNo billDate supplierName kind totals itc').lean(),
    Expense.find({ 'costCentre.order': orderId, status: { $in: ['approved', 'paid'] } }).select('expenseNo date payeeName categoryName description totals itc').lean(),
  ]);
  const cost = (t, itc) => r2(itc ? (t?.taxable || 0) : (t?.grand || 0));
  const rows = [
    ...bills.map((b) => ({ docType: 'SupplierBill', id: b._id, docNo: b.billNo, refNo: b.supplierBillNo, date: b.billDate, party: b.supplierName, what: b.kind === 'service' ? 'Service bill' : 'Purchase', amount: cost(b.totals, b.itc?.eligible !== false) })),
    ...expenses.map((e) => ({ docType: 'Expense', id: e._id, docNo: e.expenseNo, refNo: '', date: e.date, party: e.payeeName, what: `${e.categoryName}: ${e.description}`, amount: cost(e.totals, !!e.itc?.eligible) })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));
  return { rows, total: r2(rows.reduce((s, r) => s + r.amount, 0)) };
}

/** Spend by centre in a period, and what carried no centre at all. */
async function report({ from, to }) {
  const range = { $gte: from, $lte: to };
  const [bills, expenses] = await Promise.all([
    SupplierBill.find({ status: { $ne: 'cancelled' }, billDate: range }).select('billNo billDate supplierName kind category totals itc costCentre').lean(),
    Expense.find({ status: { $in: ['approved', 'paid'] }, date: range }).select('expenseNo date payeeName categoryName totals itc costCentre').lean(),
  ]);
  const cost = (t, itc) => r2(itc ? (t?.taxable || 0) : (t?.grand || 0));
  const docs = [
    ...bills.map((b) => ({ docType: 'SupplierBill', id: b._id, docNo: b.billNo, date: b.billDate, party: b.supplierName, kind: b.kind, amount: cost(b.totals, b.itc?.eligible !== false), cc: b.costCentre })),
    ...expenses.map((e) => ({ docType: 'Expense', id: e._id, docNo: e.expenseNo, date: e.date, party: e.payeeName, kind: e.categoryName, amount: cost(e.totals, !!e.itc?.eligible), cc: e.costCentre })),
  ];
  const groups = { order: new Map(), machine: new Map(), department: new Map() };
  let unallocated = 0; let unallocatedCount = 0;
  for (const d of docs) {
    const cc = d.cc && d.cc.kind ? d.cc : null;
    if (!cc) { unallocated = r2(unallocated + d.amount); unallocatedCount += 1; continue; }
    const key = cc.kind === 'order' ? String(cc.order) : cc.kind === 'machine' ? String(cc.machine) : cc.department;
    const g = groups[cc.kind].get(key) || { key, name: cc.name, ref: cc.kind === 'order' ? cc.order : cc.kind === 'machine' ? cc.machine : null, orderNo: cc.orderNo ?? null, total: 0, count: 0, docs: [] };
    g.total = r2(g.total + d.amount); g.count += 1; g.docs.push({ docType: d.docType, id: d.id, docNo: d.docNo, date: d.date, party: d.party, kind: d.kind, amount: d.amount });
    groups[cc.kind].set(key, g);
  }
  const list = (m) => [...m.values()].sort((a, b) => b.total - a.total);
  const allocated = r2(docs.reduce((s, d) => s + d.amount, 0) - unallocated);
  return { from, to, orders: list(groups.order), machines: list(groups.machine), departments: list(groups.department), allocated, unallocated, unallocatedCount, count: docs.length };
}

module.exports = { read, forOrder, report };
