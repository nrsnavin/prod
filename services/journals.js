'use strict';
// ══════════════════════════════════════════════════════════════════
//  POSTING AND CANCELLING JOURNAL VOUCHERS
//
//  read()    the lines from a request body: each resolved to what it
//            names (a party, an account, a head, or a ledger by name),
//            amounts checked, debits equal to credits
//  post()    the voucher, its party-ledger rows, and the documents its
//            party lines settle (bill-wise), in one transaction
//  cancel()  everything back
//  replace() the one journal another process keeps for a thing (a
//            payroll month, a year's depreciation): the old one out
//            and the new one in, together, one request at a time
//
//  A party line's refs settle that party's open documents through the
//  same conditional update a receipt uses (services/settle.js): a
//  customer credited settles their invoices (creditedAmount, as a
//  credit note does); a supplier debited settles their bills
//  (debitedAmount). That is the only direction a party line may take,
//  and it must name the documents for the whole amount: a journal that
//  raised a party, or left part of it on account, would move the ledger
//  with nothing the receipts, the outstanding or the credits could see.
//  Raising a customer is a debit note; raising a supplier is their bill
//  or an expense.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const Journal = require('../models/Journal');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const BankAccount = require('../models/BankAccount');
const ExpenseCategory = require('../models/ExpenseCategory');
const settle = require('./settle');
const partyLedger = require('./partyLedger');
const { allocate } = require('./docNumbers');
const { assertOpen } = require('./booksLock');
const { onceAtATime } = require('../utils/onceAtATime');
const { replayOf, replayAfter } = require('./posting');
const { isId, r2, withTxn, fp } = require('./accountsHelpers');
const { ACTION_CODES } = require('../utils/fingerprint');

/** The settlement field a journal line moves on each kind of document. */
function fieldFor(partyType, debit, docType) {
  if (docType === 'OpeningBalance') return 'settledAmount';
  // An expense has no debited figure: settled by a journal, it is paid.
  if (docType === 'Expense') return 'paidAmount';
  if (partyType === 'customer') return debit ? 'debitedAmount' : 'creditedAmount';
  return 'debitedAmount';
}

