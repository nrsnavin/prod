'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE BANK LINE, ONE VOUCHER
//
//  A line on the bank's statement is one movement of money. It is
//  answered by one entry in the books: a voucher posted from it, or one
//  that was already there and is matched to it. The same line comes in
//  more than once (this week's statement overlaps last week's; a file
//  is uploaded again; the bank's feed and a person both read it), and
//  it must stay ONE line.
//
//  Its identity is the account, the line's key (day, direction, amount,
//  narration, reference) and which of the same-key lines it is in the
//  bank's own order: two charges of 5.90 on one day are #1 and #2.
//
//      <account id>|<key>#<n>
//
//  The voucher that answers a line carries that identity (Payment.
//  bankLine; a contra has one for each of its two accounts), under a
//  unique index. So the database itself refuses a second voucher for a
//  line and a second line for a voucher, whichever statement, screen,
//  request id or process it comes through.
//
//    occurrences()    number the lines that share a key (occurrenceOf,
//                     occurrenceMap: the same for a stored statement)
//    lineId()         the identity
//    vouchersFor()    the live vouchers that already answer some lines
//    claim()          give a voucher already in the books a line
//    release()        take it back (a wrong match undone)
//    freeLinesOf()    a cancelled voucher answers nothing: its lines go
//                     back to be placed
//    place()          write what became of a stored line, only if it
//                     is still in the state the caller saw
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const Payment = require('../models/Payment');
const Contra = require('../models/Contra');
const BankStatement = require('../models/BankStatement');

/** Still to be placed. */
const UNPLACED = ['matched', 'unmatched'];
/** In the books. */
const PLACED = ['recorded', 'posted'];

/** Number the entries that share a key, in order: ['a','b','a'] → [1, 1, 2]. */
function occurrences(keys) {
  const seen = new Map();
  return keys.map((k) => { const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n; });
}

/**
 * Which of its key's lines a stored line is. Kept on the line; on a
 * statement stored before that, counted from the lines before it.
 */
function occurrenceOf(statement, line) {
  if (line.occurrence) return line.occurrence;
  let n = 0;
  for (const l of [...(statement.lines || [])].sort((a, b) => a.index - b.index)) {
    if (l.key === line.key) n += 1;
    if (l.index === line.index) break;
  }
  return Math.max(1, n);
}

/** Every line of a stored statement → its occurrence, in one pass: Map(index → n). */
function occurrenceMap(statement) {
  const count = new Map();
  const out = new Map();
  for (const l of [...(statement.lines || [])].sort((a, b) => a.index - b.index)) {
    const n = (count.get(l.key) || 0) + 1;
    count.set(l.key, Math.max(n, l.occurrence || 0));
    out.set(l.index, l.occurrence || n);
  }
  return out;
}

const lineId = (account, key, occurrence) => `${String(account)}|${key}#${occurrence || 1}`;
const idOf = (statement, line) => lineId(statement.account, line.key, occurrenceOf(statement, line));

/** A request id for the voucher of a line: the same line, the same id, wherever it is posted from. */
const requestIdFor = (id) => `bank:${crypto.createHash('sha1').update(String(id)).digest('hex')}`;

const free = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] });

/**
 * The live vouchers that already answer these lines.
 * @returns Map(lineId → { voucherType, _id, voucherNo, partyName })
 */
async function vouchersFor(ids) {
  const out = new Map();
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return out;
  const [payments, contras] = await Promise.all([
    Payment.find({ bankLine: { $in: want }, status: 'posted' }).select('voucherNo bankLine partyName').lean(),
    Contra.find({ status: 'posted', $or: [{ bankLineFrom: { $in: want } }, { bankLineTo: { $in: want } }] }).select('contraNo bankLineFrom bankLineTo fromName toName').lean(),
  ]);
  for (const p of payments) out.set(p.bankLine, { voucherType: 'Payment', _id: p._id, voucherNo: p.voucherNo, partyName: p.partyName || '' });
  const has = new Set(want);
  for (const c of contras) {
    if (c.bankLineFrom && has.has(c.bankLineFrom)) out.set(c.bankLineFrom, { voucherType: 'Contra', _id: c._id, voucherNo: c.contraNo, partyName: `To ${c.toName}` });
    if (c.bankLineTo && has.has(c.bankLineTo)) out.set(c.bankLineTo, { voucherType: 'Contra', _id: c._id, voucherNo: c.contraNo, partyName: `From ${c.fromName}` });
  }
  return out;
}

