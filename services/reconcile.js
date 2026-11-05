'use strict';
// ══════════════════════════════════════════════════════════════════
//  BANK RECONCILIATION
//
//  A voucher is CLEARED on the day the bank's statement shows it. As of
//  any date, the bank's balance should equal
//
//      book balance
//    − receipts in the books the bank has not shown yet
//    + payments in the books the bank has not shown yet
//    + money in on the statement the books do not have
//    − money out on the statement the books do not have
//
//  and the difference between that and the bank's own balance is what
//  is left to find. Zero before the month is closed.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Contra = require('../models/Contra');
const BankAccount = require('../models/BankAccount');
const BankStatement = require('../models/BankStatement');
const bankBalances = require('./bankBalances');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const endOf = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

/** Mark one book entry cleared on `date` (null clears the mark) — only where it touches `account`. */
async function markCleared(voucherType, id, account, date, { overwrite = false } = {}) {
  const on = date ? new Date(date) : null;
  if (voucherType === 'Contra') {
    const c = await Contra.findById(id).select('from to fromClearedOn toClearedOn').lean();
    if (!c) return false;
    const side = String(c.to) === String(account) ? 'toClearedOn' : String(c.from) === String(account) ? 'fromClearedOn' : null;
    if (!side || (!overwrite && c[side] && on)) return !!side;
    await Contra.updateOne({ _id: id }, on ? { $set: { [side]: on } } : { $unset: { [side]: 1 } });
    return true;
  }
  const q = { _id: id, account };
  if (!overwrite && on) q.clearedOn = { $exists: false };
  const res = await Payment.updateOne(q, on ? { $set: { clearedOn: on } } : { $unset: { clearedOn: 1 } });
  // The bank showing a cheque is the cheque clearing: its stage moves with the tick.
  if (on && res.matchedCount > 0) {
    await Payment.updateOne({ _id: id, mode: 'cheque', 'cheque.status': 'held' }, { $set: { 'cheque.status': 'cleared', 'cheque.depositedOn': on, 'cheque.clearedOn': on } });
    await Payment.updateOne({ _id: id, mode: 'cheque', 'cheque.status': 'deposited' }, { $set: { 'cheque.status': 'cleared', 'cheque.clearedOn': on } });
  }
  return res.matchedCount > 0 || !!(await Payment.exists({ _id: id, account }));
}

const notCleared = (field, asOf) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: { $gt: asOf } }] });

/**
 * @param account   the bank account id
 * @param asOf      the date the reconciliation is as of
 * @param bankBalance  the bank's own balance on that date; when absent,
 *                  the closing balance of the latest statement up to it
 */
async function statementAsOf(account, asOf, bankBalance) {
  const acct = await BankAccount.findById(account).lean();
  if (!acct) return null;
  const at = endOf(asOf);
  const id = new mongoose.Types.ObjectId(String(account));
  const [withBal] = await bankBalances.withBalances([acct], { asOf: at });
  const [payments, contrasIn, contrasOut, statements] = await Promise.all([
    Payment.find({ status: 'posted', account: id, date: { $lte: at }, ...notCleared('clearedOn', at) }).select('kind voucherNo date partyName amount reference mode').sort({ date: 1 }).lean(),
    Contra.find({ status: 'posted', to: id, date: { $lte: at }, ...notCleared('toClearedOn', at) }).select('contraNo date fromName amount reference').lean(),
    Contra.find({ status: 'posted', from: id, date: { $lte: at }, ...notCleared('fromClearedOn', at) }).select('contraNo date toName amount reference').lean(),
    BankStatement.find({ account: id, from: { $lte: at } }).select('file from to closingBalance lines createdAt').sort({ to: -1, createdAt: -1 }).lean(),
  ]);
  const uncleared = [
    ...payments.map((p) => ({ voucherType: 'Payment', _id: p._id, number: p.voucherNo, date: p.date, party: p.partyName, reference: p.reference || '', direction: p.kind === 'receipt' ? 'in' : 'out', amount: p.amount })),
    ...contrasIn.map((c) => ({ voucherType: 'Contra', _id: c._id, number: c.contraNo, date: c.date, party: `From ${c.fromName}`, reference: c.reference || '', direction: 'in', amount: c.amount })),
    ...contrasOut.map((c) => ({ voucherType: 'Contra', _id: c._id, number: c.contraNo, date: c.date, party: `To ${c.toName}`, reference: c.reference || '', direction: 'out', amount: c.amount })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  // Statement lines nobody has placed, once each (a line uploaded twice counts once).
  const seen = new Map();
  for (const st of statements) {
    for (const l of st.lines) {
      if (new Date(l.date) > at) continue;
      const prev = seen.get(l.key);
      const done = ['recorded', 'posted', 'ignored'].includes(l.status);
      if (!prev || (done && !prev.done)) seen.set(l.key, { done, line: { statement: st._id, index: l.index, date: l.date, narration: l.narration, ref: l.ref, amount: l.amount, direction: l.direction } });
    }
  }
  const unmatched = [...seen.values()].filter((x) => !x.done).map((x) => x.line).sort((a, b) => new Date(a.date) - new Date(b.date));

  const latest = statements.find((s) => s.closingBalance !== null && s.closingBalance !== undefined && new Date(s.to) <= at) || null;
  const bank = bankBalance !== undefined && bankBalance !== null && bankBalance !== '' && Number.isFinite(Number(bankBalance)) ? r2(bankBalance) : latest ? r2(latest.closingBalance) : null;
  const sum = (rows, dir) => r2(rows.filter((r) => r.direction === dir).reduce((s, r) => s + r.amount, 0));
  const book = r2(withBal.balance);
  const expected = r2(book - sum(uncleared, 'in') + sum(uncleared, 'out') + sum(unmatched, 'in') - sum(unmatched, 'out'));
  return {
    account: { _id: acct._id, name: acct.name },
    asOf: at,
    bookBalance: book,
    uncleared, unmatched,
    totals: {
      unclearedIn: sum(uncleared, 'in'), unclearedOut: sum(uncleared, 'out'),
      unmatchedIn: sum(unmatched, 'in'), unmatchedOut: sum(unmatched, 'out'),
    },
    expectedBankBalance: expected,
    bankBalance: bank,
    bankBalanceFrom: bankBalance !== undefined && bankBalance !== null && bankBalance !== '' ? 'entered' : latest ? { statement: latest._id, file: latest.file, to: latest.to } : null,
    difference: bank === null ? null : r2(bank - expected),
  };
}

module.exports = { markCleared, statementAsOf };
