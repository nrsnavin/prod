'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CUSTOMER PORTAL: WHAT A CUSTOMER CAN SEE  (/api/v3/portal)
//
//  Read only, and only the customer's own. Every query is pinned to
//  req.customerId, which middleware/portalAuth.js takes from the
//  signed-in portal login; anything that is not theirs answers 404, as
//  if it did not exist.
//
//    GET /summary                       the home page's figures
//    GET /orders                        their orders, newest first
//    GET /orders/:id                    one order: each elastic ordered,
//                                       woven and dispatched; its challans
//    GET /orders/:id/certificates       test certificates for its elastics
//    GET /dispatches                    challans that have left, newest first
//    GET /dispatches/:id                one challan
//    GET /dispatches/:id/pdf            the challan, as the office prints it
//    GET /dispatches/:id/certificates   certificates for what it carried
//    GET /invoices                      invoices: paid, credited, owed     ┐ not for a
//    GET /invoices/:id/pdf              the invoice, as the office prints it │ login with
//    GET /statement                     the account, entry by entry         │ the viewer
//    GET /statement/pdf                 the same, as the office sends it    ┘ role
//
//  Never shown: machines, operators, costs, the rates on an order, the
//  dates the plant forecasts for itself, a challan still in draft or
//  cancelled, a cancelled invoice, or anything of another customer's.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const mongoose = require('mongoose');
const catchAsyncErrors = require('../../middleware/catchAsyncErrors.js');
const ErrorHandler = require('../../utils/ErrorHandler.js');
const { isCustomerAuthenticated, requirePortalRole } = require('../../middleware/portalAuth.js');
const factoryDay = require('../../utils/factoryDay');
const { renderPdf } = require('../../utils/renderPdf');
const { contentDisposition } = require('../../utils/sendFile');
const { getPdfBranding, getDocumentSettings } = require('../../services/documentSettings');
const { dcPdf } = require('../../services/pdf/dcPdf');
const partyStatement = require('../../services/partyStatement');
const outstanding = require('../../services/outstanding');
const { readDate } = require('../../services/accountsHelpers');
const { r2 } = require('../../utils/money');

const Order = require('../../models/Order.js');
const Customer = require('../../models/Customer.js');
const Elastic = require('../../models/Elastic.js');
const JobOrder = require('../../models/JobOrder.js');
const QcRecord = require('../../models/QcRecord.js');
const DeliveryChallan = require('../../models/DeliveryChallan.js');
const Invoice = require('../../models/Invoice.js');

const router = express.Router();
router.use(isCustomerAuthenticated);

// Money is for the people who buy and pay, not for a login that only looks.
const MONEY = requirePortalRole('buyer', 'accountant');

// ── What a customer is told about an order ───────────────────────
// In their words. Deleted orders do not exist for them.
const STAGE = { Open: 'received', Approved: 'confirmed', InProgress: 'in_production', Completed: 'completed', Cancelled: 'cancelled' };
const OPEN = ['Open', 'Approved', 'InProgress'];
const CLOSED = ['Completed', 'Cancelled'];
// A challan has left once it is dispatched; a draft has not, a cancelled
// one carried nothing. Machine-part challans go to repairers, not customers.
const LEFT = ['dispatched', 'delivered'];

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && /^[a-f\d]{24}$/i.test(String(v));
const qty = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const page = (q) => {
  const limit = Math.min(50, Math.max(1, parseInt(q.limit, 10) || 20));
  const p = Math.max(1, parseInt(q.page, 10) || 1);
  return { limit, page: p, skip: (p - 1) * limit };
};
const notFound = (what) => new ErrorHandler(`${what} not found`, 404);

/** The customer's orders, as the keys a challan can name them by. */
async function ordersOf(customerId) {
  const orders = await Order.find({ customer: customerId, status: { $in: Object.keys(STAGE) } })
    .select('_id orderNo po').lean();
  return {
    orders,
    byId: new Map(orders.map((o) => [String(o._id), o])),
    byNo: new Map(orders.filter((o) => o.orderNo != null).map((o) => [o.orderNo, o])),
    match: orders.length
      ? [{ order: { $in: orders.map((o) => o._id) } }, { orderNo: { $in: orders.filter((o) => o.orderNo != null).map((o) => o.orderNo) } }]
      : null,
  };
}

