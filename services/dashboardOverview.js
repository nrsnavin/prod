'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DASHBOARD, BY ROLE
//
//  What the home screen leads with: the things that need a decision,
//  then the money and the floor, each figure against something it can
//  be compared with. Who sees what follows the role:
//
//    owner (admin)   attention, money, floor
//    production      attention (its own), floor
//    accounts        attention (its own), money
//
//  "Orders at risk" comes from the delivery forecast (services/
//  etaService.js), not from the supply date alone: an order due on the
//  12th and forecast for the 18th is at risk today, days before the
//  date passes. The old tile counted only orders already late, so it
//  read "everything on time" while the planner showed late lines.
//
//  Nothing here writes. Each attention item carries its count, up to
//  three examples and the screen that clears it; the web hides an item
//  whose screen the person can't open.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');
const { toISODate } = require('../utils/productionStats');
const Order = require('../models/Order');
const ShiftDetail = require('../models/ShiftDetail');
const ShiftPlan = require('../models/ShiftPlan');
const LeaveRequest = require('../models/LeaveRequest');
const Expense = require('../models/Expense');
const Advance = require('../models/Advance');
const Invoice = require('../models/Invoice');
const Machine = require('../models/Machine');
const RawMaterial = require('../models/RawMaterial');
const outstanding = require('./outstanding');

const DAY = 86_400_000;
const LIVE = ['Open', 'Approved', 'InProgress'];
const { r2 } = require('../utils/money');
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '');

/** Which sections a role sees. Anything else sees nothing. */
function sectionsFor(role) {
  if (role === 'admin') return { role: 'owner', money: true, floor: true, attention: 'all' };
  if (role === 'production') return { role: 'production', money: false, floor: true, attention: 'production' };
  if (role === 'accounts') return { role: 'accounts', money: true, floor: false, attention: 'accounts' };
  return null;
}

// Which attention items each role is shown. The owner sees all of them.
const ATTENTION = {
  production: new Set(['ordersAtRisk', 'shiftsToVerify']),
  accounts: new Set(['ordersAtRisk', 'overdueInvoices', 'billsDue', 'expensesToApprove', 'advancesRequested', 'irnPending', 'pendingLeaves', 'latePos', 'lowStock']),
};

// ── Orders late or forecast late ──────────────────────────────────
async function ordersAtRisk(now) {
  const today = factoryDay.calendarDay(now);
  const orders = await Order.find({ status: { $in: LIVE } })
    .select('orderNo status supplyDate customer elasticOrdered producedElastic')
    .populate('customer', 'name')
    .lean();
  const inFlight = orders.filter((o) => o.status !== 'Open');
  let forecast = new Map();
  if (inFlight.length) {
    // Loaded only when something needs a forecast: the plant figures are
    // the one expensive aggregation, memoised in the engine.
    const eta = require('./etaService');
    const [plant, free] = await Promise.all([eta._loadPlantMetersPerMachineDay(now), eta._loadFreeMachineCount()]);
    for (const o of inFlight) {
      try {
        const r = await eta._computeRunningEtaForOrder(o, plant, now, free);
        if (r?.ok) forecast.set(String(o._id), r);
      } catch {
        // One order the engine can't read must not blank the dashboard.
      }
    }
  }
  const rows = [];
  for (const o of orders) {
    const due = o.supplyDate ? new Date(o.supplyDate) : null;
    const f = forecast.get(String(o._id));
    const late = !!due && due < today;
    const atRisk = !late && !!f?.risk?.late;
    if (!late && !atRisk) continue;
    rows.push({
      orderId: o._id,
      orderNo: o.orderNo,
      customer: o.customer?.name || '',
      supplyDate: due,
      expectedDate: f?.expectedDate || null,
      state: late ? 'late' : 'at_risk',
      daysLate: late ? Math.max(1, Math.round((today - factoryDay.calendarDay(due)) / DAY)) : 0,
      lateWorkingDays: f?.risk?.lateWorkingDays || 0,
    });
  }
  // Late first, the latest of them first; then the forecasts that slip most.
  rows.sort((a, b) => (a.state === b.state ? (b.daysLate - a.daysLate) || (b.lateWorkingDays - a.lateWorkingDays) : a.state === 'late' ? -1 : 1));
  return rows;
}

