'use strict';
// ══════════════════════════════════════════════════════════════════
//  CREDITS ON ACCOUNT, AND APPLYING THEM
//
//  Money or credit a party has with us that is not yet set against a
//  document:
//    • a voucher's unallocated amount   (an advance, an overpayment)
//    • a note's unapplied amount        (a credit after the invoice was paid)
//    • an opening advance               (brought over from Tally)
//
//  apply() sets some of one credit against the party's open documents.
//  The party ledger does not move — the money or note is already on it;
//  only which documents it settles changes.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const ErrorHandler = require('../utils/ErrorHandler');
const Payment = require('../models/Payment');
const AccountNote = require('../models/AccountNote');
const OpeningBalance = require('../models/OpeningBalance');
const settle = require('./settle');
const { withTxn, isId, r2, fp } = require('./accountsHelpers');
const { ACTION_CODES } = require('../utils/fingerprint');

const SOURCES = { Payment, AccountNote, OpeningBalance };

/** Open credits for a party, newest first. */
async function openFor(partyType, party) {
  const id = new mongoose.Types.ObjectId(String(party));
  const [vouchers, notes, advances] = await Promise.all([
    Payment.find({ status: 'posted', partyType, [partyType]: id, unallocated: { $gt: 0.005 } }).select('voucherNo date amount unallocated kind').sort({ date: -1 }).lean(),
    AccountNote.find({ status: 'issued', partyType, [partyType]: id, unapplied: { $gt: 0.005 } }).select('noteNo date kind totals unapplied reason').sort({ date: -1 }).lean(),
    OpeningBalance.find({ status: 'posted', kind: 'advance', partyType, [partyType]: id, unapplied: { $gt: 0.005 } }).select('docNo date amount unapplied refNo').sort({ date: -1 }).lean(),
  ]);
  return [
    ...vouchers.map((v) => ({ sourceType: 'Payment', id: v._id, docNo: v.voucherNo, date: v.date, amount: v.amount, available: r2(v.unallocated), label: v.kind === 'receipt' ? 'Received on account' : 'Paid on account' })),
    ...notes.map((n) => ({ sourceType: 'AccountNote', id: n._id, docNo: n.noteNo, date: n.date, amount: n.totals?.grand || 0, available: r2(n.unapplied), label: `${n.kind === 'credit' ? 'Credit' : 'Debit'} note · ${n.reason}` })),
    ...advances.map((o) => ({ sourceType: 'OpeningBalance', id: o._id, docNo: o.docNo, date: o.date, amount: o.amount, available: r2(o.unapplied), label: `Opening advance${o.refNo ? ` · ${o.refNo}` : ''}` })),
  ];
}

/**
 * Every party's open credit at once: Map partyId → { available, count }.
 * What a supplier was paid ahead (an advance, an opening advance, a
 * debit note not yet set off) comes off what we owe them; what a
 * customer paid ahead comes off what they owe.
 */
async function byParty(partyType) {
  const [vouchers, notes, advances] = await Promise.all([
    Payment.aggregate([{ $match: { status: 'posted', partyType, unallocated: { $gt: 0.005 } } }, { $group: { _id: `$${partyType}`, available: { $sum: '$unallocated' }, count: { $sum: 1 } } }]),
    AccountNote.aggregate([{ $match: { status: 'issued', partyType, unapplied: { $gt: 0.005 } } }, { $group: { _id: `$${partyType}`, available: { $sum: '$unapplied' }, count: { $sum: 1 } } }]),
    OpeningBalance.aggregate([{ $match: { status: 'posted', kind: 'advance', partyType, unapplied: { $gt: 0.005 } } }, { $group: { _id: `$${partyType}`, available: { $sum: '$unapplied' }, count: { $sum: 1 } } }]),
  ]);
  const out = new Map();
  for (const row of [...vouchers, ...notes, ...advances]) {
    if (!row._id) continue;
    const k = String(row._id);
    const g = out.get(k) || { available: 0, count: 0 };
    g.available = r2(g.available + row.available);
    g.count += row.count;
    out.set(k, g);
  }
  return out;
}

/**
 * Which documents a credit can settle, and the field it moves on each.
 * Returns { partyType, party, targets: { docType: field } }.
 */
function rulesFor(sourceType, src) {
  if (sourceType === 'Payment') {
    if (src.partyType === 'customer') return { partyType: 'customer', party: src.customer, targets: { Invoice: 'paidAmount', OpeningBalance: 'settledAmount' } };
    if (src.partyType === 'supplier') return { partyType: 'supplier', party: src.supplier, targets: { SupplierBill: 'paidAmount', Expense: 'paidAmount', OpeningBalance: 'settledAmount' } };
    throw new ErrorHandler('An other-party voucher has nothing to apply', 400);
  }
  if (sourceType === 'AccountNote') {
    if (src.kind === 'credit') return { partyType: 'customer', party: src.customer, targets: { Invoice: 'creditedAmount', OpeningBalance: 'settledAmount' } };
    if (src.partyType === 'supplier') return { partyType: 'supplier', party: src.supplier, targets: { SupplierBill: 'debitedAmount', OpeningBalance: 'settledAmount' } };
    throw new ErrorHandler('A debit note to a customer is not a credit', 400);
  }
  if (src.kind !== 'advance') throw new ErrorHandler('Only an opening advance is a credit', 400);
  return src.partyType === 'customer'
    ? { partyType: 'customer', party: src.customer, targets: { Invoice: 'paidAmount', OpeningBalance: 'settledAmount' } }
    : { partyType: 'supplier', party: src.supplier, targets: { SupplierBill: 'paidAmount', Expense: 'paidAmount', OpeningBalance: 'settledAmount' } };
}

