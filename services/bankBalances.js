'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT IS IN EACH CASH AND BANK ACCOUNT
//
//  opening balance + receipts − payments + contras in − contras out,
//  every posted voucher and contra, optionally up to a date. A voucher's
//  `amount` is the money that moved; the TDS and any adjustment on it
//  never touched the account.
// ══════════════════════════════════════════════════════════════════

const Payment = require('../models/Payment');
const Contra = require('../models/Contra');

const { r2 } = require('../utils/money');

/** Map<accountId, { inflow, outflow }> for posted vouchers and contras matching `dateMatch`. */
async function movements(dateMatch) {
  const match = { status: 'posted', ...(dateMatch ? { date: dateMatch } : {}) };
  const [vouchers, contras] = await Promise.all([
    Payment.aggregate([
      { $match: match },
      { $group: { _id: '$account', inflow: { $sum: { $cond: [{ $eq: ['$kind', 'receipt'] }, '$amount', 0] } }, outflow: { $sum: { $cond: [{ $eq: ['$kind', 'payment'] }, '$amount', 0] } } } },
    ]),
    Contra.aggregate([
      { $match: match },
      { $facet: {
        out: [{ $group: { _id: '$from', amount: { $sum: '$amount' } } }],
        in: [{ $group: { _id: '$to', amount: { $sum: '$amount' } } }],
      } },
    ]),
  ]);
  const by = new Map();
  const row = (id) => { const k = String(id); if (!by.has(k)) by.set(k, { inflow: 0, outflow: 0 }); return by.get(k); };
  for (const v of vouchers) { const x = row(v._id); x.inflow += v.inflow; x.outflow += v.outflow; }
  for (const c of contras[0]?.out || []) row(c._id).outflow += c.amount;
  for (const c of contras[0]?.in || []) row(c._id).inflow += c.amount;
  return by;
}

/** Each account with its balance (and the money in and out behind it). */
async function withBalances(accounts, { asOf } = {}) {
  const by = await movements(asOf ? { $lte: asOf } : null);
  return accounts.map((a) => {
    const m = by.get(String(a._id)) || { inflow: 0, outflow: 0 };
    return { ...a, balance: r2((a.openingBalance || 0) + m.inflow - m.outflow), receipts: r2(m.inflow), payments: r2(m.outflow) };
  });
}

/** One account's balance before a date (the opening of a cash book). */
async function balanceBefore(account, date) {
  const by = await movements({ $lt: date });
  const m = by.get(String(account._id)) || { inflow: 0, outflow: 0 };
  return r2((account.openingBalance || 0) + m.inflow - m.outflow);
}

module.exports = { movements, withBalances, balanceBefore };
