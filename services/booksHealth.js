'use strict';
// ══════════════════════════════════════════════════════════════════
//  ARE THE BOOKS CONSISTENT WITH THEMSELVES — AND WITH WHAT TALLY GOT?
//
//  Every figure a document carries about money set against it (an
//  invoice's paidAmount, a bill's tdsAmount, a voucher's unallocated,
//  a note's unapplied) is kept up to date as vouchers and notes are
//  posted and cancelled. Those running figures are what the outstanding,
//  the forecast and the statements read. If one ever drifts from the
//  vouchers and notes behind it — a write that failed half way before
//  transactions, a script, a bug — everything downstream is wrong
//  quietly. So each is recomputed here from first principles and
//  compared, and the drift can be put right.
//
//  The other checks are about Tally: documents sent then cancelled,
//  parties renamed after their documents went, dates whose day in
//  India is not the day in UTC, totals that are not their lines.
//
//  check()        → { ranAt, checks: [{ key, label, severity, count, rows, fix }] }
//  repair(key)    → puts the derived figures back (only 'derived').
// ══════════════════════════════════════════════════════════════════

const Invoice = require('../models/Invoice');
const SupplierBill = require('../models/SupplierBill');
const Expense = require('../models/Expense');
const AccountNote = require('../models/AccountNote');
const Payment = require('../models/Payment');
const Contra = require('../models/Contra');
const Journal = require('../models/Journal');
const OpeningBalance = require('../models/OpeningBalance');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const BankStatement = require('../models/BankStatement');
const outstanding = require('./outstanding');
const credits = require('./credits');
const partyLedger = require('./partyLedger');
const { getSettings } = require('./booksLock');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const off = (a, b) => Math.abs(r2(a) - r2(b)) > 0.01;
const add = (map, key, field, v) => { const k = String(key); const o = map.get(k) || {}; o[field] = r2((o[field] || 0) + (Number(v) || 0)); map.set(k, o); };
const MAX_ROWS = 25;
const IST = 330 * 60_000;

/** What a note set against its own document when issued (older notes carry no `applied`: all of it). */
function initialApplied(n) {
  if (n.applied === undefined || n.applied === null) return r2(n.totals?.grand || 0);
  return r2(n.applied);
}

/**
 * Every derived figure, recomputed from the vouchers, notes and applied
 * credits that move it. Returns Map docId → { field: expected } per type.
 */