/** Which of the customer's orders a challan belongs to. */
const orderOfDc = (dc, mine) => (dc.order && mine.byId.get(String(dc.order))) || (dc.orderNo != null && mine.byNo.get(dc.orderNo)) || null;

/** The challans that have left against these orders. */
function leftDcs(match) {
  return DeliveryChallan.find({ $or: match, status: { $in: LEFT }, type: { $ne: 'machine_part' } });
}

const dcQuantity = (dc) => qty((dc.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0));
const dcDate = (dc) => dc.dispatchDate || dc.date || dc.createdAt || null;

function dcRow(dc, order) {
  return {
    id: String(dc._id),
    dcNumber: dc.dcNumber,
    date: dcDate(dc),
    status: dc.status,
    deliveredOn: dc.pod?.deliveredOn || null,
    order: order ? { id: String(order._id), orderNo: order.orderNo ?? null, po: order.po || '' } : null,
    quantity: dcQuantity(dc),
    items: (dc.items || []).map((i) => ({
      elastic: i.elastic ? String(i.elastic._id || i.elastic) : null,
      name: i.elastic?.name || i.elasticName || i.description || '',
      quantity: qty(i.quantity),
      unit: i.unit || 'm',
    })),
  };
}

/** Elastic names by id, from a lookup: an elastic deleted since keeps its quantity. */
async function namesOf(ids) {
  const rows = await Elastic.find({ _id: { $in: ids.filter(Boolean) } }).select('name').lean();
  return new Map(rows.map((e) => [String(e._id), e.name]));
}

/** What has left, per elastic, on these challans. */
function sentByElastic(dcs) {
  const sent = new Map();
  for (const dc of dcs) {
    for (const i of dc.items || []) {
      if (!i.elastic) continue;
      const k = String(i.elastic._id || i.elastic);
      sent.set(k, qty((sent.get(k) || 0) + (Number(i.quantity) || 0)));
    }
  }
  return sent;
}

/** The latest passing test of each elastic made for an order: what a certificate certifies. */
async function certificatesFor(order, elastics = null) {
  const jobs = await JobOrder.find({ order: order._id }).select('_id jobOrderNo').lean();
  if (!jobs.length) return [];
  const jobNo = new Map(jobs.map((j) => [String(j._id), j.jobOrderNo]));
  const q = { job: { $in: jobs.map((j) => j._id) }, overallResult: 'pass' };
  if (elastics) q.elastic = { $in: elastics };
  const records = await QcRecord.find(q)
    .select('job elastic checkedBy results createdAt')
    .populate('elastic', 'name').populate('checkedBy', 'name')
    .sort({ createdAt: -1 }).lean();
  const latest = new Map();
  for (const r of records) {
    const k = String(r.elastic?._id || r.elastic);
    if (!latest.has(k)) latest.set(k, r);
  }
  return [...latest.values()].map((r) => ({
    elastic: String(r.elastic?._id || r.elastic),
    name: r.elastic?.name || '',
    job: jobNo.get(String(r.job)) != null ? `J-${jobNo.get(String(r.job))}` : '',
    checkedAt: r.createdAt,
    checkedBy: r.checkedBy?.name || '',
    results: (r.results || []).map((x) => ({ parameter: x.parameter, expected: x.expected || '', measured: x.measured, pass: !!x.pass })),
  }));
}

/** What an invoice comes to now, in the customer's words. */
function invoiceRow(inv, asOf = new Date()) {
  const total = r2(inv.totals?.grand || 0);
  const owed = r2(total + (inv.debitedAmount || 0) - (inv.paidAmount || 0) - (inv.creditedAmount || 0));
  const due = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.invoiceDate);
  const overdueDays = owed > 0.005 ? Math.max(0, Math.floor((asOf - due) / 86400000)) : 0;
  const state = owed <= 0.005 ? 'paid' : overdueDays > 0 ? 'overdue' : (inv.paidAmount || 0) + (inv.creditedAmount || 0) > 0 ? 'part_paid' : 'due';
  return {
    id: String(inv._id),
    invoiceNumber: inv.invoiceNumber,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate || null,
    orderNo: inv.orderNo ?? null,
    total,
    paid: r2(inv.paidAmount || 0),
    credited: r2(inv.creditedAmount || 0),   // credit notes against it
    debited: r2(inv.debitedAmount || 0),     // debit notes against it
    owed: Math.max(0, owed),
    overdueDays,
    state,
  };
}