const available = (sourceType, src) => r2(sourceType === 'Payment' ? src.unallocated : src.unapplied);
const sourceNo = (sourceType, src) => (sourceType === 'Payment' ? src.voucherNo : sourceType === 'AccountNote' ? src.noteNo : src.docNo);
const isLive = (sourceType, src) => (sourceType === 'AccountNote' ? src.status === 'issued' : src.status === 'posted');

/**
 * body: { source: { type, id }, allocations: [{ docType, doc, amount }] }
 */
async function apply(body, req) {
  const sourceType = body.source?.type;
  const Model = SOURCES[sourceType];
  if (!Model) throw new ErrorHandler('source.type must be Payment, AccountNote or OpeningBalance', 400);
  if (!isId(body.source?.id)) throw new ErrorHandler('source.id is required', 400);
  const src = await Model.findById(body.source.id).lean();
  if (!src || !isLive(sourceType, src)) throw new ErrorHandler('That credit is not available', 404);
  const rules = rulesFor(sourceType, src);
  const raw = Array.isArray(body.allocations) ? body.allocations : [];
  if (!raw.length) throw new ErrorHandler('Pick at least one document', 400);

  const rows = [];
  const seen = new Set();
  for (const [i, a] of raw.entries()) {
    const field = rules.targets[a?.docType];
    if (!field) throw new ErrorHandler(`Line ${i + 1}: this credit cannot settle a ${a?.docType || '?'}`, 400);
    if (!isId(a.doc) || seen.has(String(a.doc))) throw new ErrorHandler(`Line ${i + 1}: a document, once`, 400);
    seen.add(String(a.doc));
    const amount = r2(a.amount);
    if (!(amount > 0)) throw new ErrorHandler(`Line ${i + 1}: amount must be more than 0`, 400);
    const doc = await settle.load(a.docType, a.doc);
    if (!doc) throw new ErrorHandler(`Line ${i + 1}: document not found`, 404);
    const docNo = settle.numberOf(a.docType, doc);
    if (String(settle.kindOf(a.docType).party(doc)) !== String(rules.party)) throw new ErrorHandler(`Line ${i + 1}: ${docNo} belongs to another party`, 400);
    if (a.docType === 'OpeningBalance' && doc.partyType !== rules.partyType) throw new ErrorHandler(`Line ${i + 1}: ${docNo} belongs to another party`, 400);
    if (!settle.isOpen(a.docType, doc)) throw new ErrorHandler(`Line ${i + 1}: ${docNo} is not open`, 409);
    const left = settle.outstanding(a.docType, doc);
    if (amount > left + 0.005) throw new ErrorHandler(`Line ${i + 1}: ${docNo} has only ${left.toFixed(2)} outstanding`, 400);
    rows.push({ docType: a.docType, doc: doc._id, docNo, amount, field });
  }
  const total = r2(rows.reduce((s, r) => s + r.amount, 0));
  if (total > available(sourceType, src) + 0.005) {
    throw new ErrorHandler(`${sourceNo(sourceType, src)} has only ₹${available(sourceType, src).toFixed(2)} to apply`, 400);
  }
  const now = new Date();

  await withTxn(async (session) => {
    // Take it off the credit first, conditionally, so two applications cannot spend it twice.
    const field = sourceType === 'Payment' ? 'unallocated' : 'unapplied';
    const push = sourceType === 'Payment'
      ? { allocations: { $each: rows.map((r) => ({ docType: r.docType, doc: r.doc, docNo: r.docNo, amount: r.amount, tds: 0, tdsBase: 0, appliedAt: now })) } }
      : { applications: { $each: rows.map((r) => ({ docType: r.docType, doc: r.doc, docNo: r.docNo, amount: r.amount, at: now, by: req.user?._id })) } };
    const upd = { $inc: { [field]: -total }, $push: push };
    upd.$push.fingerprints = fp(ACTION_CODES.CREDIT_APPLIED, src, req, { applied: total, docs: rows.map((r) => r.docNo) });
    // …and only while the credit is still live: one being cancelled in
    // the same moment is not a credit, and an application pushed onto a
    // cancelled voucher would settle a document with money that is gone.
    const res = await Model.updateOne({ _id: src._id, status: sourceType === 'AccountNote' ? 'issued' : 'posted', [field]: { $gte: total - 0.005 } }, upd, { session });
    if (res.matchedCount === 0) throw new ErrorHandler(`${sourceNo(sourceType, src)} no longer has that much to apply`, 409);
    await Model.updateOne({ _id: src._id }, [{ $set: { [field]: { $round: [`$${field}`, 2] } } }], { session });
    for (const r of rows) {
      await settle.apply(r.docType, r.doc, { [r.field]: r.amount }, session, { docNo: r.docNo });
    }
  });
  return { applied: total, source: { type: sourceType, id: src._id, docNo: sourceNo(sourceType, src) }, docs: rows.map((r) => ({ docType: r.docType, doc: r.doc, docNo: r.docNo, amount: r.amount })) };
}

module.exports = { openFor, byParty, apply, rulesFor };
