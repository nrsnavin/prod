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
//  due()      bills whose 180th day falls in or before the month, still
//             unpaid in part, with the credit to reverse
//  reverse()  record the reversal on the bill (the figure for 3B)
//  reclaim()  record the re-claim once paid
// ══════════════════════════════════════════════════════════════════

const SupplierBill = require('../models/SupplierBill');

const DAY = 86_400_000;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

/**
 * Bills to reverse in a month: credit claimed, 180 days from the bill
 * date reached by the month's end, part unpaid, not yet reversed.
 * Also the ones already reversed and since paid, waiting to be re-claimed.
 */
async function due(month) {
  const { from, to } = monthRange(month);
  const limit = new Date(to.getTime() - 180 * DAY);
  const bills = await SupplierBill.find({
    status: { $in: ['open', 'part_paid', 'paid'] }, 'itc.eligible': true, reverseCharge: { $ne: true },
    billDate: { $lte: limit },
    $or: [{ 'itcReversal.amount': { $in: [0, null] } }, { 'itcReversal.reclaimAmount': { $in: [0, null] }, 'itcReversal.amount': { $gt: 0 } }],
  }).select('billNo supplierBillNo supplier supplierName billDate totals itc paidAmount tdsAmount debitedAmount itcReversal status').sort({ billDate: 1 }).lean();
  const toReverse = [];
  const toReclaim = [];
  for (const b of bills) {
    const day180 = new Date(new Date(b.billDate).getTime() + 180 * DAY);
    const r = reversible(b);
    if (!b.itcReversal?.amount) {
      if (r.amount > 0.005) toReverse.push({ _id: b._id, billNo: b.billNo, supplierBillNo: b.supplierBillNo, supplierName: b.supplierName, billDate: b.billDate, day180, overdueDays: Math.floor((to - day180) / DAY), grand: r2(b.totals?.grand || 0), outstanding: r.outstanding, itc: r.itc, reverse: r.amount, inMonth: day180 >= from });
    } else if (!b.itcReversal.reclaimAmount) {
      // Reversed earlier; paid since?
      const paidSince = r2(b.itcReversal.amount - r.amount);
      if (paidSince > 0.005) toReclaim.push({ _id: b._id, billNo: b.billNo, supplierBillNo: b.supplierBillNo, supplierName: b.supplierName, billDate: b.billDate, reversed: b.itcReversal.amount, reversedPeriod: b.itcReversal.period, outstanding: r.outstanding, reclaim: paidSince, fully: r.outstanding <= 0.005 });
    }
  }
  const reversedThisMonth = await SupplierBill.find({ 'itcReversal.period': month, 'itcReversal.amount': { $gt: 0 } }).select('billNo supplierName itcReversal').lean();
  const reclaimedThisMonth = await SupplierBill.find({ 'itcReversal.reclaimPeriod': month, 'itcReversal.reclaimAmount': { $gt: 0 } }).select('billNo supplierName itcReversal').lean();
  return {
    month, from, to,
    toReverse, toReclaim,
    totals: {
      reverse: r2(toReverse.reduce((t, b) => t + b.reverse, 0)), reclaim: r2(toReclaim.reduce((t, b) => t + b.reclaim, 0)),
      reversed: r2(reversedThisMonth.reduce((t, b) => t + b.itcReversal.amount, 0)), reclaimed: r2(reclaimedThisMonth.reduce((t, b) => t + b.itcReversal.reclaimAmount, 0)),
    },
    done: { reversed: reversedThisMonth.map((b) => ({ _id: b._id, billNo: b.billNo, supplierName: b.supplierName, amount: b.itcReversal.amount, at: b.itcReversal.at })), reclaimed: reclaimedThisMonth.map((b) => ({ _id: b._id, billNo: b.billNo, supplierName: b.supplierName, amount: b.itcReversal.reclaimAmount, at: b.itcReversal.reclaimAt })) },
  };
}