// ── Home ───────────────────────────────────────────────────────────
router.get('/summary', catchAsyncErrors(async (req, res) => {
  const customer = await Customer.findById(req.customerId).select('name').lean();
  const branding = await getPdfBranding();
  const soon = new Date(Date.now() + 14 * 86400000);
  const [open, dueSoon] = await Promise.all([
    Order.countDocuments({ customer: req.customerId, status: { $in: OPEN } }),
    Order.countDocuments({ customer: req.customerId, status: { $in: OPEN }, supplyDate: { $lte: soon } }),
  ]);
  const mine = await ordersOf(req.customerId);
  const last = mine.match ? await leftDcs(mine.match).sort({ dispatchDate: -1, createdAt: -1 }).limit(1).lean() : [];
  const out = {
    success: true,
    company: { name: branding.company, phone: branding.phone, email: branding.email },
    customer: { name: customer?.name || '' },
    user: { name: req.customerUser.name, role: req.customerUser.role },
    orders: { open, dueSoon },
    lastDispatch: last[0] ? { id: String(last[0]._id), dcNumber: last[0].dcNumber, date: dcDate(last[0]) } : null,
    canSeeMoney: ['buyer', 'accountant'].includes(req.customerUser.role),
  };
  if (out.canSeeMoney) {
    const t = outstanding.totals(await outstanding.receivables({ customer: req.customerId }));
    out.money = { owed: t.total, overdue: t.overdue, invoices: t.count };
  }
  res.json(out);
}));

