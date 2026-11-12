'use strict';
// ══════════════════════════════════════════════════════════════════
//  CLOSING STOCK INTO THE BOOKS
//
//  The stores know what is on the shelf; the books do not, until the
//  closing stock is told to them. This values it on a day:
//
//    raw material   quantity as at the day (today's stock, less what
//                   moved since) × the weighted average cost
//                   (utils/materialValuation.js), the latest price when
//                   no average has formed
//    finished goods elastic in stock × its costing's cost per unit —
//                   cost, not selling price (AS-2: the lower of cost and
//                   what it would fetch)
//
//  and posts it the way a trader without stock-keeping in Tally does:
//  a journal on the day, Dr Stock-in-Hand / Cr Closing Stock (the P&L
//  side), and its reversal on the next day so the period after opens
//  with the same stock. Posting again replaces both.
//
//  What could not be valued is said, not valued at nothing.
// ══════════════════════════════════════════════════════════════════

const RawMaterial = require('../models/RawMaterial');
const Elastic = require('../models/Elastic');
const Journal = require('../models/Journal');
const ErrorHandler = require('../utils/ErrorHandler');
const journals = require('./journals');
const { getSettings } = require('./booksLock');

const { r2 } = require('../utils/money');
const DAY = 86_400_000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

const DEFAULT = { stockInHand: 'Stock-in-Hand', closingStock: 'Closing Stock' };
async function ledgers() {
  const t = (await getSettings()).tally || {};
  return Object.fromEntries(Object.entries(DEFAULT).map(([k, v]) => [k, String(t[k] || '').trim() || v]));
}

/** Stock as at the end of `asOf`: today's figure less every movement after it. */
function asAt(Model, asOf, extra = {}) {
  const end = new Date(new Date(asOf).getTime() + DAY - 1);
  return Model.aggregate([
    { $match: { archived: { $ne: true }, ...extra } },
    { $project: {
      name: 1, category: 1, unit: 1, stock: 1, avgCost: 1, price: 1, costing: 1,
      after: { $sum: { $map: { input: { $filter: { input: { $ifNull: ['$stockMovements', []] }, as: 'm', cond: { $gt: ['$$m.date', end] } } }, as: 'm', in: { $ifNull: ['$$m.quantity', 0] } } } },
    } },
  ]);
}

async function value(asOf) {
  const warnings = [];
  const raw = await asAt(RawMaterial, asOf);
  const rawRows = [];
  const byCategory = new Map();
  for (const m of raw) {
    const qty = Math.max(0, r2((m.stock || 0) - (m.after || 0)));
    if (qty <= 0) continue;
    const rate = m.avgCost > 0 ? m.avgCost : (m.price || 0);
    if (!(rate > 0)) warnings.push(`${m.name}: ${qty} ${m.unit || 'kg'} on hand but no cost or price on the material — valued at ₹0`);
    const val = r2(qty * rate);
    rawRows.push({ id: m._id, name: m.name, category: m.category || '', unit: m.unit || 'kg', quantity: qty, rate: r2(rate), basis: m.avgCost > 0 ? 'average' : 'price', value: val });
    const c = byCategory.get(m.category || 'other') || { category: m.category || 'other', quantity: 0, value: 0, items: 0 };
    c.quantity = r2(c.quantity + qty); c.value = r2(c.value + val); c.items += 1;
    byCategory.set(m.category || 'other', c);
  }
  const fg = await asAt(Elastic, asOf, { $or: [{ stock: { $gt: 0 } }, { 'stockMovements.0': { $exists: true } }] });
  const costings = new Map();
  const ids = fg.map((e) => e.costing).filter(Boolean);
  if (ids.length) {
    const Costing = require('../models/Costing');
    for (const c of await Costing.find({ _id: { $in: ids } }).select('totalCost status').lean()) costings.set(String(c._id), c);
  }
  const fgRows = [];
  for (const e of fg) {
    const qty = Math.max(0, r2((e.stock || 0) - (e.after || 0)));
    if (qty <= 0) continue;
    const c = e.costing ? costings.get(String(e.costing)) : null;
    const rate = r2(c?.totalCost || 0);
    if (!(rate > 0)) warnings.push(`${e.name}: ${qty} m in stock but no costing to value it at — valued at ₹0`);
    fgRows.push({ id: e._id, name: e.name, quantity: qty, unit: 'm', rate, value: r2(qty * rate), costingStatus: c?.status || '' });
  }
  const rawTotal = r2(rawRows.reduce((s, r) => s + r.value, 0));
  const fgTotal = r2(fgRows.reduce((s, r) => s + r.value, 0));
  const ref = ymd(asOf);
  const [closing, opening] = await Promise.all([
    Journal.findOne({ source: 'stock', sourceRef: `close:${ref}`, status: 'posted' }).select('journalNo date total').lean(),
    Journal.findOne({ source: 'stock', sourceRef: `open:${ref}`, status: 'posted' }).select('journalNo date total').lean(),
  ]);
  // Every stock posting so far, newest first, so the year's closings are in view.
  const history = await Journal.find({ source: 'stock', status: 'posted', sourceRef: /^close:/ }).select('journalNo date total sourceRef').sort({ date: -1 }).limit(12).lean();
  return {
    asOf: new Date(asOf), rawMaterials: { rows: rawRows.sort((a, b) => b.value - a.value), byCategory: [...byCategory.values()].sort((a, b) => b.value - a.value), total: rawTotal },
    finishedGoods: { rows: fgRows.sort((a, b) => b.value - a.value), total: fgTotal },
    total: r2(rawTotal + fgTotal), warnings,
    journals: { closing, opening, stale: closing ? Math.abs(closing.total - r2(rawTotal + fgTotal)) > 0.005 : false },
    history: history.map((h) => ({ ...h, asOf: h.sourceRef.slice(6) })),
  };
}

function replace(ref, build, req) {
  return journals.replace({ ...build, source: 'stock', sourceRef: ref }, 'Replaced by a fresh stock valuation', req);
}

/** Post the closing stock on `asOf` and bring it forward the next day. */
async function post(asOf, req) {
  const v = await value(asOf);
  if (!(v.total > 0)) throw new ErrorHandler(`Nothing valued on ${ymd(asOf)} — no stock, or nothing with a cost`, 409);
  const L = await ledgers();
  const ref = ymd(asOf);
  const closing = await replace(`close:${ref}`, {
    date: new Date(`${ref}T00:00:00Z`), purpose: 'stock', narration: `Closing stock as at ${ref}: raw material ₹${v.rawMaterials.total.toFixed(2)}, finished goods ₹${v.finishedGoods.total.toFixed(2)}`, reason: `Stock valued on ${ref}`,
    lines: [{ kind: 'ledger', ledger: L.stockInHand, debit: v.total }, { kind: 'ledger', ledger: L.closingStock, credit: v.total }],
  }, req);
  const opening = await replace(`open:${ref}`, {
    date: new Date(new Date(`${ref}T00:00:00Z`).getTime() + DAY), purpose: 'stock', narration: `Opening stock brought forward from ${ref}`, reason: `Stock valued on ${ref}`,
    lines: [{ kind: 'ledger', ledger: L.closingStock, debit: v.total }, { kind: 'ledger', ledger: L.stockInHand, credit: v.total }],
  }, req);
  return { closing: closing.journal, opening: opening.journal, valuation: await value(asOf) };
}

module.exports = { value, post, ledgers };
