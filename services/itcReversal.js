'use strict';
// ══════════════════════════════════════════════════════════════════
//  INPUT CREDIT ON BILLS UNPAID FOR 180 DAYS  (CGST Rule 37)
//
//  Credit taken on a supplier's bill must be reversed, with interest,
//  if the supplier is not paid within 180 days of the invoice date
//  (s.16(2), second proviso): the unpaid share of the credit goes back
//  in the GSTR-3B of the month the 180 days end. It is re-claimed when
//  the supplier is paid. Bills under reverse charge are outside the
//  rule (the tax was ours to pay).
//
//  A bill is paid in parts, so the credit comes back in parts. What
//  must stand reversed on a bill past its 180th day is the credit on its
//  unpaid share; what does stand reversed is what was reversed less what
//  was re-claimed. The difference is the next step, whichever way:
//
//      credit on the unpaid share  >  standing   →  reverse the difference
//      credit on the unpaid share  <  standing   →  re-claim the difference
//
//  So a bill half paid after its reversal has half re-claimed, and the
//  other half when the rest is paid (it used to be one re-claim, once:
//  the second half was refused and the credit lost). A payment cancelled
//  after a re-claim puts the bill back among those to reverse.
//
//  itcReversal.amount / reclaimAmount are the running totals, period /
//  reclaimPeriod the month of the latest step, and history every step
//  with its month: the GST summary reads the steps of a month from it.
//
//  due()      bills past their 180th day with something to reverse, and
//             those with something to re-claim
//  reverse()  record a reversal on the bill (the figure for 3B)
//  reclaim()  record a re-claim
//  events()   the steps taken on a bill, oldest first
// ══════════════════════════════════════════════════════════════════

const SupplierBill = require('../models/SupplierBill');

const DAY = 86_400_000;
const { r2 } = require('../utils/money');

function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  return { from: new Date(y, m - 1, 1), to: new Date(y, m, 0, 23, 59, 59, 999) };
}

/** The credit on the unpaid share of a bill. */
function reversible(b) {
  const grand = r2(b.totals?.grand || 0);
  const itc = r2(b.itc?.amount || (b.totals?.cgst || 0) + (b.totals?.sgst || 0) + (b.totals?.igst || 0));
  const outstanding = r2(grand - (b.paidAmount || 0) - (b.tdsAmount || 0) - (b.debitedAmount || 0));
  if (grand <= 0 || outstanding <= 0.005) return { outstanding: 0, itc, amount: 0 };
  return { outstanding, itc, amount: r2(itc * Math.min(1, outstanding / grand)) };
}

/** Every step taken on a bill. A bill reversed before steps were kept has its one reversal and one re-claim. */
function events(b) {
  const r = b.itcReversal || {};
  if (Array.isArray(r.history) && r.history.length) return r.history;
  const out = [];
  if (r.amount > 0) out.push({ kind: 'reverse', amount: r.amount, period: r.period || '', at: r.at || null });
  if (r.reclaimAmount > 0) out.push({ kind: 'reclaim', amount: r.reclaimAmount, period: r.reclaimPeriod || '', at: r.reclaimAt || null });
  return out;
}

/** What was reversed, what was re-claimed, and what stands reversed now. */
function standing(b) {
  const reversed = r2(b.itcReversal?.amount || 0);
  const reclaimed = r2(b.itcReversal?.reclaimAmount || 0);
  return { reversed, reclaimed, net: r2(reversed - reclaimed) };
}

const day180Of = (b) => new Date(new Date(b.billDate).getTime() + 180 * DAY);
const FIELDS = 'billNo supplierBillNo supplier supplierName billDate totals itc reverseCharge paidAmount tdsAmount debitedAmount itcReversal status';

/**
 * A month's work: bills past their 180th day by the month's end whose
 * unpaid share carries more credit than stands reversed (to reverse),
 * and bills paid since a reversal (to re-claim). Then what was done in
 * the month.
 */
