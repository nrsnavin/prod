'use strict';
// ══════════════════════════════════════════════════════════════════
//  FIXED ASSET REGISTER AND DEPRECIATION
//
//  Two schedules for every asset, because two laws want two answers:
//
//  Companies Act (Schedule II)   from the day the asset was put to use,
//    pro rata by days, over its useful life, down to a residual value
//    (5% unless set otherwise). Written-down value by default — the rate
//    is 1 − (residual ÷ cost)^(1 ÷ life) — or straight line. This is the
//    figure the books carry: the year's depreciation journal
//    (Dr Depreciation, Cr Accumulated Depreciation) is its total.
//
//  Income-tax Act (s.32)         the block's rate on written-down value,
//    half the rate in the year of purchase when the asset was used for
//    under 180 days, nothing in the year it is sold (the sale comes off
//    the block instead; more than the block held is a s.50 gain).
//
//  Neither schedule is stored; both are worked out from the asset's
//  cost, dates and block whenever the register is read, so a corrected
//  date corrects every year at once. An asset that pre-dates these books
//  starts from `openingWdv` instead of cost.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const FixedAsset = require('../models/FixedAsset');
const { BLOCKS } = require('../models/FixedAsset');
const Journal = require('../models/Journal');
const SupplierBill = require('../models/SupplierBill');
const Supplier = require('../models/Supplier');
const Machine = require('../models/Machine');
const journals = require('./journals');
const { allocate } = require('./docNumbers');
const { getSettings } = require('./booksLock');
const { isId, r2, fp } = require('./accountsHelpers');
const { ACTION_CODES } = require('../utils/fingerprint');

const DAY = 86_400_000;
const FY_RE = /^\d{4}-\d{2}$/;

/** "2026-27" for a date (financial year April–March), in UTC like every document date. */
function fyOf(d) {
  const x = new Date(d);
  const y = x.getUTCMonth() >= 3 ? x.getUTCFullYear() : x.getUTCFullYear() - 1;
  return `${y}-${String(y + 1).slice(2)}`;
}
const fyStartYear = (fy) => Number(String(fy).slice(0, 4));
const fyStart = (fy) => new Date(Date.UTC(fyStartYear(fy), 3, 1));
const fyEnd = (fy) => new Date(Date.UTC(fyStartYear(fy) + 1, 2, 31, 23, 59, 59, 999));
const nextFy = (fy) => { const y = fyStartYear(fy) + 1; return `${y}-${String(y + 1).slice(2)}`; };
const daysBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / DAY) + 1);   // inclusive
const daysInFy = (fy) => daysBetween(fyStart(fy), new Date(Date.UTC(fyStartYear(fy) + 1, 2, 31)));

const DEFAULT = { depreciation: 'Depreciation', accumulatedDepreciation: 'Accumulated Depreciation' };
async function ledgers() {
  const t = (await getSettings()).tally || {};
  return Object.fromEntries(Object.entries(DEFAULT).map(([k, v]) => [k, String(t[k] || '').trim() || v]));
}

/** The Companies Act WDV rate for a cost, residual and life: 1 − (S/C)^(1/n). */
function wdvRate(cost, residual, life) {
  if (!(cost > 0) || !(life > 0)) return 0;
  const frac = Math.max(residual / cost, 0.0001);   // a nil residual would otherwise need an infinite rate
  return 1 - Math.pow(frac, 1 / life);
}

/**
 * The asset's year `fy` under both acts, rolled forward from where its
 * schedule starts (the opening WDV it came in with, else its cost on the
 * day it was put to use). Returns null when the year is before the asset
 * existed or after it was disposed of.
 */
