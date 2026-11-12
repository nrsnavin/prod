'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CHANGES WORTH A SECOND LOOK
//
//  Every meaningful change already leaves a fingerprint on its document
//  (utils/fingerprint.js) and the audit page lists them, newest first —
//  hundreds a week, most of them routine. Only payments had a fraud
//  check. This reads the same trail for the kinds of change that are
//  either mistakes or how money and stock quietly go missing:
//
//    cancelled   an invoice, bill, payment, note, journal or contra undone
//    deleted     an order, PO, challan, packing, wastage or shift entry removed
//    edited      verified shift production changed afterwards
//    backdated   a money document dated more than a week before it was entered
//    late night  changes made between 10 pm and 5 am in India
//    stock       a stock count posted or elastic stock adjusted by hand
//    access      logins created, changed or removed; Aadhaar numbers viewed
//
//  It reads only. Each item says who, when, and which document, so it
//  can be opened and asked about. Sent to the owner each Monday morning
//  (the scheduler in services/scheduledReports.js), and on the audit page.
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');

const DAY = 86_400_000;
const BACKDATE_DAYS = 7;
const LATE_FROM = 22; const LATE_TO = 5; // India hours: 22:00–04:59

const M = (name) => require(`../models/${name}`);
// Every collection whose documents carry fingerprints, as the audit feed reads them.
const SOURCES = [
  ['Order', 'Order', 'orderNo'], ['JobOrder', 'JobOrder', 'jobOrderNo'], ['PurchaseOrder', 'PurchaseOrder', 'poNo'],
  ['DeliveryChallan', 'DeliveryChallan', 'dcNumber'], ['Invoice', 'Invoice', 'invoiceNumber'], ['SupplierBill', 'SupplierBill', 'billNo'],
  ['Expense', 'Expense', 'expenseNo'], ['AccountNote', 'AccountNote', 'noteNo'], ['Payment', 'Payment', 'voucherNo'],
  ['Contra', 'Contra', 'contraNo'], ['Journal', 'Journal', 'journalNo'], ['Quote', 'Quote', 'quoteNo'], ['StockCount', 'StockCount', 'countNo'],
];

const CANCELLED = new Set(['INVOICE_CANCELLED', 'BILL_CANCELLED', 'PAYMENT_CANCELLED', 'NOTE_CANCELLED', 'JOURNAL_CANCELLED', 'CONTRA_CANCELLED', 'EXPENSE_CANCELLED', 'DC_CANCELLED']);
const DELETED = new Set(['ORDER_DELETED', 'PO_DELETED', 'DC_DELETED', 'PACKING_DELETED', 'WASTAGE_DELETED', 'SHIFT_PRODUCTION_DELETED', 'WARPING_PLAN_DELETED']);
const EDITED = new Set(['SHIFT_PRODUCTION_EDITED']);
const STOCK = new Set(['STOCK_COUNT_POSTED', 'ELASTIC_STOCK_ADJUST']);
const ACCESS = new Set(['LOGIN_CREATED', 'LOGIN_UPDATED', 'LOGIN_DELETED', 'PHONE_SIGNIN_RESET', 'AADHAAR_VIEWED', 'AADHAAR_QR_CHECKED']);
// Access entries about an employee record rather than a login.
const ABOUT_EMPLOYEE = new Set(['AADHAAR_VIEWED', 'AADHAAR_QR_CHECKED']);

// Money documents and their own date, for back-dating.
const DATED = [
  ['Invoice', 'invoiceDate', 'invoiceNumber', (d) => d.totals?.grand], ['SupplierBill', 'billDate', 'billNo', (d) => d.totals?.grand],
  ['Payment', 'date', 'voucherNo', (d) => d.amount], ['Expense', 'date', 'expenseNo', (d) => d.totals?.grand],
  ['Journal', 'date', 'journalNo', (d) => d.total], ['AccountNote', 'date', 'noteNo', (d) => d.totals?.grand ?? d.amount],
  ['Contra', 'date', 'contraNo', (d) => d.amount],
];

const inr = (n) => (Number.isFinite(Number(n)) ? `₹${Math.round(Number(n)).toLocaleString('en-IN')}` : '');
const who = (a) => a?.name || a?.email || 'Someone';
const indiaHour = (at) => new Date(new Date(at).getTime() + factoryDay.IST).getUTCHours();
const when = (at) => new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

async function fingerprintsBetween([model, type, numberField], from, to) {
  return M(model).aggregate([
    // `at` is a Date; older entries may hold the ISO text — match either.
    { $match: { $or: [
      { fingerprints: { $elemMatch: { at: { $gte: from, $lt: to } } } },
      { fingerprints: { $elemMatch: { at: { $gte: from.toISOString(), $lt: to.toISOString() } } } },
    ] } },
    { $project: { fingerprints: 1, no: `$${numberField}` } },
    { $unwind: '$fingerprints' },
    { $project: { _id: 0, entityType: type, entityId: '$_id', entityNo: '$no', code: '$fingerprints.code', label: '$fingerprints.label', at: '$fingerprints.at', actor: '$fingerprints.actor', reason: '$fingerprints.meta.auditReason', meta: '$fingerprints.meta' } },
  ]).then((rows) => rows.filter((r) => r.at && new Date(r.at) >= from && new Date(r.at) < to));
}