async function due(month) {
  const { from, to } = monthRange(month);
  const limit = new Date(to.getTime() - 180 * DAY);
  // Only a bill with something unpaid, or with credit standing reversed,
  // has a next step: the paid bills of every earlier year are not read.
  const bills = await SupplierBill.find({
    status: { $in: ['open', 'part_paid', 'paid'] }, 'itc.eligible': true, reverseCharge: { $ne: true },
    billDate: { $lte: limit },
    $or: [
      { status: { $in: ['open', 'part_paid'] } },
      { $expr: { $gt: [{ $subtract: [{ $ifNull: ['$itcReversal.amount', 0] }, { $ifNull: ['$itcReversal.reclaimAmount', 0] }] }, 0.005] } },
    ],
  }).select(FIELDS).sort({ billDate: 1 }).lean();
  const toReverse = [];
  const toReclaim = [];
  for (const b of bills) {
    const day180 = day180Of(b);
    const r = reversible(b);
    const st = standing(b);
    const base = { _id: b._id, billNo: b.billNo, supplierBillNo: b.supplierBillNo, supplierName: b.supplierName, billDate: b.billDate, outstanding: r.outstanding, reversed: st.reversed, reclaimed: st.reclaimed };
    const more = r2(r.amount - st.net);
    if (more > 0.005) {
      // `again`: reversed before, re-claimed, and unpaid once more (a payment was cancelled).
      toReverse.push({ ...base, day180, overdueDays: Math.floor((to - day180) / DAY), grand: r2(b.totals?.grand || 0), itc: r.itc, reverse: more, inMonth: day180 >= from, again: st.reversed > 0 });
    } else if (-more > 0.005) {
      toReclaim.push({ ...base, reversedPeriod: b.itcReversal.period, reclaim: r2(-more), fully: r.outstanding <= 0.005 });
    }
  }
  // What was done in the month, one row a bill.
  const touched = await SupplierBill.find({ $or: [{ 'itcReversal.period': month }, { 'itcReversal.reclaimPeriod': month }, { 'itcReversal.history.period': month }] }).select('billNo supplierName itcReversal').lean();
  const done = { reversed: [], reclaimed: [] };
  for (const b of touched) {
    for (const [kind, list] of [['reverse', done.reversed], ['reclaim', done.reclaimed]]) {
      const steps = events(b).filter((e) => e.kind === kind && e.period === month);
      if (!steps.length) continue;
      list.push({ _id: b._id, billNo: b.billNo, supplierName: b.supplierName, amount: r2(steps.reduce((t, e) => t + e.amount, 0)), at: steps[steps.length - 1].at });
    }
  }
  return {
    month, from, to,
    toReverse, toReclaim,
    totals: {
      reverse: r2(toReverse.reduce((t, b) => t + b.reverse, 0)), reclaim: r2(toReclaim.reduce((t, b) => t + b.reclaim, 0)),
      reversed: r2(done.reversed.reduce((t, b) => t + b.amount, 0)), reclaimed: r2(done.reclaimed.reduce((t, b) => t + b.amount, 0)),
    },
    done,
  };
}

const refuse = (message, status = 409) => Object.assign(new Error(message), { status });
// The field as it was read: nothing may have moved between the read and the write. (null also matches a field that is not there.)
const same = (field, v) => (v ? { [field]: v } : { [field]: { $in: [0, null] } });
const unchanged = (b) => ({
  _id: b._id, status: b.status,
  ...same('paidAmount', b.paidAmount), ...same('tdsAmount', b.tdsAmount), ...same('debitedAmount', b.debitedAmount),
  ...same('itcReversal.amount', b.itcReversal?.amount), ...same('itcReversal.reclaimAmount', b.itcReversal?.reclaimAmount),
});

async function billFor(billId) {
  const b = await SupplierBill.findById(billId).select(FIELDS).lean();
  if (!b) throw refuse('Bill not found', 404);
  if (b.status === 'cancelled') throw refuse(`${b.billNo} is cancelled`);
  if (b.itc?.eligible === false || b.reverseCharge) throw refuse(`${b.billNo} carries no input credit under this rule`);
  return b;
}

/**
 * Write one step, only if the bill is as it was read: two people
 * pressing the button together, or a payment landing in between, cannot
 * leave a figure worked out from an older bill.
 */
