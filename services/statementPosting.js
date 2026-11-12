'use strict';
// ══════════════════════════════════════════════════════════════════
//  A STATEMENT LINE INTO THE BOOKS, ONCE
//
//  postRow() turns one confirmed line into a receipt, a payment, or a
//  contra (money between two of our own accounts). It is the one way a
//  line is posted: the screen's "post" and the bank feed's automatic
//  posting both come through here.
//
//  When the row names a stored line (statement + index):
//
//    • what the bank shows (date, amount, direction, narration,
//      reference) is taken from the stored line, never from the request;
//    • a line already in the books is handed back the voucher that
//      answers it, and nothing is posted;
//    • the voucher carries the line's identity (services/bankLines.js),
//      so the same bank line on another statement, in another browser
//      tab or through the feed gets that same voucher, not a second one
//      (cancelling the voucher gives the line, and its request id, back);
//    • the line is then marked posted, only if nobody placed it
//      meanwhile.
//
//  A row with no stored line (a client that only has the file) is
//  posted as before, on the request's own figures and request id.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const { ACTION_CODES } = require('../utils/fingerprint');
const { allocate } = require('./docNumbers');
const { assertOpen } = require('./booksLock');
const bankLines = require('./bankLines');
const { isId, r2, readDate, fp } = require('./accountsHelpers');
const BankAccount = require('../models/BankAccount');
const Contra = require('../models/Contra');
const BankAlias = require('../models/BankAlias');

/** A line still to be placed, or one a person had set aside and now places after all. */
const POSTABLE = [...bankLines.UNPLACED, 'ignored'];

/**
 * A statement line that is money between this account and another of
 * ours, posted as a contra: out of this account to the other, or into
 * it from the other, on the line's day, and cleared here that day.
 * `lineId`: the bank line it answers on this account's statement; a
 * line already answered returns that contra. A replayed requestId
 * returns the contra it made before.
 */
async function contraFromLine(r, accountId, req, lineId = null) {
  const out = r.direction !== 'in';
  const side = out ? 'bankLineFrom' : 'bankLineTo';
  const held = () => (lineId ? Contra.findOne({ [side]: lineId, status: 'posted' }).lean() : null);
  const sent = () => (r.requestId ? Contra.findOne({ requestId: String(r.requestId) }).lean() : null);
  const before = (await held()) || (await sent());
  if (before) return { contra: before, replay: true };

  const otherId = r.contra?.account ?? r.contra;
  if (!isId(otherId)) throw new ErrorHandler('contra.account is required', 400);
  if (String(otherId) === String(accountId)) throw new ErrorHandler('A transfer needs another account', 400);
  const [here, other] = await Promise.all([BankAccount.findById(accountId).lean(), BankAccount.findById(otherId).lean()]);
  if (!here || here.active === false || !other || other.active === false) throw new ErrorHandler('Account not found', 404);
  const amount = r2(r.amount);
  if (!(amount > 0)) throw new ErrorHandler('amount must be more than 0', 400);
  const date = readDate(r.date, 'date', new Date());
  await assertOpen(date, req);
  const [from, to] = out ? [here, other] : [other, here];
  const { financialYear, sequence, number } = await allocate(Contra, 'CTR', { at: date });
  const _id = new mongoose.Types.ObjectId();
  try {
    await Contra.create({
      _id, contraNo: number, financialYear, sequence, requestId: r.requestId ? String(r.requestId) : undefined, date,
      from: from._id, fromName: from.name, to: to._id, toName: to.name, amount,
      mode: from.kind === 'cash' || to.kind === 'cash' ? 'cash' : 'bank',
      reference: String(r.ref || '').trim().slice(0, 60), narration: String(r.narration || '').trim().slice(0, 300),
      ...(out ? { fromClearedOn: date } : { toClearedOn: date }),
      ...(lineId ? { [side]: lineId } : {}),
      createdBy: req.user?._id,
      fingerprints: [fp(ACTION_CODES.CONTRA_POSTED, { _id }, req, { contraNo: number, from: from.name, to: to.name, amount, source: 'statement' })],
    });
  } catch (err) {
    // Two requests for the same line (or the same request id) together: the one that won.
    if (err?.code === 11000) {
      const won = (await held()) || (await sent());
      if (won) return { contra: won, replay: true };
    }
    throw err;
  }
  return { contra: await Contra.findById(_id).lean(), replay: false };
}

/**
 * Keep a payer or payee for the next statement: the text must be in the
 * line's own narration (so nothing else can be planted), and a later
 * correction of the same text replaces the party. Never throws: the
 * voucher is posted either way.
 */