/** Which bank-line field of a contra is this account's side, or null. */
const contraSide = (c, account) => (String(c.to) === String(account) ? 'bankLineTo' : String(c.from) === String(account) ? 'bankLineFrom' : null);

/**
 * Give a voucher already in the books this line.
 * @returns 'claimed'    it now answers the line
 *          'same'       it already did
 *          'taken'      the voucher answers another line
 *          'line-taken' another voucher answers this line
 *          'missing'    no such live voucher on this account
 */
async function claim(voucherType, voucherId, account, id) {
  try {
    if (voucherType === 'Contra') {
      const c = await Contra.findById(voucherId).select('from to status bankLineFrom bankLineTo').lean();
      const field = c && c.status === 'posted' ? contraSide(c, account) : null;
      if (!field) return 'missing';
      if (c[field] === id) return 'same';
      if (c[field]) return 'taken';
      const r = await Contra.updateOne({ _id: voucherId, status: 'posted', ...free(field) }, { $set: { [field]: id } });
      return r.modifiedCount ? 'claimed' : 'taken';
    }
    const p = await Payment.findById(voucherId).select('account status bankLine').lean();
    if (!p || p.status !== 'posted' || String(p.account) !== String(account)) return 'missing';
    if (p.bankLine === id) return 'same';
    if (p.bankLine) return 'taken';
    const r = await Payment.updateOne({ _id: voucherId, status: 'posted', account, ...free('bankLine') }, { $set: { bankLine: id } });
    return r.modifiedCount ? 'claimed' : 'taken';
  } catch (err) {
    if (err?.code === 11000) return 'line-taken';
    throw err;
  }
}

/** Take a line back from the voucher that answered it (only if it is still that line). */
async function release(voucherType, voucherId, account, id, session) {
  const opt = session ? { session } : {};
  if (voucherType === 'Contra') {
    const c = await Contra.findById(voucherId).select('from to').session(session || null).lean();
    const field = c ? contraSide(c, account) : null;
    if (!field) return false;
    const r = await Contra.updateOne({ _id: voucherId, [field]: id }, { $unset: { [field]: '' } }, opt);
    return r.modifiedCount > 0;
  }
  const r = await Payment.updateOne({ _id: voucherId, bankLine: id }, { $unset: { bankLine: '' } }, opt);
  return r.modifiedCount > 0;
}

/**
 * A cancelled voucher answers nothing: every statement line that
 * pointed at it goes back to be placed, saying why. Called inside the
 * cancelling transaction.
 * @returns how many statements were touched
 */
async function freeLinesOf(voucherId, voucherNo, session) {
  const r = await BankStatement.updateMany(
    { 'lines.voucher': voucherId },
    { $set: { 'lines.$[l].status': 'unmatched', 'lines.$[l].voucher': null, 'lines.$[l].voucherType': null, 'lines.$[l].voucherNo': '', 'lines.$[l].suggestion': null, 'lines.$[l].note': `${voucherNo || 'Its voucher'} was cancelled: to be placed again` } },
    { arrayFilters: [{ 'l.voucher': voucherId, 'l.status': { $in: PLACED } }], ...(session ? { session } : {}) }
  );
  return r.modifiedCount || 0;
}

/**
 * Write what became of a stored line, only while it is still in one of
 * the states `from`: two people placing the same line cannot both win,
 * and a line placed meanwhile is not overwritten.
 * @returns true when this call changed it
 */
async function place(statementId, index, set, { from = UNPLACED, session } = {}) {
  const $set = Object.fromEntries(Object.entries(set).map(([k, v]) => [`lines.$.${k}`, v]));
  const r = await BankStatement.updateOne(
    { _id: statementId, lines: { $elemMatch: { index, status: { $in: from } } } },
    { $set },
    session ? { session } : {}
  );
  return r.modifiedCount > 0;
}

module.exports = { UNPLACED, PLACED, occurrences, occurrenceOf, occurrenceMap, lineId, idOf, requestIdFor, vouchersFor, claim, release, freeLinesOf, place, free };