async function read(body) {
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length < 2) throw new ErrorHandler('A journal needs at least two lines', 400);
  if (raw.length > 40) throw new ErrorHandler('At most 40 lines', 400);
  const lines = [];
  let incomplete = null;
  for (const [i, l] of raw.entries()) {
    const n = i + 1;
    const debit = r2(l.debit); const credit = r2(l.credit);
    if (debit < 0 || credit < 0) throw new ErrorHandler(`Line ${n}: amounts cannot be negative`, 400);
    if ((debit > 0) === (credit > 0)) throw new ErrorHandler(`Line ${n}: either a debit or a credit, not both`, 400);
    const out = { kind: l.kind, debit, credit, refs: [], note: String(l.note || '').trim().slice(0, 120) };
    if (l.kind === 'party') {
      if (!['customer', 'supplier'].includes(l.partyType) || !isId(l.party)) throw new ErrorHandler(`Line ${n}: pick the customer or supplier`, 400);
      const Model = l.partyType === 'customer' ? Customer : Supplier;
      const p = await Model.findById(l.party).select('name tallyName').lean();
      if (!p) throw new ErrorHandler(`Line ${n}: party not found`, 404);
      out.partyType = l.partyType; out[l.partyType] = p._id; out.ledger = (p.tallyName || p.name).trim(); out.partyName = p.name;
      // A party line only ever LOWERS what the party owes, and names the
      // documents it settles in full. Raising a party here would put a
      // balance on the ledger that no receipt could collect and no
      // outstanding list could show; an amount left "on account" would be
      // a credit nothing could apply. Both belong to documents of their own.
      const lowers = l.partyType === 'customer' ? credit > 0 : debit > 0;
      if (!lowers) {
        throw new ErrorHandler(l.partyType === 'customer'
          ? `Line ${n}: a journal cannot raise what ${p.name} owes — issue a debit note to the customer, so it can be collected against`
          : `Line ${n}: a journal cannot raise what is owed to ${p.name} — enter their bill or an expense, so it can be paid against`, 400);
      }
      const refs = Array.isArray(l.refs) ? l.refs : [];
      const allowed = l.partyType === 'customer' ? ['Invoice', 'OpeningBalance'] : ['SupplierBill', 'Expense', 'OpeningBalance'];
      const seen = new Set();
      for (const r of refs) {
        if (!allowed.includes(r.docType) || !isId(r.doc)) throw new ErrorHandler(`Line ${n}: a reference must name one of the ${l.partyType}'s open documents`, 400);
        if (seen.has(String(r.doc))) throw new ErrorHandler(`Line ${n}: the same document twice`, 400);
        seen.add(String(r.doc));
        const amount = r2(r.amount);
        if (!(amount > 0)) throw new ErrorHandler(`Line ${n}: reference amount must be more than 0`, 400);
        const doc = await settle.load(r.docType, r.doc);
        if (!doc) throw new ErrorHandler(`Line ${n}: document not found`, 404);
        const docNo = settle.numberOf(r.docType, doc);
        if (String(settle.kindOf(r.docType).party(doc)) !== String(p._id)) throw new ErrorHandler(`Line ${n}: ${docNo} belongs to another party`, 400);
        if (r.docType === 'OpeningBalance' && doc.partyType !== l.partyType) throw new ErrorHandler(`Line ${n}: ${docNo} belongs to another party`, 400);
        if (!settle.isOpen(r.docType, doc)) throw new ErrorHandler(`Line ${n}: ${docNo} is not open`, 409);
        const left = settle.outstanding(r.docType, doc);
        if (amount > left + 0.005) throw new ErrorHandler(`Line ${n}: ${docNo} has only ${left.toFixed(2)} outstanding`, 400);
        out.refs.push({ docType: r.docType, doc: doc._id, docNo, amount });
      }
      const refTotal = r2(out.refs.reduce((t, r) => t + r.amount, 0));
      if (refTotal > (debit || credit) + 0.005) throw new ErrorHandler(`Line ${n}: the references add to ${refTotal.toFixed(2)}, more than the line`, 400);
      // Said after the balance check below: a journal that does not balance is the first thing to fix.
      if (refTotal < (debit || credit) - 0.005) incomplete = incomplete || new ErrorHandler(`Line ${n}: set the whole ${(debit || credit).toFixed(2)} against ${p.name}'s open documents (the references add to ${refTotal.toFixed(2)}) — what comes off a party here must say which documents it settles`, 400);
    } else if (l.kind === 'bank') {
      if (!isId(l.account)) throw new ErrorHandler(`Line ${n}: pick the account`, 400);
      const a = await BankAccount.findById(l.account).select('name tallyLedger active').lean();
      if (!a || a.active === false) throw new ErrorHandler(`Line ${n}: account not found`, 404);
      out.account = a._id; out.ledger = (a.tallyLedger || a.name).trim();
    } else if (l.kind === 'head') {
      if (!isId(l.category)) throw new ErrorHandler(`Line ${n}: pick the expense head`, 400);
      const c = await ExpenseCategory.findById(l.category).select('name ledger').lean();
      if (!c) throw new ErrorHandler(`Line ${n}: head not found`, 404);
      out.category = c._id; out.ledger = (c.ledger || c.name).trim();
    } else if (l.kind === 'ledger') {
      const name = String(l.ledger || '').trim();
      if (name.length < 2) throw new ErrorHandler(`Line ${n}: name the Tally ledger`, 400);
      out.ledger = name.slice(0, 120);
    } else throw new ErrorHandler(`Line ${n}: kind must be party, bank, head or ledger`, 400);
    lines.push(out);
  }
  const dr = r2(lines.reduce((t, l) => t + l.debit, 0));
  const cr = r2(lines.reduce((t, l) => t + l.credit, 0));
  if (Math.abs(dr - cr) > 0.005) throw new ErrorHandler(`Debits ${dr.toFixed(2)} and credits ${cr.toFixed(2)} must be equal`, 400);
  if (!(dr > 0)) throw new ErrorHandler('The journal is for nothing', 400);
  if (incomplete) throw incomplete;
  return { lines, total: dr };
}