/** Record the reversal, for the given 3B month. */
async function reverse(billId, { month, fingerprint }) {
  const b = await SupplierBill.findById(billId).lean();
  if (!b) throw Object.assign(new Error('Bill not found'), { status: 404 });
  if (b.itcReversal?.amount > 0) throw Object.assign(new Error(`${b.billNo} was already reversed in ${b.itcReversal.period}`), { status: 409 });
  const r = reversible(b);
  if (r.amount <= 0.005) throw Object.assign(new Error(`${b.billNo} is paid: nothing to reverse`), { status: 409 });
  await SupplierBill.updateOne({ _id: b._id }, { $set: { itcReversal: { amount: r.amount, period: month, at: new Date(), reclaimAmount: 0, reclaimPeriod: '', reclaimAt: null } }, ...(fingerprint ? { $push: { fingerprints: fingerprint } } : {}) });
  return { billNo: b.billNo, amount: r.amount, period: month };
}

/** Record the re-claim of what was reversed, for the given 3B month. */
async function reclaim(billId, { month, fingerprint }) {
  const b = await SupplierBill.findById(billId).lean();
  if (!b) throw Object.assign(new Error('Bill not found'), { status: 404 });
  if (!(b.itcReversal?.amount > 0)) throw Object.assign(new Error(`${b.billNo} was not reversed`), { status: 409 });
  if (b.itcReversal.reclaimAmount > 0) throw Object.assign(new Error(`${b.billNo} was already re-claimed in ${b.itcReversal.reclaimPeriod}`), { status: 409 });
  const r = reversible(b);
  const amount = r2(b.itcReversal.amount - r.amount);
  if (amount <= 0.005) throw Object.assign(new Error(`${b.billNo} has not been paid since the reversal`), { status: 409 });
  await SupplierBill.updateOne({ _id: b._id }, { $set: { 'itcReversal.reclaimAmount': amount, 'itcReversal.reclaimPeriod': month, 'itcReversal.reclaimAt': new Date() }, ...(fingerprint ? { $push: { fingerprints: fingerprint } } : {}) });
  return { billNo: b.billNo, amount, period: month };
}

/** For the GST report: reversed and re-claimed in a date range, by head. */
async function inPeriod(from, to) {
  const months = [];
  for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  const rows = await SupplierBill.find({ $or: [{ 'itcReversal.period': { $in: months } }, { 'itcReversal.reclaimPeriod': { $in: months } }] }).select('totals itcReversal').lean();
  const split = (b, amount) => {
    const t = b.totals || {}; const tax = (t.cgst || 0) + (t.sgst || 0) + (t.igst || 0);
    if (tax <= 0) return { cgst: 0, sgst: 0, igst: 0 };
    return { cgst: r2(amount * (t.cgst || 0) / tax), sgst: r2(amount * (t.sgst || 0) / tax), igst: r2(amount * (t.igst || 0) / tax) };
  };
  const out = { reversed: { cgst: 0, sgst: 0, igst: 0, total: 0 }, reclaimed: { cgst: 0, sgst: 0, igst: 0, total: 0 } };
  for (const b of rows) {
    if (months.includes(b.itcReversal?.period) && b.itcReversal.amount > 0) { const s = split(b, b.itcReversal.amount); out.reversed.cgst = r2(out.reversed.cgst + s.cgst); out.reversed.sgst = r2(out.reversed.sgst + s.sgst); out.reversed.igst = r2(out.reversed.igst + s.igst); out.reversed.total = r2(out.reversed.total + b.itcReversal.amount); }
    if (months.includes(b.itcReversal?.reclaimPeriod) && b.itcReversal.reclaimAmount > 0) { const s = split(b, b.itcReversal.reclaimAmount); out.reclaimed.cgst = r2(out.reclaimed.cgst + s.cgst); out.reclaimed.sgst = r2(out.reclaimed.sgst + s.sgst); out.reclaimed.igst = r2(out.reclaimed.igst + s.igst); out.reclaimed.total = r2(out.reclaimed.total + b.itcReversal.reclaimAmount); }
  }
  return out;
}

module.exports = { due, reverse, reclaim, inPeriod, reversible };