async function expectedFigures() {
  const exp = { Invoice: new Map(), SupplierBill: new Map(), Expense: new Map(), OpeningBalance: new Map(), Payment: new Map(), AccountNote: new Map() };
  const [payments, notes, advances, journals] = await Promise.all([
    Payment.find({ status: 'posted' }).select('kind amount tds adjustments allocations unallocated').lean(),
    AccountNote.find({ status: 'issued' }).select('kind partyType against applied unapplied applications totals.grand').lean(),
    OpeningBalance.find({ status: 'posted', kind: 'advance' }).select('amount applications partyType').lean(),
    require('../models/Journal').find({ status: 'posted', 'lines.refs.0': { $exists: true } }).select('lines').lean(),
  ]);
  for (const p of payments) {
    const settled = r2((p.amount || 0) + (p.tds?.amount || 0) + (p.adjustments || []).reduce((s, a) => s + (a.amount || 0), 0));
    let allocated = 0;
    for (const a of p.allocations || []) {
      allocated += a.amount || 0;
      if (a.docType === 'SupplierBill') { add(exp.SupplierBill, a.doc, 'paidAmount', r2(a.amount - (a.tds || 0))); add(exp.SupplierBill, a.doc, 'tdsAmount', a.tds || 0); }
      else if (a.docType === 'OpeningBalance') add(exp.OpeningBalance, a.doc, 'settledAmount', a.amount);
      else add(exp[a.docType], a.doc, 'paidAmount', a.amount);
    }
    exp.Payment.set(String(p._id), { unallocated: r2(settled - allocated) });
  }
  for (const n of notes) {
    const field = (docType) => (docType === 'OpeningBalance' ? 'settledAmount' : n.kind === 'debit' && n.partyType === 'customer' ? 'debitedAmount' : docType === 'Invoice' ? 'creditedAmount' : 'debitedAmount');
    const first = initialApplied(n);
    if (n.against?.doc && first > 0) add(exp[n.against.docType], n.against.doc, field(n.against.docType), first);
    let later = 0;
    for (const a of n.applications || []) { later += a.amount || 0; add(exp[a.docType], a.doc, field(a.docType), a.amount); }
    // A debit note to a customer raises what they owe; it is never a credit to apply.
    if (!(n.kind === 'debit' && n.partyType === 'customer')) exp.AccountNote.set(String(n._id), { unapplied: r2((n.totals?.grand || 0) - first - later) });
  }
  // A journal's party line settles the documents it names (services/journals.js).
  const { fieldFor } = require('./journals');
  for (const j of journals) {
    for (const l of j.lines || []) {
      if (l.kind !== 'party') continue;
      for (const r of l.refs || []) add(exp[r.docType], r.doc, fieldFor(l.partyType, l.debit > 0, r.docType), r.amount);
    }
  }
  for (const o of advances) {
    let later = 0;
    for (const a of o.applications || []) {
      later += a.amount || 0;
      add(exp[a.docType], a.doc, a.docType === 'OpeningBalance' ? 'settledAmount' : 'paidAmount', a.amount);
    }
    exp.OpeningBalance.set(String(o._id), { ...(exp.OpeningBalance.get(String(o._id)) || {}), unapplied: r2((o.amount || 0) - later) });
  }
  return exp;
}

const FIELDS = {
  Invoice: { model: Invoice, fields: ['paidAmount', 'creditedAmount', 'debitedAmount'], no: 'invoiceNumber', filter: { status: 'issued' } },
  SupplierBill: { model: SupplierBill, fields: ['paidAmount', 'tdsAmount', 'debitedAmount'], no: 'billNo', filter: { status: { $ne: 'cancelled' } } },
  Expense: { model: Expense, fields: ['paidAmount'], no: 'expenseNo', filter: { status: { $in: ['approved', 'paid'] } } },
  OpeningBalance: { model: OpeningBalance, fields: ['settledAmount', 'unapplied'], no: 'docNo', filter: { status: 'posted' } },
  Payment: { model: Payment, fields: ['unallocated'], no: 'voucherNo', filter: { status: 'posted' } },
  AccountNote: { model: AccountNote, fields: ['unapplied'], no: 'noteNo', filter: { status: 'issued', $nor: [{ kind: 'debit', partyType: 'customer' }] } },
};

/** Documents whose running figures are not what their vouchers and notes add up to. */
async function derivedDrift() {
  const exp = await expectedFigures();
  const rows = [];
  for (const [type, spec] of Object.entries(FIELDS)) {
    const docs = await spec.model.find(spec.filter).select(`${spec.fields.join(' ')} ${spec.no} kind`).lean();
    for (const d of docs) {
      const want = exp[type].get(String(d._id)) || {};
      for (const f of spec.fields) {
        if (type === 'OpeningBalance' && f === 'unapplied' && d.kind !== 'advance') continue;
        if (type === 'OpeningBalance' && f === 'settledAmount' && d.kind !== 'due') continue;
        const expected = r2(want[f] || 0);
        if (off(d[f] || 0, expected)) rows.push({ docType: type, doc: d._id, docNo: d[spec.no], field: f, stored: r2(d[f] || 0), expected });
      }
    }
  }
  return rows;
}