/** The journal's record, numbered, with its first fingerprint. */
async function build({ date, purpose, narration, reason, lines, total, requestId, source = 'manual', sourceRef = '' }, req) {
  const { financialYear, sequence, number } = await allocate(Journal, 'JV', { at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, journalNo: number, financialYear, sequence, requestId: requestId ? String(requestId) : undefined, date,
    purpose: purpose || 'other', narration: String(narration || '').trim().slice(0, 300), reason: String(reason || '').trim().slice(0, 300),
    lines: lines.map(({ partyName, ...l }) => l), total, source, sourceRef,
    createdBy: req?.user?._id, createdByName: req?.user?.name || '',
  };
  data.fingerprints = [fp(ACTION_CODES.JOURNAL_POSTED, { _id }, req, { journalNo: number, total, purpose: data.purpose, lines: lines.length })];
  return data;
}

/** Inside a transaction: the voucher, its party-ledger rows, and what its party lines settle. */
async function postIn(session, data, lines) {
  const [journal] = await Journal.create([data], { session });
  for (const [i, l] of lines.entries()) {
    if (l.kind !== 'party') continue;
    await partyLedger.post({ partyType: l.partyType, party: l[l.partyType], date: data.date, docType: 'Journal', doc: partyLedger.journalLineId(data._id, i), docNo: data.journalNo, debit: l.debit, credit: l.credit, narration: data.narration || data.reason, source: data._id, line: i }, session);
    for (const r of l.refs) await settle.apply(r.docType, r.doc, { [fieldFor(l.partyType, l.debit > 0, r.docType)]: r.amount }, session, { docNo: r.docNo });
  }
  return journal;
}

/** Inside a transaction: everything back. Refused when it is no longer posted. */
async function cancelIn(session, j, reason, req) {
  const res = await Journal.updateOne({ _id: j._id, status: 'posted' }, {
    $set: { status: 'cancelled', cancel: { reason, at: new Date(), by: req?.user?._id } },
    $push: { fingerprints: fp(ACTION_CODES.JOURNAL_CANCELLED, j, req, { journalNo: j.journalNo, reason }) },
  }, { session });
  if (!res.modifiedCount) throw new ErrorHandler('Already cancelled', 409);
  for (const [i, l] of j.lines.entries()) {
    if (l.kind !== 'party') continue;
    await partyLedger.reverse('Journal', partyLedger.journalLineId(j._id, i), session);
    for (const r of l.refs || []) await settle.apply(r.docType, r.doc, { [fieldFor(l.partyType, l.debit > 0, r.docType)]: -r.amount }, session, { docNo: r.docNo });
  }
}

/**
 * Post a journal. `b` is the validated body; `req` the request (actor).
 * `source`/`sourceRef` mark journals another process makes.
 */
async function post(b, req) {
  const { requestId, date, lines } = b;
  const before = await replayOf(Journal, requestId);
  if (before) return { journal: before, replay: true };
  // The books lock is asked here, not by each caller: the journals that
  // payroll, depreciation and stock post come through this one door too.
  await assertOpen(date, req);
  const data = await build(b, req);
  let journal;
  try {
    await withTxn(async (session) => { journal = await postIn(session, data, lines); });
  } catch (err) {
    const dup = await replayAfter(err, Journal, requestId);
    if (dup) return { journal: dup, replay: true };
    throw err;
  }
  return { journal: journal.toObject ? journal.toObject() : journal, replay: false };
}

async function cancel(j, reason, req) {
  await assertOpen(j.date, req, { cancelling: true });
  await withTxn(async (session) => { await cancelIn(session, j, reason, req); });
}

/**
 * Post the one journal a source keeps for a thing (a payroll month, a
 * year's depreciation, a day's closing stock), taking the place of the
 * one posted before.
 *
 * It was three steps — find the posted one, cancel it, post the new —
 * with nothing between them: two requests together both found none and
 * both posted, and the month's salaries were in the books twice; a
 * later re-post cancelled one and left the other for good. Now one
 * request at a time holds the lease for that source and thing, the
 * cancel and the post are one transaction (no moment with neither, and
 * no cancel without its replacement), and a unique index on posted
 * journals by source and thing refuses a second.
 *
 * @param b       { date, purpose, narration, reason, lines, source, sourceRef } — lines as read() takes them
 * @param why     the reason written on the journal it replaces
 */
/** What a line says, for telling two journals apart. */
const lineSays = (l) => [
  l.kind, l.ledger || '', r2(l.debit), r2(l.credit), String(l.customer || l.supplier || ''), String(l.account || ''), String(l.category || ''),
  (l.refs || []).map((r) => `${r.docType}:${r.doc}:${r2(r.amount)}`).join(','),
].join('|');

/** Whether a posted journal already says exactly what is about to be posted. */
function sameJournal(posted, { date, narration, lines, total }) {
  return new Date(posted.date).getTime() === new Date(date).getTime()
    && r2(posted.total) === r2(total)
    && String(posted.narration || '') === String(narration || '').trim().slice(0, 300)
    && (posted.lines || []).length === lines.length
    && posted.lines.every((l, i) => lineSays(l) === lineSays(lines[i]));
}

async function replace(b, why, req) {
  if (!b.source || b.source === 'manual' || !b.sourceRef) throw new ErrorHandler('replace() is for a journal another process keeps: source and sourceRef are required', 500);
  return onceAtATime(`journal:${b.source}:${b.sourceRef}`, async () => {
    const { lines, total } = await read({ lines: b.lines });
    const before = await Journal.findOne({ source: b.source, sourceRef: b.sourceRef, status: 'posted' }).lean();
    // The same journal again — the button pressed twice, the request
    // retried, a month posted again with nothing changed: it is already
    // in the books, and stays as it is. (Replacing it with its own copy
    // cancelled a voucher and used a number for nothing, and sent Tally
    // a cancellation and a new voucher for no change.)
    if (before && sameJournal(before, { date: b.date, narration: b.narration, lines, total })) {
      return { journal: before, replay: true, unchanged: true, replaced: null };
    }
    await assertOpen(b.date, req);
    if (before) await assertOpen(before.date, req, { cancelling: true });
    const data = await build({ ...b, lines, total }, req);
    let journal;
    try {
      await withTxn(async (session) => {
        // Read again inside: the one this transaction cancels is the one posted now.
        const old = await Journal.findOne({ source: b.source, sourceRef: b.sourceRef, status: 'posted' }).session(session).lean();
        if (old) await cancelIn(session, old, why, req);
        journal = await postIn(session, data, lines);
      });
    } catch (err) {
      if (err?.code === 11000) throw new ErrorHandler('This was posted by someone else a moment ago — look before posting it again', 409);
      throw err;
    }
    return { journal: journal.toObject ? journal.toObject() : journal, replay: false, replaced: before ? before.journalNo : null };
  }, { what: 'This posting' });
}

module.exports = { read, post, cancel, replace, fieldFor };
