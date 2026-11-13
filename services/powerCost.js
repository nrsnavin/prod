'use strict';
// ══════════════════════════════════════════════════════════════════
//  POWER COST PER METRE
//
//  fromPhoto({ pages }) → { read, draft, checks, duplicate, aiSuggestion }
//    The month's electricity bill is read (utils/paperReaders.js); the
//    server checks the parts add up to the total, works the rate per
//    unit, takes the month the bill is for (its period's end), and names
//    a bill already kept for that month and connection. Nothing is saved.
//  save(body)   the confirmed figures kept for the month.
//  report()     each month: units, the bill, metres woven (closed shift
//               entries), power cost per metre and units per metre, and
//               how each moved on the month before.
// ══════════════════════════════════════════════════════════════════

const PowerBill = require('../models/PowerBill');
const ShiftDetail = require('../models/ShiftDetail');
const bizDates = require('../utils/bizDates');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');
const { r2 } = require('../utils/money');

const SURFACE = 'power-bill-ocr';
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const day = (iso) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

/** The month a bill is for: its period's end, else the month before its date. */
function monthOf(read) {
  if (read.periodTo) return read.periodTo.slice(0, 7);
  if (read.billDate) return bizDates.shiftMonth(read.billDate.slice(0, 7), -1);
  return null;
}

async function fromPhoto({ pages } = {}) {
  const startedAt = Date.now();
  let read;
  try {
    read = await require('../utils/paperReaders').readPowerBill(pages);
  } catch (err) {
    if (!err.code) await aiLedger.record({ surface: SURFACE, model: '?', promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
    throw err;
  }
  const { model, usage, latencyMs, ...fields } = read;
  const record = (proposed) => aiLedger.record({ surface: SURFACE, model, promptVersion: promptVersion(SURFACE), proposed, latencyMs, usage })
    .then((id) => (id ? String(id) : null)).catch(() => null);
  if (fields.problem) return { read: fields, draft: null, checks: [], duplicate: null, aiSuggestion: await record({ problem: fields.problem }) };
  const checks = [];
  const flag = (code, severity, message) => checks.push({ code, severity, message });
  if (!(fields.units > 0)) flag('UNITS', 'danger', 'The units used were not read: type them from the bill');
  if (!(fields.total > 0)) flag('TOTAL', 'danger', 'The total was not read');
  const parts = r2(['energyCharges', 'demandCharges', 'otherCharges', 'tax'].reduce((t, k) => t + (fields[k] || 0), 0));
  if (fields.total > 0 && parts > 0 && Math.abs(parts - fields.total) > Math.max(2, fields.total * 0.01)) {
    flag('PARTS', 'warning', `Energy, demand, other charges and tax make ${rupees(parts)}; the bill's total is ${rupees(fields.total)}. Check what was read`);
  }
  const month = monthOf(fields);
  if (!month) flag('MONTH', 'warning', 'The billing period was not read: pick the month');
  const ratePerUnit = fields.units > 0 && fields.total > 0 ? r2(fields.total / fields.units) : null;
  if (ratePerUnit != null && (ratePerUnit < 3 || ratePerUnit > 20)) flag('RATE', 'warning', `That works out to ${rupees(ratePerUnit)} a unit, outside what a Tamil Nadu bill usually comes to: check the units and the total`);
  let duplicate = null;
  if (month) {
    const d = await PowerBill.findOne({ month, consumerNo: fields.consumerNo || '' }).select('total units').lean();
    if (d) duplicate = { _id: String(d._id), total: d.total, units: d.units };
  }
  const draft = {
    month: month || '', consumerNo: fields.consumerNo, billNo: fields.billNo, billDate: fields.billDate, periodFrom: fields.periodFrom, periodTo: fields.periodTo,
    units: fields.units, demandKva: fields.demandKva, energyCharges: fields.energyCharges, demandCharges: fields.demandCharges, otherCharges: fields.otherCharges,
    tax: fields.tax, total: fields.total, dueDate: fields.dueDate, ratePerUnit,
  };
  return { read: fields, draft, checks, duplicate, aiSuggestion: await record({ month, units: fields.units, total: fields.total }) };
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Keep the confirmed figures for the month. */
async function save(b, { by = null } = {}) {
  const month = String(b.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw Object.assign(new Error('Pick the month the bill is for'), { status: 400 });
  const units = num(b.units); const total = num(b.total);
  if (!(units > 0)) throw Object.assign(new Error('The units used are needed'), { status: 400 });
  if (!(total > 0)) throw Object.assign(new Error('The bill\'s total is needed'), { status: 400 });
  const data = {
    month, consumerNo: String(b.consumerNo || '').trim().slice(0, 40), billNo: String(b.billNo || '').trim().slice(0, 40),
    billDate: day(b.billDate), periodFrom: day(b.periodFrom), periodTo: day(b.periodTo), dueDate: day(b.dueDate),
    units: r2(units), total: r2(total), demandKva: num(b.demandKva), energyCharges: num(b.energyCharges), demandCharges: num(b.demandCharges), otherCharges: num(b.otherCharges), tax: num(b.tax),
    note: String(b.note || '').trim().slice(0, 200), aiSuggestion: String(b.aiSuggestion || ''), createdBy: by,
  };
  try {
    const doc = await PowerBill.create(data);
    if (data.aiSuggestion) aiLedger.settle(data.aiSuggestion, { accepted: { month, units: data.units, total: data.total }, decidedBy: by, expectSurface: SURFACE }).catch(() => null);
    return doc.toObject();
  } catch (err) {
    if (err?.code === 11000) throw Object.assign(new Error(`The bill for ${month}${data.consumerNo ? ` on connection ${data.consumerNo}` : ''} is kept already`), { status: 409 });
    throw err;
  }
}

/** Metres woven in a month: the closed shift entries. */
async function metresIn(month) {
  const { from, to } = bizDates.monthRange(month);
  const [row] = await ShiftDetail.aggregate([
    { $match: { status: 'closed', date: { $gte: from, $lte: to } } },
    { $group: { _id: null, metres: { $sum: { $ifNull: ['$productionMeters', 0] } } } },
  ]);
  return row?.metres || 0;
}

/** Each month with a bill: units, the bill, metres woven, cost and units per metre. */
async function report({ months = 12 } = {}) {
  const bills = await PowerBill.find({}).sort({ month: -1 }).limit(months * 4).lean();
  const byMonth = new Map();
  for (const b of bills) {
    const g = byMonth.get(b.month) || { month: b.month, units: 0, total: 0, bills: [] };
    g.units = r2(g.units + b.units); g.total = r2(g.total + b.total);
    g.bills.push({ _id: b._id, consumerNo: b.consumerNo, units: b.units, total: b.total });
    byMonth.set(b.month, g);
  }
  const rows = [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1)).slice(0, months);
  for (const r of rows) {
    r.metres = Math.round(await metresIn(r.month));
    r.ratePerUnit = r.units > 0 ? r2(r.total / r.units) : null;
    r.costPerMetre = r.metres > 0 ? r2(r.total / r.metres) : null;
    r.unitsPerMetre = r.metres > 0 ? Math.round((r.units / r.metres) * 1000) / 1000 : null;
  }
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i + 1];
    rows[i].change = prev && prev.costPerMetre && rows[i].costPerMetre ? r2(((rows[i].costPerMetre - prev.costPerMetre) / prev.costPerMetre) * 100) : null;
  }
  return { rows };
}

module.exports = { fromPhoto, save, report, metresIn, monthOf, SURFACE };