function schedule(asset, fy) {
  const cost = r2(asset.cost);
  const life = asset.lifeYears || BLOCKS[asset.block]?.life || 10;
  const itRate = (BLOCKS[asset.block]?.itRate || 0) / 100;
  const residual = r2(cost * (asset.residualPercent ?? 5) / 100);
  const useFy = fyOf(asset.putToUse);
  const disposed = asset.status !== 'active' && asset.disposal?.date ? asset.disposal : null;
  const disposalFy = disposed ? fyOf(disposed.date) : null;
  if (fyStart(fy) > fyEnd(fy)) return null;
  if (fyStartYear(fy) < fyStartYear(useFy)) return null;
  if (disposalFy && fyStartYear(fy) > fyStartYear(disposalFy)) return null;

  // Where the schedule starts.
  let y = useFy;
  let ca = cost; let it = cost;
  const opening = asset.openingWdv || {};
  if (FY_RE.test(opening.fy || '') && Number.isFinite(Number(opening.companiesAct)) && fyStartYear(opening.fy) > fyStartYear(useFy)) {
    y = opening.fy; ca = r2(opening.companiesAct); it = Number.isFinite(Number(opening.incomeTax)) ? r2(opening.incomeTax) : ca;
  }
  if (fyStartYear(fy) < fyStartYear(y)) return null;

  const rate = asset.method === 'slm' ? 0 : wdvRate(cost, residual, life);
  const slmYear = asset.method === 'slm' ? r2((cost - residual) / life) : 0;
  let row = null;
  while (fyStartYear(y) <= fyStartYear(fy)) {
    // Days in use this year, for the Companies Act pro rata.
    const from = y === useFy ? new Date(asset.putToUse) : fyStart(y);
    const to = disposalFy === y ? new Date(disposed.date) : new Date(Date.UTC(fyStartYear(y) + 1, 2, 31));
    const days = Math.min(daysInFy(y), daysBetween(from, to));
    const fraction = days / daysInFy(y);
    let caDep = asset.method === 'slm' ? slmYear * fraction : ca * rate * fraction;
    caDep = r2(Math.max(0, Math.min(caDep, ca - residual)));
    // Income-tax: half rate under 180 days in the year of purchase; nothing in the year of sale.
    const daysFirst = y === useFy ? daysBetween(asset.putToUse, new Date(Date.UTC(fyStartYear(y) + 1, 2, 31))) : 366;
    const half = y === useFy && daysFirst < 180;
    let itDep = disposalFy === y ? 0 : r2(it * itRate * (half ? 0.5 : 1));
    itDep = Math.min(itDep, it);
    const out = {
      fy: y, days, fraction: Math.round(fraction * 1000) / 1000, halfRate: half,
      companiesAct: { opening: ca, depreciation: caDep, closing: r2(ca - caDep), rate: asset.method === 'slm' ? null : Math.round(rate * 10000) / 100, method: asset.method },
      incomeTax: { opening: it, depreciation: itDep, closing: r2(it - itDep), rate: itRate * 100 },
      disposal: null,
    };
    if (disposalFy === y) {
      const amount = r2(disposed.amount || 0);
      const wdvAtSale = out.companiesAct.closing;
      out.disposal = {
        date: disposed.date, amount, wdv: wdvAtSale, gainLoss: r2(amount - wdvAtSale),
        // Off the block: the block falls by the money received; the excess over the block is a short-term capital gain (s.50).
        itBlockAfter: r2(Math.max(0, it - amount)), itGain: r2(Math.max(0, amount - it)),
      };
      out.companiesAct.closing = 0;
      out.incomeTax.closing = out.disposal.itBlockAfter;
    }
    row = out;
    ca = out.companiesAct.closing; it = out.incomeTax.closing;
    y = nextFy(y);
  }
  return row;
}

/** The register for a year: every asset live in it, with that year's figures, and the posting. */
async function register(fy) {
  const assets = await FixedAsset.find({ putToUse: { $lte: fyEnd(fy) } }).select('-attachments.data').sort({ block: 1, putToUse: 1 }).lean();
  const rows = [];
  const byBlock = new Map();
  const sum = { cost: 0, caOpening: 0, caDep: 0, caClosing: 0, itOpening: 0, itDep: 0, itClosing: 0, additions: 0, disposals: 0 };
  for (const a of assets) {
    const s = schedule(a, fy);
    if (!s) continue;
    const row = { ...a, year: s, blockLabel: BLOCKS[a.block]?.label || a.block, addedThisYear: fyOf(a.putToUse) === fy };
    rows.push(row);
    const b = byBlock.get(a.block) || { block: a.block, label: BLOCKS[a.block]?.label || a.block, itRate: BLOCKS[a.block]?.itRate || 0, count: 0, cost: 0, caOpening: 0, caDep: 0, caClosing: 0, itOpening: 0, itDep: 0, itClosing: 0 };
    b.count += 1; b.cost = r2(b.cost + a.cost);
    b.caOpening = r2(b.caOpening + s.companiesAct.opening); b.caDep = r2(b.caDep + s.companiesAct.depreciation); b.caClosing = r2(b.caClosing + s.companiesAct.closing);
    b.itOpening = r2(b.itOpening + s.incomeTax.opening); b.itDep = r2(b.itDep + s.incomeTax.depreciation); b.itClosing = r2(b.itClosing + s.incomeTax.closing);
    byBlock.set(a.block, b);
    sum.cost = r2(sum.cost + a.cost);
    sum.caOpening = r2(sum.caOpening + s.companiesAct.opening); sum.caDep = r2(sum.caDep + s.companiesAct.depreciation); sum.caClosing = r2(sum.caClosing + s.companiesAct.closing);
    sum.itOpening = r2(sum.itOpening + s.incomeTax.opening); sum.itDep = r2(sum.itDep + s.incomeTax.depreciation); sum.itClosing = r2(sum.itClosing + s.incomeTax.closing);
    if (row.addedThisYear) sum.additions = r2(sum.additions + a.cost);
    if (s.disposal) sum.disposals = r2(sum.disposals + s.disposal.amount);
  }
  const journal = await Journal.findOne({ source: 'depreciation', sourceRef: fy, status: 'posted' }).select('journalNo date total').lean();
  return {
    fy, from: fyStart(fy), to: fyEnd(fy), rows, blocks: [...byBlock.values()], totals: sum,
    journal, journalStale: journal ? Math.abs(journal.total - sum.caDep) > 0.005 : false,
    // Book depreciation less tax depreciation: the timing difference deferred tax is worked on.
    timingDifference: r2(sum.caDep - sum.itDep),
    blockTable: Object.entries(BLOCKS).map(([key, b]) => ({ key, ...b })),
  };
}