/** The status a bill or expense should carry for its figures. */
function statusFor(type, d, figs) {
  if (type === 'SupplierBill') {
    if (d.status === 'cancelled') return d.status;
    const left = r2((d.totals?.grand || 0) - (figs.paidAmount || 0) - (figs.tdsAmount || 0) - (figs.debitedAmount || 0));
    return left <= 0.005 ? 'paid' : (figs.paidAmount || 0) + (figs.tdsAmount || 0) > 0 ? 'part_paid' : 'open';
  }
  if (type === 'Expense' && ['approved', 'paid'].includes(d.status)) return r2((d.totals?.grand || 0) - (figs.paidAmount || 0)) <= 0.005 ? 'paid' : 'approved';
  return d.status;
}

/** Put every drifted figure back to what its vouchers and notes say. */
async function repairDerived(actor = null) {
  const drift = await derivedDrift();
  const byDoc = new Map();
  for (const r of drift) {
    const k = `${r.docType}:${r.doc}`;
    const o = byDoc.get(k) || { docType: r.docType, doc: r.doc, set: {} };
    o.set[r.field] = r.expected;
    byDoc.set(k, o);
  }
  let fixed = 0;
  for (const { docType, doc, set } of byDoc.values()) {
    const spec = FIELDS[docType];
    const d = await spec.model.findById(doc).lean();
    if (!d) continue;
    const figs = { ...d, ...set };
    const status = statusFor(docType, d, figs);
    const $set = { ...set, ...(status && status !== d.status ? { status } : {}) };
    const mark = buildFingerprint(ACTION_CODES.BOOKS_REPAIRED, { entityId: doc, actor, meta: { before: Object.fromEntries(Object.keys(set).map((f) => [f, d[f] ?? 0])), after: $set } });
    await spec.model.updateOne({ _id: doc }, { $set, ...(spec.model.schema.path('fingerprints') ? { $push: { fingerprints: mark } } : {}) });
    fixed += 1;
  }
  return { fixed, figures: drift.length };
}

/** Each party's ledger balance against what its open documents and credits say. */
async function ledgerVsDocuments() {
  const rows = [];
  for (const partyType of ['customer', 'supplier']) {
    const open = partyType === 'customer' ? await outstanding.receivables() : await outstanding.payables();
    const owed = new Map();
    for (const r of open) add(owed, r.party, 'v', r.outstanding);
    const ahead = await credits.byParty(partyType);
    const balances = await partyLedger.balances(partyType);
    const parties = new Set([...owed.keys(), ...ahead.keys(), ...balances.keys()]);
    const names = new Map((await (partyType === 'customer' ? Customer : Supplier).find({ _id: { $in: [...parties] } }).select('name').lean()).map((p) => [String(p._id), p.name]));
    for (const id of parties) {
      // Customer: debit balance = what they owe. Supplier: credit balance = what we owe.
      const docs = r2((owed.get(id)?.v || 0) - (ahead.get(id)?.available || 0));
      const ledger = r2(balances.get(id) || 0);
      if (off(docs, ledger)) rows.push({ partyType, party: id, partyName: names.get(id) || '?', ledger, documents: docs, difference: r2(ledger - docs) });
    }
  }
  return rows.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
}

const TYPES = [
  ['Invoice', Invoice, 'invoiceNumber', 'invoiceDate', ['cancelled']],
  ['SupplierBill', SupplierBill, 'billNo', 'billDate', ['cancelled']],
  ['Expense', Expense, 'expenseNo', 'date', ['cancelled', 'rejected']],
  ['AccountNote', AccountNote, 'noteNo', 'date', ['cancelled']],
  ['Payment', Payment, 'voucherNo', 'date', ['cancelled']],
  ['Contra', Contra, 'contraNo', 'date', ['cancelled']],
  ['Journal', Journal, 'journalNo', 'date', ['cancelled']],
];

/** Sent to Tally, then cancelled here: the next export cancels them there. */
async function cancelledAfterSending() {
  const rows = [];
  for (const [docType, Model, no, dateField] of TYPES) {
    const docs = await Model.find({ status: 'cancelled', 'tally.batch': { $ne: null }, $or: [{ 'tally.cancelBatch': null }, { 'tally.cancelBatch': { $exists: false } }] }).select(`${no} ${dateField}`).limit(200).lean();
    for (const d of docs) rows.push({ docType, doc: d._id, docNo: d[no], date: d[dateField] });
  }
  return rows;
}