async function record(b, kind, amount, { month, fingerprint, by }) {
  const st = standing(b);
  const at = new Date();
  const step = { kind, amount, period: month, at, by: by?._id, byName: by?.name || '' };
  // The steps of a bill reversed before steps were kept are written down first.
  const kept = Array.isArray(b.itcReversal?.history) && b.itcReversal.history.length;
  const steps = kept ? [step] : [...events(b), step];
  const set = kind === 'reverse'
    ? { 'itcReversal.amount': r2(st.reversed + amount), 'itcReversal.period': month, 'itcReversal.at': at }
    : { 'itcReversal.reclaimAmount': r2(st.reclaimed + amount), 'itcReversal.reclaimPeriod': month, 'itcReversal.reclaimAt': at };
  const r = await SupplierBill.updateOne(unchanged(b), { $set: set, $push: { 'itcReversal.history': { $each: steps }, ...(fingerprint ? { fingerprints: fingerprint } : {}) } });
  if (!r.modifiedCount) throw refuse(`${b.billNo} changed just now — look at it again`);
  return { billNo: b.billNo, amount, period: month, reversed: set['itcReversal.amount'] ?? st.reversed, reclaimed: set['itcReversal.reclaimAmount'] ?? st.reclaimed };
}

/** Record a reversal, for the given 3B month: the credit on the unpaid share, less what already stands reversed. */
async function reverse(billId, { month, fingerprint, by }) {
  const b = await billFor(billId);
  const st = standing(b);
  const r = reversible(b);
  const amount = r2(r.amount - st.net);
  if (amount <= 0.005) {
    if (st.net > 0.005) throw refuse(`${b.billNo} was already reversed in ${b.itcReversal.period}`);
    throw refuse(`${b.billNo} is paid: nothing to reverse`);
  }
  const day180 = day180Of(b);
  if (day180 > monthRange(month).to) throw refuse(`${b.billNo} reaches its 180 days on ${day180.toISOString().slice(0, 10)}: there is nothing to reverse in ${month}`);
  return record(b, 'reverse', amount, { month, fingerprint, by });
}

/** Record a re-claim, for the given 3B month: what stands reversed, less the credit on what is still unpaid. */
async function reclaim(billId, { month, fingerprint, by }) {
  const b = await billFor(billId);
  const st = standing(b);
  if (!(st.reversed > 0)) throw refuse(`${b.billNo} was not reversed`);
  const amount = r2(st.net - reversible(b).amount);
  if (amount <= 0.005) {
    if (st.net <= 0.005) throw refuse(`${b.billNo} was already re-claimed in full, last in ${b.itcReversal.reclaimPeriod}`);
    throw refuse(`${b.billNo} has not been paid since ${st.reclaimed > 0 ? 'the last re-claim' : 'the reversal'}`);
  }
  if (b.itcReversal.period && month < b.itcReversal.period) throw refuse(`${b.billNo} was reversed in ${b.itcReversal.period}: re-claim it in that month or a later one`);
  return record(b, 'reclaim', amount, { month, fingerprint, by });
}

/** For the GST report: reversed and re-claimed in a date range, by head. */
async function inPeriod(from, to) {
  const months = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  const rows = await SupplierBill.find({ $or: [{ 'itcReversal.period': { $in: months } }, { 'itcReversal.reclaimPeriod': { $in: months } }, { 'itcReversal.history.period': { $in: months } }] }).select('totals itcReversal').lean();
  const out = { reversed: { cgst: 0, sgst: 0, igst: 0, total: 0 }, reclaimed: { cgst: 0, sgst: 0, igst: 0, total: 0 } };
  for (const b of rows) {
    const t = b.totals || {}; const tax = (t.cgst || 0) + (t.sgst || 0) + (t.igst || 0);
    for (const e of events(b)) {
      if (!months.includes(e.period) || !(e.amount > 0)) continue;
      const into = e.kind === 'reverse' ? out.reversed : out.reclaimed;
      for (const head of ['cgst', 'sgst', 'igst']) into[head] = r2(into[head] + (tax > 0 ? r2(e.amount * (t[head] || 0) / tax) : 0));
      into.total = r2(into.total + e.amount);
    }
  }
  return out;
}

module.exports = { due, reverse, reclaim, inPeriod, reversible, events, standing };