/** Post (or re-post) the year's Companies Act depreciation as one journal. */
async function postDepreciation(fy, req) {
  if (!FY_RE.test(String(fy || ''))) throw new ErrorHandler('fy must be like 2026-27', 400);
  const reg = await register(fy);
  if (!(reg.totals.caDep > 0)) throw new ErrorHandler(`No depreciation to post for ${fy}`, 409);
  const L = await ledgers();
  const old = await Journal.findOne({ source: 'depreciation', sourceRef: fy, status: 'posted' }).lean();
  if (old) await journals.cancel(old, 'Replaced by a fresh posting of the year\'s depreciation', req);
  const lines = [
    { kind: 'ledger', ledger: L.depreciation, debit: reg.totals.caDep },
    { kind: 'ledger', ledger: L.accumulatedDepreciation, credit: reg.totals.caDep },
  ];
  const read = await journals.read({ lines });
  const out = await journals.post({
    date: new Date(Date.UTC(fyStartYear(fy) + 1, 2, 31)), purpose: 'depreciation',
    narration: `Depreciation for ${fy} on ${reg.rows.length} assets (Schedule II)`, reason: `Fixed asset register ${fy}`,
    lines: read.lines, total: read.total, source: 'depreciation', sourceRef: fy,
  }, req);
  return { ...out, register: await register(fy) };
}