const orderDetail = (r) =>
  r.state === 'late'
    ? `due ${fmt(r.supplyDate)}, ${r.daysLate} day${r.daysLate === 1 ? '' : 's'} late${r.expectedDate ? `; forecast ${fmt(r.expectedDate)}` : ''}`
    : `due ${fmt(r.supplyDate)}, forecast ${fmt(r.expectedDate)}`;

// ── Money ─────────────────────────────────────────────────────────
async function money(now) {
  const [recv, pay] = await Promise.all([outstanding.receivables({ asOf: now }), outstanding.payables({ asOf: now })]);
  const rt = outstanding.totals(recv);
  const pt = outstanding.totals(pay);
  const weekEnd = new Date(now.getTime() + 7 * DAY);
  const dueSoon = pay.filter((p) => p.overdueDays > 0 || new Date(p.dueDate) <= weekEnd);
  const overdueDocs = recv.filter((r) => r.overdueDays > 0).sort((a, b) => b.outstanding - a.outstanding);

  // Sales this month so far against the same days of last month: a
  // month-to-date figure beside last month's whole would always look low.
  const today = factoryDay.calendarDay(now);
  const ist = new Date(today.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  const startOf = (yy, mm) => new Date(Date.UTC(yy, mm, 1) - 5.5 * 3600_000);
  const thisStart = startOf(y, m);
  const lastStart = startOf(y, m - 1);
  const daysInLast = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastSameDayEnd = new Date(Date.UTC(y, m - 1, Math.min(d, daysInLast) + 1) - 5.5 * 3600_000);
  const sumSales = async (from, to) => {
    const [g] = await Invoice.aggregate([
      { $match: { status: 'issued', invoiceDate: { $gte: from, $lt: to } } },
      { $group: { _id: null, amount: { $sum: '$totals.grand' }, count: { $sum: 1 } } },
    ]);
    return { amount: r2(g?.amount), count: g?.count || 0 };
  };
  const [salesNow, salesThen] = await Promise.all([sumSales(thisStart, new Date(now.getTime() + 1)), sumSales(lastStart, lastSameDayEnd)]);

  return {
    receivable: { total: rt.total, overdue: rt.overdue, overdueDocs: overdueDocs.length, docs: rt.count },
    payable: { total: pt.total, dueThisWeek: r2(dueSoon.reduce((s, p) => s + p.outstanding, 0)), dueThisWeekDocs: dueSoon.length },
    sales: { monthToDate: salesNow.amount, invoices: salesNow.count, lastMonthSameDays: salesThen.amount, throughDay: d },
    _overdueDocs: overdueDocs,
    _dueSoon: dueSoon.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate)),
  };
}

// ── The floor ─────────────────────────────────────────────────────
async function floor(now) {
  const [machines, plans] = await Promise.all([
    Machine.find({}).select('status loading').lean(),
    ShiftPlan.find({ date: { $gte: new Date(factoryDay.calendarDay(now).getTime() - 40 * DAY) } }).select('date totalProduction').lean(),
  ]);
  // Metres by day, from the shift plans as the production screen totals
  // them. Today's shift day is still being made, so it is left out of
  // the averages; a day with nothing made (a Sunday) is not a working day.
  const todayKey = toISODate(factoryDay.shiftDay(now));
  const byDay = new Map();
  for (const p of plans) {
    const k = toISODate(p.date);
    byDay.set(k, (byDay.get(k) || 0) + (p.totalProduction || 0));
  }
  const worked = [...byDay.entries()].filter(([k, v]) => k < todayKey && v > 0).sort(([a], [b]) => (a < b ? -1 : 1));
  const last = worked.slice(-24);
  const recent = last.slice(-12);
  const before = last.slice(-24, -12);
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, [, v]) => s + v, 0) / xs.length) : null);
  return {
    looms: {
      total: machines.length,
      running: machines.filter((m) => m.status === 'running' && !m.loading).length,
      loading: machines.filter((m) => m.status === 'running' && m.loading).length,
      maintenance: machines.filter((m) => m.status === 'maintenance').length,
    },
    metres: {
      today: Math.round(byDay.get(todayKey) || 0),
      perWorkingDay: avg(recent),
      previousPerWorkingDay: avg(before),
      days: recent.length,
      previousDays: before.length,
      series: last.map(([date, v]) => ({ date, metres: Math.round(v) })),
    },
  };
}