async function rememberPayer(r, partyType, voucher, req) {
  try {
    const text = String(r.remember?.text ?? r.remember ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
    const narration = String(r.narration || '').toUpperCase().replace(/\s+/g, ' ');
    if (text.length < 4 || text.length > 80 || !narration.includes(text)) return false;
    const direction = r.direction === 'in' ? 'in' : 'out';
    const party = partyType === 'other' ? null : (partyType === 'customer' ? voucher.customer : voucher.supplier) || null;
    if (partyType !== 'other' && !party) return false;
    const partyName = String(voucher.partyName || r.partyName || '').trim().slice(0, 120);
    if (!partyName) return false;
    await BankAlias.updateOne(
      { text, direction },
      { $set: { partyType, party, partyName, head: voucher.head || null, headName: voucher.headName || '', incomeLedger: voucher.incomeLedger || '', createdBy: req.user?._id, createdByName: req.user?.name || '' }, $setOnInsert: { text, direction } },
      { upsert: true }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Post one row.
 * @param accountId  the bank account the statement is for
 * @param statement  the stored statement (lean, with `account` and `lines`) the row's index is on, or null
 * @param row        what the person confirmed: { index, partyType, party, partyName, head, incomeLedger, allocations, adjustments, mode, contra, remember }
 *                   (+ date, amount, direction, narration, ref, requestId, used only when there is no stored line)
 * @param note       a note to leave on the line (the bank feed says how it was posted)
 * @returns { ok, voucherNo, _id, replay, already?, contra?, remembered? }
 */
async function postRow({ accountId, statement = null, row: r, req, note = '' }) {
  const { createVoucher } = require('../api/accountsCommon');
  let line = null;
  let id = null;
  if (statement && Number.isInteger(r.index)) {
    line = (statement.lines || []).find((l) => l.index === r.index);
    if (!line) throw new ErrorHandler('That line is not on this statement', 404);
    // Already in the books: what answers it, and nothing posted.
    if (bankLines.PLACED.includes(line.status)) {
      return { ok: true, voucherNo: line.voucherNo || '', _id: line.voucher || null, replay: true, already: true, ...(line.voucherType === 'Contra' ? { contra: true } : {}) };
    }
    id = bankLines.idOf(statement, line);
  }
  // What the bank shows comes from the stored line.
  const bank = line
    ? { date: line.date, narration: line.narration || '', ref: line.ref || '', amount: line.amount, direction: line.direction }
    : { date: r.date, narration: r.narration || '', ref: r.ref || '', amount: r.amount, direction: r.direction };
  const mark = (set) => (line ? bankLines.place(statement._id, line.index, { ...set, ...(note ? { note } : {}) }, { from: POSTABLE }) : false);

  // Money between our own accounts: a contra, not a receipt or payment.
  if (r.contra) {
    const c = await contraFromLine({ ...bank, contra: r.contra, requestId: r.requestId }, accountId, req, id);
    await mark({ status: 'posted', voucherType: 'Contra', voucher: c.contra._id, voucherNo: c.contra.contraNo });
    return { ok: true, voucherNo: c.contra.contraNo, _id: c.contra._id, contra: true, replay: c.replay };
  }

  const kind = bank.direction === 'in' ? 'receipt' : 'payment';
  const partyType = r.partyType === 'customer' || r.partyType === 'supplier' ? r.partyType : 'other';
  const { voucher, replay } = await createVoucher({
    ...(partyType === 'other' ? { head: r.head || undefined, incomeLedger: r.incomeLedger || undefined } : {}),
    kind, date: bank.date, partyType,
    ...(partyType === 'customer' ? { customer: r.party } : partyType === 'supplier' ? { supplier: r.party } : { partyName: r.partyName || bank.narration || 'Bank' }),
    amount: bank.amount, mode: r.mode || 'bank', account: accountId, reference: bank.ref || '',
    allocations: Array.isArray(r.allocations) ? r.allocations.map((a) => ({ docType: a.docType, doc: a.doc, amount: a.amount })) : [],
    adjustments: Array.isArray(r.adjustments) ? r.adjustments : [],
    narration: bank.narration, source: 'statement', statementLine: `${line ? new Date(bank.date).toISOString().slice(0, 10) : bank.date || ''} ${bank.narration}`.trim().slice(0, 200),
    clearedOn: bank.date,
    // The request id still answers a replay of this very request; the
    // line's identity is what answers the same line from anywhere else.
    requestId: r.requestId,
  }, req, { bankLine: id });
  await mark({ status: 'posted', voucherType: 'Payment', voucher: voucher._id, voucherNo: voucher.voucherNo });
  // "Remember": the next statement's lines carrying this text are this party.
  const remembered = r.remember ? await rememberPayer({ ...r, ...bank }, partyType, voucher, req) : false;
  return { ok: true, voucherNo: voucher.voucherNo, _id: voucher._id, replay: !!replay, ...(r.remember ? { remembered } : {}) };
}

module.exports = { postRow, contraFromLine, rememberPayer, POSTABLE };
