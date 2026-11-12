'use strict';
// ══════════════════════════════════════════════════════════════════
//  SETTLING DOCUMENTS
//
//  Every document money can be set against — an invoice, a supplier
//  bill, an expense, an opening balance brought over from Tally — is
//  described once here: how its outstanding is worked out, when it is
//  open, whose it is, and which of its fields a voucher, a note or an
//  applied credit moves.
//
//  apply() moves those fields in ONE conditional update: the filter
//  refuses the write when the document is no longer open or would be
//  settled past what it owes, so two clerks posting against the same
//  invoice in the same second cannot both succeed. The status that
//  follows from the new figures is set in the same update.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');

const { r2 } = require('../utils/money');
const f = (name) => ({ $ifNull: [`$${name}`, 0] });

// The fields each kind of document is settled through, and what is
// left owing as a Mongo expression and as plain arithmetic.
const KINDS = {
  Invoice: {
    model: () => require('../models/Invoice'),
    fields: ['paidAmount', 'creditedAmount', 'debitedAmount'],
    left: (d) => r2((d.totals?.grand || 0) + (d.debitedAmount || 0) - (d.paidAmount || 0) - (d.creditedAmount || 0)),
    leftExpr: { $subtract: [{ $add: ['$totals.grand', f('debitedAmount')] }, { $add: [f('paidAmount'), f('creditedAmount')] }] },
    openStatuses: ['issued'],
    number: (d) => d.invoiceNumber,
    partyType: 'customer',
    party: (d) => d.customer,
    status: null,
    // While an invoice's IRN is being cancelled at the portal (seconds),
    // nothing new may be set against it: the cancel cannot be taken back
    // there, so a receipt landing in that gap left the IRN cancelled and
    // the invoice live. The hold is a time, so one left behind by a
    // process that died lifts by itself (api/invoice.js, cancel).
    hold: 'cancellingUntil',
  },
  SupplierBill: {
    model: () => require('../models/SupplierBill'),
    fields: ['paidAmount', 'tdsAmount', 'debitedAmount'],
    touchedBy: ['paidAmount', 'tdsAmount'],
    left: (d) => r2((d.totals?.grand || 0) - (d.paidAmount || 0) - (d.tdsAmount || 0) - (d.debitedAmount || 0)),
    leftExpr: { $subtract: ['$totals.grand', { $add: [f('paidAmount'), f('tdsAmount'), f('debitedAmount')] }] },
    openStatuses: ['open', 'part_paid', 'paid'],
    number: (d) => d.billNo,
    partyType: 'supplier',
    party: (d) => d.supplier,
    // paid / part paid / open from the figures; a cancelled bill stays so.
    status: (left, touched) => ({
      $cond: [{ $eq: ['$status', 'cancelled'] }, 'cancelled',
        { $cond: [{ $lte: [left, 0.005] }, 'paid', { $cond: [{ $gt: [touched, 0] }, 'part_paid', 'open'] }] }],
    }),
  },
  Expense: {
    model: () => require('../models/Expense'),
    fields: ['paidAmount'],
    left: (d) => r2((d.totals?.grand || 0) - (d.paidAmount || 0)),
    leftExpr: { $subtract: ['$totals.grand', f('paidAmount')] },
    openStatuses: ['approved', 'paid'],
    number: (d) => d.expenseNo,
    partyType: 'supplier',
    party: (d) => d.supplier,
    status: (left) => ({
      $cond: [{ $in: ['$status', ['approved', 'paid']] }, { $cond: [{ $lte: [left, 0.005] }, 'paid', 'approved'] }, '$status'],
    }),
  },
  OpeningBalance: {
    model: () => require('../models/OpeningBalance'),
    fields: ['settledAmount'],
    left: (d) => (d.kind === 'due' ? r2((d.amount || 0) - (d.settledAmount || 0)) : 0),
    leftExpr: { $subtract: ['$amount', f('settledAmount')] },
    openStatuses: ['posted'],
    number: (d) => d.docNo,
    partyType: null,
    party: (d) => d.customer || d.supplier,
    status: null,
  },
};

const DOC_TYPES = Object.keys(KINDS);

function kindOf(docType) {
  const k = KINDS[docType];
  if (!k) throw new ErrorHandler(`Unknown document type ${docType}`, 400);
  return k;
}

const outstanding = (docType, d) => kindOf(docType).left(d);
const numberOf = (docType, d) => kindOf(docType).number(d);
const isOpen = (docType, d) => kindOf(docType).openStatuses.includes(d.status) && (docType !== 'OpeningBalance' || d.kind === 'due');
async function load(docType, id, session) {
  const q = kindOf(docType).model().findById(id);
  return session ? q.session(session) : q;
}

/**
 * Move a document's settlement fields by `inc` ({ paidAmount: 100 } …).
 * A positive move is refused (409) when the document is not open, is
 * held (an invoice being cancelled at the portal), or would be left
 * owing less than nothing; a reversal (negative) always lands. Returns
 * nothing; throws ErrorHandler on refusal.
 */
async function apply(docType, id, inc, session, { docNo, extraSet } = {}) {
  const k = kindOf(docType);
  const Model = k.model();
  const moves = Object.entries(inc).filter(([, v]) => v);
  if (!moves.length) return;
  for (const [field] of moves) if (!k.fields.includes(field)) throw new Error(`${docType} is not settled through ${field}`);
  // Debiting an invoice raises what it owes; everything else lowers it.
  const lowers = moves.reduce((s, [field, v]) => s + (field === 'debitedAmount' && docType === 'Invoice' ? -v : v), 0);

  // Anything being added (a receipt, a credit, a debit note's raise) needs
  // the document open and not held; a reversal always lands.
  const adding = moves.some(([, v]) => v > 0);
  const now = new Date();
  const filter = { _id: id };
  if (adding) {
    filter.status = { $in: k.openStatuses };
    if (k.hold) filter.$or = [{ [k.hold]: { $exists: false } }, { [k.hold]: null }, { [k.hold]: { $lte: now } }];
  }
  if (lowers > 0) filter.$expr = { $gte: [k.leftExpr, lowers - 0.005] };
  const set = {};
  for (const [field, v] of moves) set[field] = { $round: [{ $add: [f(field), v] }, 2] };
  const stages = [{ $set: set }];
  if (k.status) {
    // A bill is part paid once money or TDS is against it; a debit note alone leaves it open.
    const touched = { $add: (k.touchedBy || k.fields).map(f) };
    stages.push({ $set: { status: k.status(k.leftExpr, touched) } });
  }
  if (extraSet) stages.push({ $set: extraSet });
  const res = await Model.updateOne(filter, stages, { session });
  if (res.matchedCount === 0) {
    const doc = await load(docType, id, session);
    if (!doc) throw new ErrorHandler(`${docNo || docType} not found`, 404);
    if (!k.openStatuses.includes(doc.status)) throw new ErrorHandler(`${docNo || numberOf(docType, doc)} is not open`, 409);
    if (k.hold && doc[k.hold] && new Date(doc[k.hold]) > now) throw new ErrorHandler(`${docNo || numberOf(docType, doc)} is being cancelled just now — look again in a moment`, 409);
    throw new ErrorHandler(`${docNo || numberOf(docType, doc)} has only ${k.left(doc).toFixed(2)} outstanding`, 409);
  }
}

module.exports = { KINDS, DOC_TYPES, kindOf, outstanding, numberOf, isOpen, load, apply, r2 };