// ── Orders ─────────────────────────────────────────────────────────
router.get('/orders', catchAsyncErrors(async (req, res) => {
  const { limit, page: p, skip } = page(req.query);
  const statuses = req.query.status === 'open' ? OPEN : req.query.status === 'closed' ? CLOSED : Object.keys(STAGE);
  const q = { customer: req.customerId, status: { $in: statuses } };
  const [total, orders] = await Promise.all([
    Order.countDocuments(q),
    Order.find(q).select('orderNo po date supplyDate status elasticOrdered producedElastic')
      .sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  const match = orders.length
    ? [{ order: { $in: orders.map((o) => o._id) } }, { orderNo: { $in: orders.filter((o) => o.orderNo != null).map((o) => o.orderNo) } }]
    : null;
  const dcs = match ? await leftDcs(match).select('order orderNo items.quantity').lean() : [];
  const sentTo = new Map();
  const ids = new Set(orders.map((o) => String(o._id)));
  const byNo = new Map(orders.filter((o) => o.orderNo != null).map((o) => [o.orderNo, String(o._id)]));
  for (const dc of dcs) {
    const k = dc.order && ids.has(String(dc.order)) ? String(dc.order) : byNo.get(dc.orderNo);
    if (k) sentTo.set(k, qty((sentTo.get(k) || 0) + dcQuantity(dc)));
  }
  res.json({
    success: true, total, page: p, pages: Math.max(1, Math.ceil(total / limit)),
    orders: orders.map((o) => {
      const ordered = qty((o.elasticOrdered || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0));
      const produced = qty((o.producedElastic || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0));
      const dispatched = sentTo.get(String(o._id)) || 0;
      return {
        id: String(o._id), orderNo: o.orderNo ?? null, po: o.po || '',
        date: o.date, supplyDate: o.supplyDate, stage: STAGE[o.status],
        lines: (o.elasticOrdered || []).length,
        ordered, produced, dispatched,
      };
    }),
  });
}));

/** One of the customer's orders, or a 404. */
async function myOrder(req, select) {
  if (!isId(req.params.id)) throw notFound('Order');
  const order = await Order.findOne({ _id: req.params.id, customer: req.customerId, status: { $in: Object.keys(STAGE) } })
    .select(select).lean();
  if (!order) throw notFound('Order');
  return order;
}

router.get('/orders/:id', catchAsyncErrors(async (req, res) => {
  const order = await myOrder(req, 'orderNo po date supplyDate status elasticOrdered producedElastic');
  const match = [{ order: order._id }];
  if (order.orderNo != null) match.push({ orderNo: order.orderNo });
  const dcs = await leftDcs(match).populate('items.elastic', 'name').sort({ dispatchDate: -1, createdAt: -1 }).lean();
  const sent = sentByElastic(dcs);
  const names = await namesOf((order.elasticOrdered || []).map((l) => l.elastic));
  const lines = (order.elasticOrdered || []).map((l) => {
    const k = String(l.elastic || '');
    const ordered = qty(l.quantity);
    const produced = qty((order.producedElastic || []).filter((x) => String(x.elastic) === k).reduce((s, x) => s + (Number(x.quantity) || 0), 0));
    const dispatched = sent.get(k) || 0;
    return { elastic: k, name: names.get(k) || 'Elastic', ordered, produced, dispatched, toCome: Math.max(0, qty(ordered - dispatched)) };
  });
  const sum = (key) => qty(lines.reduce((s, l) => s + l[key], 0));
  const hasCertificates = (await certificatesFor(order)).length > 0;
  res.json({
    success: true,
    order: {
      id: String(order._id), orderNo: order.orderNo ?? null, po: order.po || '',
      date: order.date, supplyDate: order.supplyDate, stage: STAGE[order.status],
      lines,
      totals: { ordered: sum('ordered'), produced: sum('produced'), dispatched: sum('dispatched'), toCome: sum('toCome') },
      dispatches: dcs.map((dc) => dcRow(dc, order)),
      hasCertificates,
    },
  });
}));

router.get('/orders/:id/certificates', catchAsyncErrors(async (req, res) => {
  const order = await myOrder(req, 'orderNo po');
  res.json({
    success: true,
    order: { id: String(order._id), orderNo: order.orderNo ?? null, po: order.po || '' },
    certificates: await certificatesFor(order),
  });
}));

// ── Dispatches ─────────────────────────────────────────────────────
router.get('/dispatches', catchAsyncErrors(async (req, res) => {
  const { limit, page: p, skip } = page(req.query);
  const mine = await ordersOf(req.customerId);
  if (!mine.match) return res.json({ success: true, total: 0, page: 1, pages: 1, dispatches: [] });
  const [total, dcs] = await Promise.all([
    leftDcs(mine.match).countDocuments(),
    leftDcs(mine.match).populate('items.elastic', 'name').sort({ dispatchDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({
    success: true, total, page: p, pages: Math.max(1, Math.ceil(total / limit)),
    dispatches: dcs.map((dc) => dcRow(dc, orderOfDc(dc, mine))),
  });
}));

/** One of the customer's challans that has left, or a 404. */
async function myDc(req) {
  if (!isId(req.params.id)) throw notFound('Dispatch');
  const mine = await ordersOf(req.customerId);
  if (!mine.match) throw notFound('Dispatch');
  const dc = await DeliveryChallan.findOne({ _id: req.params.id, $or: mine.match, status: { $in: LEFT }, type: { $ne: 'machine_part' } })
    .populate('items.elastic', 'name').lean();
  if (!dc) throw notFound('Dispatch');
  return { dc, order: orderOfDc(dc, mine) };
}

router.get('/dispatches/:id', catchAsyncErrors(async (req, res) => {
  const { dc, order } = await myDc(req);
  res.json({
    success: true,
    dispatch: {
      ...dcRow(dc, order),
      vehicleNo: dc.vehicleNo || '',
      transporter: dc.transporter || '',
      lrNumber: dc.lrNumber || '',
      receivedBy: dc.pod?.receivedBy || '',
    },
  });
}));

router.get('/dispatches/:id/pdf', catchAsyncErrors(async (req, res) => {
  const { dc } = await myDc(req);
  const pdf = await dcPdf(dc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition('inline', `DC-${dc.dcNumber || dc._id}.pdf`, 'challan.pdf'));
  res.send(pdf);
}));

router.get('/dispatches/:id/certificates', catchAsyncErrors(async (req, res) => {
  const { dc, order } = await myDc(req);
  const elastics = (dc.items || []).map((i) => i.elastic?._id || i.elastic).filter(Boolean);
  res.json({
    success: true,
    dispatch: { id: String(dc._id), dcNumber: dc.dcNumber, date: dcDate(dc) },
    order: order ? { id: String(order._id), orderNo: order.orderNo ?? null, po: order.po || '' } : null,
    certificates: order && elastics.length ? await certificatesFor(order, elastics) : [],
  });
}));

// ── Invoices and the account ──────────────────────────────────────
router.get('/invoices', MONEY, catchAsyncErrors(async (req, res) => {
  const { limit, page: p, skip } = page(req.query);
  const q = { customer: req.customerId, status: 'issued' };
  const all = await Invoice.find(q)
    .select('invoiceNumber invoiceDate dueDate orderNo totals.grand paidAmount creditedAmount debitedAmount')
    .sort({ invoiceDate: -1, createdAt: -1 }).lean();
  let rows = all.map((inv) => invoiceRow(inv));
  if (req.query.status === 'open') rows = rows.filter((r) => r.owed > 0);
  res.json({
    success: true, total: rows.length, page: p, pages: Math.max(1, Math.ceil(rows.length / limit)),
    totals: { owed: r2(rows.reduce((s, r) => s + r.owed, 0)), overdue: r2(rows.filter((r) => r.state === 'overdue').reduce((s, r) => s + r.owed, 0)) },
    invoices: rows.slice(skip, skip + limit),
  });
}));

router.get('/invoices/:id/pdf', MONEY, catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(notFound('Invoice'));
  const inv = await Invoice.findOne({ _id: req.params.id, customer: req.customerId, status: 'issued' });
  if (!inv) return next(notFound('Invoice'));
  const [branding, settings] = await Promise.all([getPdfBranding(), getDocumentSettings()]);
  const pdf = await renderPdf('invoice', { invoice: inv, branding, settings: { invoice: settings.invoice || {} } });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition('inline', `${inv.invoiceNumber.replace(/\//g, '-')}.pdf`, 'invoice.pdf'));
  res.send(pdf);
}));

/** The customer's account over a range, as the office keeps it. */
async function statementOf(req) {
  const from = readDate(req.query.from, 'from');
  let to = readDate(req.query.to, 'to');
  if (to) to = factoryDay.calendarDayEnd(to);
  const c = await Customer.findById(req.customerId).select('name gstin address city pincode phoneNumber accountant').lean();
  if (!c) throw notFound('Account');
  const party = {
    name: c.name, gstin: c.gstin || '',
    address: [c.address, [c.city, c.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    phone: c.accountant?.mobile || c.phoneNumber || '',
  };
  const statement = await partyStatement.ledgerAccount('customer', req.customerId, { from, to });
  const open = outstanding.totals(await outstanding.receivables({ customer: req.customerId }));
  return { party, statement, from, to, open };
}

router.get('/statement', MONEY, catchAsyncErrors(async (req, res) => {
  const { party, statement: s, from, to, open } = await statementOf(req);
  res.json({
    success: true,
    party: { name: party.name, gstin: party.gstin },
    from: from || null, to: to || null,
    opening: Math.abs(s.opening || 0), openingSide: s.openingSide,
    closing: Math.abs(s.closing || 0), closingSide: s.closingSide,
    totals: s.totals,
    rows: (s.rows || []).map((r) => ({
      date: r.date,
      particulars: r.memo ? r.particulars : [r.toBy, r.particulars].filter(Boolean).join(' '),
      type: r.vchType || '',
      number: r.docNo || '',
      reference: r.partyRef || '',
      debit: r2(r.debit || 0),
      credit: r2(r.credit || 0),
      balance: Math.abs(r2(r.balance || 0)),
      side: r.balanceSide || '',
      memo: !!r.memo,
    })),
    owed: { total: open.total, overdue: open.overdue, ageing: open.ageing },
  });
}));

router.get('/statement/pdf', MONEY, catchAsyncErrors(async (req, res) => {
  const s = await statementOf(req);
  const branding = await getPdfBranding();
  const pdf = await renderPdf('partyStatement', { partyType: 'customer', ...s, detailed: false, branding, company: branding.company });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition('inline', `Statement ${s.party.name}.pdf`, 'statement.pdf'));
  res.send(pdf);
}));

module.exports = router;
