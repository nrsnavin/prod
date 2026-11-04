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
//
//  A party line's refs settle that party's open documents through the
//  same conditional update a receipt uses (services/settle.js): a
//  customer credited settles their invoices (creditedAmount, as a
//  credit note does); a supplier debited settles their bills
//  (debitedAmount). The other direction (a customer debited, a supplier
//  credited) raises what they owe: no refs.
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
const { isId, r2, withTxn, fp } = require('./accountsHelpers');
const { ACTION_CODES } = require('../utils/fingerprint');

/** The settlement field a journal line moves on each kind of document. */
function fieldFor(partyType, debit, docType) {
  if (docType === 'OpeningBalance') return 'settledAmount';
  if (partyType === 'customer') return debit ? 'debitedAmount' : 'creditedAmount';
  return 'debitedAmount';
}

async function read(body) {
  const raw = Array.isArray(body.lines) ? body.lines : [];
  if (raw.length < 2) throw new ErrorHandler('A journal needs at least two lines', 400);
  if (raw.length > 40) throw new ErrorHandler('At most 40 lines', 400);
  const lines = [];
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
      // Bill-wise: only on the side that lowers what the party owes.
      const lowers = l.partyType === 'customer' ? credit > 0 : debit > 0;
      const refs = Array.isArray(l.refs) ? l.refs : [];
      if (refs.length && !lowers) throw new ErrorHandler(`Line ${n}: a ${l.partyType} ${debit > 0 ? 'debited' : 'credited'} owes more; nothing to set it against`, 400);
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
  return { lines, total: dr };
}

/**
 * Post a journal. `b` is the validated body; `req` the request (actor).
 * `source`/`sourceRef` mark journals another process makes.
 */
async function post({ date, purpose, narration, reason, lines, total, requestId, source = 'manual', sourceRef = '' }, req) {
  if (requestId) {
    const dup = await Journal.findOne({ requestId: String(requestId) }).lean();
    if (dup) return { journal: dup, replay: true };
  }
  const { financialYear, sequence, number } = await allocate(Journal, 'JV', { at: date });
  const _id = new mongoose.Types.ObjectId();
  const data = {
    _id, journalNo: number, financialYear, sequence, requestId: requestId ? String(requestId) : undefined, date,
    purpose: purpose || 'other', narration: String(narration || '').trim().slice(0, 300), reason: String(reason || '').trim().slice(0, 300),
    lines: lines.map(({ partyName, ...l }) => l), total, source, sourceRef,
    createdBy: req?.user?._id, createdByName: req?.user?.name || '',
  };
  data.fingerprints = [fp(ACTION_CODES.JOURNAL_POSTED, { _id }, req, { journalNo: number, total, purpose: data.purpose, lines: lines.length })];
  let journal;
  try {
    await withTxn(async (session) => {
      [journal] = await Journal.create([data], { session });
      for (const [i, l] of lines.entries()) {
        if (l.kind !== 'party') continue;
        await partyLedger.post({ partyType: l.partyType, party: l[l.partyType], date, docType: 'Journal', doc: partyLedger.journalLineId(_id, i), docNo: number, debit: l.debit, credit: l.credit, narration: data.narration || data.reason, source: _id, line: i }, session);
        for (const r of l.refs) await settle.apply(r.docType, r.doc, { [fieldFor(l.partyType, l.debit > 0, r.docType)]: r.amount }, session, { docNo: r.docNo });
      }
    });
  } catch (err) {
    if (err?.code === 11000 && requestId) {
      const dup = await Journal.findOne({ requestId: String(requestId) }).lean();
      if (dup) return { journal: dup, replay: true };
    }
    throw err;
  }
  return { journal: journal.toObject ? journal.toObject() : journal, replay: false };
}

async function cancel(j, reason, req) {
  await withTxn(async (session) => {
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
  });
}

module.exports = { read, post, cancel, fieldFor };