/** The week's changes worth a second look. */
async function watch({ days = 7, now = new Date() } = {}) {
  const to = new Date(now);
  const from = new Date(to.getTime() - Math.min(Math.max(Number(days) || 7, 1), 31) * DAY);
  const [prints, access] = await Promise.all([
    Promise.all(SOURCES.map((s) => fingerprintsBetween(s, from, to).catch(() => []))).then((xs) => xs.flat()),
    M('AccessEvent').find({ at: { $gte: from, $lt: to } }).lean(),
  ]);
  const items = [];
  const push = (kind, severity, e, title, detail = '') => items.push({
    kind, severity, title, detail, at: e.at, actor: who(e.actor), entityType: e.entityType, entityId: e.entityId ? String(e.entityId) : null, entityNo: e.entityNo ?? null,
  });

  for (const e of prints) {
    const doc = `${e.entityType} ${e.entityNo ?? ''}`.trim();
    if (CANCELLED.has(e.code)) push('cancelled', 'check', e, `${doc} cancelled`, e.reason ? `Reason: ${e.reason}` : 'No reason given');
    else if (DELETED.has(e.code)) push('deleted', 'check', e, `${e.label || e.code} on ${doc}`, e.reason ? `Reason: ${e.reason}` : 'No reason given');
    else if (EDITED.has(e.code)) push('edited', 'check', e, `Verified production edited on ${doc}`, e.reason ? `Reason: ${e.reason}` : '');
    else if (STOCK.has(e.code)) push('stock', 'info', e, `${e.label || e.code}${e.entityNo != null ? ` (${doc})` : ''}`, e.meta?.valueVariance != null ? `Variance ${inr(e.meta.valueVariance)}` : '');
  }
  for (const a of access) {
    if (!ACCESS.has(a.code)) continue;
    const e = { ...a, entityType: ABOUT_EMPLOYEE.has(a.code) ? 'Employee' : 'Login', entityId: a.subject?.id, entityNo: a.subject?.name };
    push('access', ABOUT_EMPLOYEE.has(a.code) || a.code === 'LOGIN_UPDATED' ? 'info' : 'check', e, `${a.label || a.code}: ${a.subject?.name || a.subject?.email || ''}`.trim(), a.meta?.changes ? `Changed: ${[].concat(a.meta.changes).join(', ')}` : '');
  }

  // Late at night: one line per person, with how many changes.
  const late = new Map();
  for (const e of [...prints, ...access]) {
    const h = indiaHour(e.at);
    if (!(h >= LATE_FROM || h < LATE_TO)) continue;
    const k = who(e.actor);
    if (!late.has(k)) late.set(k, []);
    late.get(k).push(e);
  }
  for (const [name, list] of late) {
    if (name === 'System') continue;
    list.sort((a, b) => new Date(a.at) - new Date(b.at));
    items.push({ kind: 'late-night', severity: 'check', title: `${name} made ${list.length} change${list.length === 1 ? '' : 's'} between 10 pm and 5 am`, detail: list.slice(0, 5).map((e) => `${when(e.at)} ${e.label || e.code}${e.entityNo != null ? ` ${e.entityType} ${e.entityNo}` : ''}`).join('; '), at: list[0].at, actor: name, entityType: null, entityId: null, entityNo: null });
  }

  // Back-dated money documents entered this week.
  for (const [model, dateField, noField, amountOf] of DATED) {
    const docs = await M(model).find({ createdAt: { $gte: from, $lt: to } }).select(`${dateField} ${noField} createdAt createdBy createdByName totals amount total fingerprints`).lean().catch(() => []);
    for (const d of docs) {
      const docDay = factoryDay.calendarDay(d[dateField]);
      const entered = factoryDay.calendarDay(d.createdAt);
      if (!docDay || !entered) continue;
      const back = Math.round((entered - docDay) / DAY);
      if (back <= BACKDATE_DAYS) continue;
      const actor = d.fingerprints?.[0]?.actor || (d.createdByName ? { name: d.createdByName } : null);
      items.push({ kind: 'backdated', severity: back > 30 ? 'check' : 'info', title: `${model} ${d[noField] ?? ''} dated ${back} days before it was entered`.replace('  ', ' '), detail: `Dated ${factoryDay.ymd(docDay)}, entered ${factoryDay.ymd(entered)}${amountOf(d) ? ` · ${inr(amountOf(d))}` : ''}`, at: d.createdAt, actor: who(actor), entityType: model, entityId: String(d._id), entityNo: d[noField] ?? null });
    }
  }

  const order = { check: 0, info: 1 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || new Date(b.at) - new Date(a.at));
  const counts = items.reduce((c, i) => ({ ...c, [i.kind]: (c[i.kind] || 0) + 1 }), {});
  return { from, to, counts, total: items.length, toLookAt: items.filter((i) => i.severity === 'check').length, items };
}

const KIND_WORDS = { cancelled: 'cancelled', deleted: 'deleted', edited: 'production edited after verifying', backdated: 'back-dated', 'late-night': 'people working late at night', stock: 'stock adjusted', access: 'login changes' };

/** The WhatsApp summary for the owner. */
function message(w) {
  const head = `🔎 *Changes worth a look* — ${factoryDay.ymd(w.from)} to ${factoryDay.ymd(new Date(w.to.getTime() - 1))}`;
  if (!w.total) return `${head}\nNothing unusual this week.`;
  const counts = Object.entries(w.counts).map(([k, n]) => `${n} ${KIND_WORDS[k] || k}`).join(' · ');
  const top = w.items.filter((i) => i.severity === 'check').slice(0, 8).map((i) => `• ${i.title} — ${i.actor}${i.detail ? ` (${i.detail})` : ''}`);
  return [head, counts, ...top, w.toLookAt > 8 ? `…and ${w.toLookAt - 8} more on the audit page.` : ''].filter(Boolean).join('\n');
}

/** Monday's run: build it and send it. */
async function runWeekly({ now = new Date() } = {}) {
  const w = await watch({ days: 7, now });
  const { notify } = require('../utils/notify');
  const result = await notify('auditWatch', { body: message(w) });
  return { total: w.total, toLookAt: w.toLookAt, result };
}

module.exports = { watch, message, runWeekly, KIND_WORDS };