/** A date stored with a time of day whose day in India is the next day in UTC: its month may differ. */
async function datesAcrossMidnight() {
  const rows = [];
  for (const [docType, Model, no, dateField, dead] of TYPES) {
    const docs = await Model.find({ status: { $nin: dead }, $expr: { $gte: [{ $add: [{ $multiply: [{ $hour: `$${dateField}` }, 60] }, { $minute: `$${dateField}` }] }, 18 * 60 + 30] } }).select(`${no} ${dateField}`).limit(200).lean();
    for (const d of docs) {
      const ist = new Date(new Date(d[dateField]).getTime() + IST);
      rows.push({ docType, doc: d._id, docNo: d[no], stored: d[dateField], indiaDate: ist.toISOString().slice(0, 10) });
    }
  }
  return rows;
}

/** Totals that are not their lines (more than a rupee off, after round-off). */
async function totalsVsLines() {
  const rows = [];
  for (const [docType, Model, no, , dead] of TYPES.filter(([t]) => ['Invoice', 'SupplierBill', 'Expense', 'AccountNote'].includes(t))) {
    const docs = await Model.find({ status: { $nin: dead } }).select(`${no} lines.amount lines.taxable lines.cgst lines.sgst lines.igst totals reverseCharge`).lean();
    for (const d of docs) {
      // Under reverse charge the lines carry the tax the supplier did not
      // charge; the bill's total is their value without it.
      const lines = r2((d.lines || []).reduce((s, l) => s + (d.reverseCharge ? (l.taxable || 0) : (l.amount ?? ((l.taxable || 0) + (l.cgst || 0) + (l.sgst || 0) + (l.igst || 0)))), 0));
      const grand = r2((d.totals?.grand || 0) - (d.totals?.roundOff || 0));
      if (d.lines?.length && Math.abs(lines - grand) > 1) rows.push({ docType, doc: d._id, docNo: d[no], lines, total: r2(d.totals?.grand || 0) });
    }
  }
  return rows;
}

/** Posted inside the closed period after it was closed. */
async function postedAfterLock() {
  const s = await getSettings();
  if (!s.lockDate || !s.lockedAt) return [];
  const rows = [];
  for (const [docType, Model, no, dateField] of TYPES) {
    const docs = await Model.find({ [dateField]: { $lte: s.lockDate }, createdAt: { $gt: s.lockedAt } }).select(`${no} ${dateField} createdAt`).limit(100).lean();
    for (const d of docs) rows.push({ docType, doc: d._id, docNo: d[no], date: d[dateField], createdAt: d.createdAt });
  }
  return rows;
}

/** Statement lines marked in the books whose voucher was cancelled since. */
async function bankLinesOnCancelled() {
  const statements = await BankStatement.find({ 'lines.voucher': { $ne: null } }).select('file lines.index lines.voucher lines.voucherType lines.voucherNo lines.status').lean();
  const ids = { Payment: new Set(), Contra: new Set() };
  for (const s of statements) for (const l of s.lines) if (l.voucher && ['recorded', 'posted'].includes(l.status)) ids[l.voucherType === 'Contra' ? 'Contra' : 'Payment'].add(String(l.voucher));
  const dead = new Set([
    ...(await Payment.find({ _id: { $in: [...ids.Payment] }, status: 'cancelled' }).select('_id').lean()).map((d) => String(d._id)),
    ...(await Contra.find({ _id: { $in: [...ids.Contra] }, status: 'cancelled' }).select('_id').lean()).map((d) => String(d._id)),
  ]);
  const rows = [];
  for (const s of statements) for (const l of s.lines) if (l.voucher && dead.has(String(l.voucher)) && ['recorded', 'posted'].includes(l.status)) rows.push({ statement: s._id, file: s.file, index: l.index, voucherNo: l.voucherNo });
  return rows;
}