/** Read an asset from a request body, filling what a bill or a machine already says. */
async function create(b, req) {
  if (b.requestId) {
    const dup = await FixedAsset.findOne({ requestId: String(b.requestId) }).lean();
    if (dup) return { asset: dup, replay: true };
  }
  const name = String(b.name || '').trim();
  if (name.length < 2) throw new ErrorHandler('Name the asset', 400);
  if (!BLOCKS[b.block]) throw new ErrorHandler(`block must be one of ${Object.keys(BLOCKS).join(', ')}`, 400);
  const cost = r2(b.cost);
  if (!(cost > 0)) throw new ErrorHandler('cost must be more than 0', 400);
  const purchaseDate = b.purchaseDate ? new Date(b.purchaseDate) : null;
  if (!purchaseDate || Number.isNaN(purchaseDate.getTime())) throw new ErrorHandler('purchaseDate is required', 400);
  const putToUse = b.putToUse ? new Date(b.putToUse) : purchaseDate;
  if (Number.isNaN(putToUse.getTime())) throw new ErrorHandler('putToUse is not a date', 400);
  if (putToUse < purchaseDate) throw new ErrorHandler('An asset cannot be put to use before it was bought', 400);
  const residualPercent = b.residualPercent === undefined || b.residualPercent === '' ? 5 : Number(b.residualPercent);
  if (!(residualPercent >= 0 && residualPercent <= 50)) throw new ErrorHandler('residualPercent must be between 0 and 50', 400);
  const lifeYears = b.lifeYears === undefined || b.lifeYears === '' || b.lifeYears === null ? undefined : Number(b.lifeYears);
  if (lifeYears !== undefined && !(lifeYears >= 1 && lifeYears <= 100)) throw new ErrorHandler('lifeYears must be between 1 and 100', 400);
  const data = {
    name: name.slice(0, 120), description: String(b.description || '').trim().slice(0, 300), block: b.block,
    method: b.method === 'slm' ? 'slm' : 'wdv', residualPercent, lifeYears, purchaseDate, putToUse, cost,
    location: String(b.location || '').trim().slice(0, 80), identifier: String(b.identifier || '').trim().slice(0, 60),
    createdBy: req?.user?._id, requestId: b.requestId ? String(b.requestId) : undefined,
  };
  if (b.openingWdv && FY_RE.test(String(b.openingWdv.fy || ''))) {
    const ca = Number(b.openingWdv.companiesAct); const it = Number(b.openingWdv.incomeTax);
    if (!(ca >= 0) || ca > cost) throw new ErrorHandler('openingWdv.companiesAct must be between 0 and the cost', 400);
    data.openingWdv = { fy: b.openingWdv.fy, companiesAct: r2(ca), incomeTax: Number.isFinite(it) && it >= 0 ? r2(it) : r2(ca) };
  }
  if (isId(b.supplierBill)) {
    const bill = await SupplierBill.findById(b.supplierBill).select('billNo supplierBillNo supplier supplierName').lean();
    if (!bill) throw new ErrorHandler('Supplier bill not found', 404);
    data.supplierBill = bill._id; data.billNo = bill.supplierBillNo || bill.billNo; data.supplier = bill.supplier; data.supplierName = bill.supplierName;
  } else if (isId(b.supplier)) {
    const s = await Supplier.findById(b.supplier).select('name').lean();
    if (!s) throw new ErrorHandler('Supplier not found', 404);
    data.supplier = s._id; data.supplierName = s.name;
  } else if (b.supplierName) data.supplierName = String(b.supplierName).trim().slice(0, 120);
  if (isId(b.machine)) {
    const m = await Machine.findById(b.machine).select('ID manufacturer').lean();
    if (!m) throw new ErrorHandler('Machine not found', 404);
    data.machine = m._id;
    if (!data.identifier) data.identifier = String(m.ID || '').slice(0, 60);
  }
  const { financialYear, sequence, number } = await allocate(FixedAsset, 'FA', { at: putToUse });
  const _id = new mongoose.Types.ObjectId();
  data._id = _id; data.assetNo = number; data.financialYear = financialYear; data.sequence = sequence;
  data.fingerprints = [fp(ACTION_CODES.ASSET_ADDED, { _id }, req, { assetNo: number, name: data.name, block: data.block, cost })];
  try {
    const asset = await FixedAsset.create(data);
    return { asset: asset.toObject(), replay: false };
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await FixedAsset.findOne({ requestId: String(b.requestId) }).lean();
      if (dup) return { asset: dup, replay: true };
    }
    throw err;
  }
}

async function dispose(id, b, req) {
  if (!isId(id)) throw new ErrorHandler('Asset not found', 404);
  const a = await FixedAsset.findById(id).lean();
  if (!a) throw new ErrorHandler('Asset not found', 404);
  if (a.status !== 'active') throw new ErrorHandler(`Already ${a.status}`, 409);
  const how = b.how === 'scrapped' ? 'scrapped' : b.how === 'sold' ? 'sold' : null;
  if (!how) throw new ErrorHandler('how must be sold or scrapped', 400);
  const date = b.date ? new Date(b.date) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ErrorHandler('date is required', 400);
  if (date < new Date(a.putToUse)) throw new ErrorHandler('Disposed before it was put to use', 400);
  const amount = how === 'sold' ? r2(b.amount) : 0;
  if (how === 'sold' && !(amount >= 0)) throw new ErrorHandler('amount must be 0 or more', 400);
  const reason = String(b.reason || '').trim().slice(0, 200);
  const disposal = { date, amount, reason, by: req?.user?._id };
  await FixedAsset.updateOne({ _id: a._id, status: 'active' }, {
    $set: { status: how, disposal },
    $push: { fingerprints: fp(ACTION_CODES.ASSET_DISPOSED, a, req, { assetNo: a.assetNo, how, amount, reason }) },
  });
  const updated = await FixedAsset.findById(a._id).select('-attachments.data').lean();
  return { asset: updated, year: schedule(updated, fyOf(date)) };
}

module.exports = { schedule, register, postDepreciation, create, dispose, fyOf, fyStart, fyEnd, wdvRate, ledgers, BLOCKS };