// ── Everything, for one role ──────────────────────────────────────
async function overview(role, { now = new Date() } = {}) {
  const s = sectionsFor(role);
  if (!s) return null;
  const want = (key) => s.attention === 'all' || ATTENTION[s.attention].has(key);
  const needMoney = s.money || want('overdueInvoices') || want('billsDue');

  const [risk, m, f, counts] = await Promise.all([
    want('ordersAtRisk') ? ordersAtRisk(now) : [],
    needMoney ? money(now) : null,
    s.floor ? floor(now) : null,
    Promise.all([
      want('shiftsToVerify') ? ShiftDetail.countDocuments({ status: 'pending_verification' }) : 0,
      want('pendingLeaves') ? LeaveRequest.countDocuments({ status: 'pending' }) : 0,
      want('expensesToApprove') ? Expense.find({ status: 'pending' }).select('expenseNo categoryName description totals payeeName').sort({ date: 1 }).lean() : [],
      want('advancesRequested') ? Advance.find({ status: { $in: ['requested', 'pending'] } }).select('amount reason employee').populate('employee', 'name').sort({ createdAt: 1 }).lean() : [],
      want('irnPending') ? irnPending() : [],
      want('latePos') ? require('./poChaser').overdue({ now }).catch(() => []) : [],
      want('lowStock')
        ? RawMaterial.aggregate([
            { $match: { $expr: { $lte: ['$stock', '$minStock'] } } },
            { $facet: { items: [{ $sort: { stock: 1 } }, { $limit: 3 }, { $project: { name: 1, stock: 1, minStock: 1 } }], total: [{ $count: 'n' }] } },
          ])
        : [],
    ]),
  ]);
  const [shifts, leaves, expenses, advances, irn, latePos, low] = counts;
  const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

  const attention = [];
  const push = (item) => { if (item.count > 0) attention.push(item); };
  if (want('ordersAtRisk')) {
    const lateN = risk.filter((r) => r.state === 'late').length;
    push({
      key: 'ordersAtRisk', label: lateN === 0 ? 'Orders at risk' : lateN === risk.length ? 'Orders late' : 'Orders late or at risk', count: risk.length,
      tone: lateN ? 'danger' : 'warning', to: '/orders',
      summary: lateN && lateN < risk.length ? `${lateN} late, ${risk.length - lateN} forecast late` : undefined,
      items: risk.slice(0, 3).map((r) => ({ title: `Order #${r.orderNo}${r.customer ? ` · ${r.customer}` : ''}`, detail: orderDetail(r), to: `/orders/${r.orderId}` })),
    });
  }
  push({ key: 'shiftsToVerify', label: 'Shifts to verify', count: shifts, tone: 'warning', to: '/shift-verification', items: [] });
  if (m && want('overdueInvoices')) {
    push({
      key: 'overdueInvoices', label: 'Overdue invoices', count: m._overdueDocs.length, tone: 'danger', to: '/accounts/collections',
      summary: `${rupees(m.receivable.overdue)} past due`,
      items: m._overdueDocs.slice(0, 3).map((r) => ({ title: `${r.docNo} · ${r.partyName}`, detail: `${rupees(r.outstanding)}, ${r.overdueDays} day${r.overdueDays === 1 ? '' : 's'} overdue`, to: r.docType === 'Invoice' ? `/invoices/${r.id}` : '/accounts/collections' })),
    });
  }
  if (m && want('billsDue')) {
    push({
      key: 'billsDue', label: 'Bills due this week', count: m._dueSoon.length, tone: 'warning', to: '/accounts/bills',
      summary: `${rupees(m.payable.dueThisWeek)} to pay`,
      items: m._dueSoon.slice(0, 3).map((p) => ({ title: `${p.docNo} · ${p.partyName || ''}`.trim(), detail: `${rupees(p.outstanding)}, ${p.overdueDays > 0 ? `${p.overdueDays} day${p.overdueDays === 1 ? '' : 's'} overdue` : `due ${fmt(p.dueDate)}`}`, to: p.docType === 'SupplierBill' ? `/accounts/bills/${p.id}` : '/accounts/bills' })),
    });
  }
  push({
    key: 'expensesToApprove', label: 'Expenses to approve', count: expenses.length, tone: 'warning', to: '/accounts/expenses',
    items: expenses.slice(0, 3).map((e) => ({ title: `${e.expenseNo} · ${e.categoryName || ''}`.trim(), detail: `${rupees(e.totals?.grand || 0)}${e.payeeName ? `, ${e.payeeName}` : ''}`, to: `/accounts/expenses/${e._id}` })),
  });
  push({
    key: 'advancesRequested', label: 'Advance requests', count: advances.length, tone: 'warning', to: '/payroll',
    items: advances.slice(0, 3).map((a) => ({ title: a.employee?.name || 'An employee', detail: `${rupees(a.amount)}${a.reason ? `, ${a.reason}` : ''}`, to: '/payroll' })),
  });
  push({ key: 'pendingLeaves', label: 'Leave to decide', count: leaves, tone: 'warning', to: '/leave', items: [] });
  push({
    key: 'irnPending', label: 'Invoices waiting for an IRN', count: irn.length, tone: 'warning', to: '/invoices',
    items: irn.slice(0, 3).map((i) => ({ title: `${i.invoiceNumber} · ${i.buyer?.name || ''}`.trim(), detail: rupees(i.totals?.grand || 0), to: `/invoices/${i._id}` })),
  });
  push({
    key: 'latePos', label: 'Late supplier deliveries', count: latePos.length, tone: 'warning', to: '/purchase-orders',
    items: latePos.slice(0, 3).map((p) => ({ title: `PO #${p.poNo} · ${p.supplier?.name || ''}`.trim(), detail: `${p.daysLate} day${p.daysLate === 1 ? '' : 's'} late${p.state === 'promised' && p.promisedDate ? `, promised ${fmt(p.promisedDate)}` : ''}`, to: `/purchase-orders/${p._id}` })),
  });
  const lowItems = low[0]?.items || [];
  push({
    key: 'lowStock', label: 'Materials below minimum', count: low[0]?.total?.[0]?.n || 0, tone: 'warning', to: '/materials',
    items: lowItems.map((x) => ({ title: x.name, detail: `${Math.round(x.stock).toLocaleString('en-IN')} of ${Math.round(x.minStock).toLocaleString('en-IN')} minimum`, to: `/materials/${x._id}` })),
  });

  const out = { role: s.role, generatedAt: now, attention, ordersAtRisk: { count: risk.length, late: risk.filter((r) => r.state === 'late').length, top: risk[0] ? { orderNo: risk[0].orderNo, orderId: risk[0].orderId, detail: orderDetail(risk[0]) } : null } };
  if (s.money && m) out.money = { receivable: m.receivable, payable: m.payable, sales: m.sales };
  if (s.floor && f) out.floor = f;
  return out;
}

/**
 * Issued invoices still without an IRN — only where e-invoicing is in
 * use (a provider connected, or an IRN registered before) and only for
 * the invoices that need one: a registered buyer, or an export.
 */
async function irnPending() {
  const inUse =
    (await Invoice.exists({ 'einvoice.status': 'registered' })) ||
    !!(await require('./einvoiceProvider').loadGspConfig().catch(() => ({})))?.provider;
  if (!inUse) return [];
  return Invoice.find({
    status: 'issued',
    'einvoice.status': 'pending',
    $or: [{ 'buyer.gstin': { $nin: ['', null] } }, { 'export.kind': { $nin: ['', null] } }],
  }).select('invoiceNumber buyer.name totals.grand').sort({ invoiceDate: 1 }).lean();
}

module.exports = { overview, sectionsFor, ordersAtRisk };