/** Parties whose name in Tally today is not the one their sent documents went under. */
async function renamedAfterSending() {
  const rows = [];
  const sent = { 'tally.batch': { $ne: null } };
  const pairs = [
    ['customer', Customer, await Invoice.aggregate([{ $match: sent }, { $group: { _id: '$customer', names: { $addToSet: '$buyer.name' } } }])],
    ['supplier', Supplier, await SupplierBill.aggregate([{ $match: sent }, { $group: { _id: '$supplier', names: { $addToSet: '$supplierName' } } }])],
  ];
  for (const [partyType, Model, groups] of pairs) {
    const parties = new Map((await Model.find({ _id: { $in: groups.map((g) => g._id) } }).select('name tallyName').lean()).map((p) => [String(p._id), p]));
    for (const g of groups) {
      const p = parties.get(String(g._id));
      if (!p) continue;
      const now = p.tallyName || p.name;
      const other = g.names.filter((n) => n && n !== now);
      if (other.length) rows.push({ partyType, party: p._id, name: p.name, tallyName: p.tallyName || '', sentAs: other });
    }
  }
  return rows;
}

const CHECKS = [
  { key: 'derived', label: 'Paid, credited and unallocated figures match their vouchers and notes', severity: 'critical', run: derivedDrift, fix: 'repair', explain: 'A document\'s running figure differs from what its vouchers and notes add up to. Outstanding, statements and the forecast read these figures.' },
  { key: 'ledger', label: 'Party ledgers match the open documents', severity: 'critical', run: ledgerVsDocuments, fix: 'rebuild', explain: 'A party\'s ledger balance differs from its open documents less what it paid ahead. Rebuilding the ledger re-posts it from the documents.' },
  { key: 'cancelled', label: 'Cancelled here after going to Tally', severity: 'warning', run: cancelledAfterSending, fix: null, explain: 'Still live in Tally. The next export cancels each one there (Tally voucher numbering must keep the numbers sent).' },
  { key: 'renamed', label: 'Parties renamed after their documents went to Tally', severity: 'warning', run: renamedAfterSending, fix: null, explain: 'New vouchers would go to a ledger of the new name, beside the old one. Set "Name in Tally" on the party to the name Tally has.' },
  { key: 'midnight', label: 'Dates whose day in India is not the stored day', severity: 'warning', run: datesAcrossMidnight, fix: null, explain: 'Entered between midnight and 5:30 am, stored as the evening before. The month here and in Tally can differ.' },
  { key: 'totals', label: 'Totals equal their lines', severity: 'warning', run: totalsVsLines, fix: null, explain: 'A total more than a rupee off its lines.' },
  { key: 'lock', label: 'Nothing posted into closed months', severity: 'critical', run: postedAfterLock, fix: null, explain: 'Entered after the books were closed, dated inside the closed period: Tally will not have it.' },
  { key: 'bank', label: 'Bank lines point at live vouchers', severity: 'warning', run: bankLinesOnCancelled, fix: null, explain: 'A statement line marked in the books whose voucher was cancelled since: the line is not in the books any more.' },
];

async function check() {
  const out = [];
  for (const c of CHECKS) {
    let rows = [];
    let error = null;
    try { rows = await c.run(); } catch (err) { error = err.message; }
    out.push({ key: c.key, label: c.label, severity: c.severity, explain: c.explain, fix: c.fix, ok: !error && rows.length === 0, count: rows.length, rows: rows.slice(0, MAX_ROWS), error });
  }
  return { ranAt: new Date(), checks: out };
}

module.exports = { check, repairDerived, derivedDrift, expectedFigures, ledgerVsDocuments, cancelledAfterSending, renamedAfterSending, datesAcrossMidnight, initialApplied, CHECKS };
