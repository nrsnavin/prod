'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S DEBIT NOTE, INTO OUR CREDIT NOTE
//
//  fromPhoto({ pages, customer }) → { read, customer, invoice, notesSoFar,
//    draft, checks, aiSuggestion }
//
//  A customer debits us (goods short, rejected, a rate difference, a
//  late-delivery penalty) or writes that they paid an invoice short and
//  why. Each deduction used to be worked out by hand into a credit note.
//  The paper is read (utils/paperReaders.js), then here, not by the model:
//    · the customer by GSTIN, else by name;
//    · the invoice it names, among that customer's issued invoices (the
//      full number, else the number it ends in, when only one does);
//    · the amount: before GST at the invoice's own rate, from the taxable
//      value it states, else worked back from its total;
//    · what is still open to credit on that invoice, after the notes
//      already issued against it, and the GST time limit (s.34(2)): past
//      it, a financial credit note, no tax.
//  The draft is POST /accounts/notes's body. Nothing is issued here.
// ══════════════════════════════════════════════════════════════════

const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const AccountNote = require('../models/AccountNote');
const creditNoteLimit = require('./creditNoteLimit');
const { nameScore } = require('./partyMatch');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');
const { r2 } = require('../utils/money');

const SURFACE = 'debit-note-ocr';
const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const lastNumber = (s) => { const m = String(s || '').match(/(\d+)\D*$/); return m ? Number(m[1]) : null; };
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function findCustomer(read, picked) {
  if (picked) {
    const c = await Customer.findById(picked).select('name gstin').lean();
    if (c) return { ...c, matchedBy: 'picked' };
  }
  if (/^[0-9A-Z]{15}$/.test(read.customerGstin || '')) {
    const c = await Customer.findOne({ gstin: read.customerGstin }).select('name gstin').lean();
    if (c) return { ...c, matchedBy: 'gstin' };
  }
  if (!read.customerName) return null;
  const all = await Customer.find({}).select('name gstin').lean();
  const scored = all.map((c) => ({ c, s: nameScore(read.customerName, c.name) })).filter((x) => x.s >= 0.75).sort((a, b) => b.s - a.s);
  if (!scored.length || (scored.length > 1 && scored[1].s >= scored[0].s - 0.1)) return null;
  return { ...scored[0].c, matchedBy: 'name' };
}

/** The customer's invoice a number names: the whole number, else the one number it ends in. */
function invoiceFor(no, invoices) {
  const exact = invoices.filter((i) => squash(i.invoiceNumber) === squash(no));
  if (exact.length === 1) return { invoice: exact[0] };
  const n = lastNumber(no);
  if (n == null) return { why: `"${no}" has no number in it` };
  const byNumber = invoices.filter((i) => lastNumber(i.invoiceNumber) === n);
  if (byNumber.length === 1) return { invoice: byNumber[0], short: true };
  if (byNumber.length > 1) return { why: `more than one invoice of theirs ends in ${n}` };
  return { why: `"${no}" is not one of their invoices` };
}

/** What credit notes have already taken off an invoice, and what is left to credit. */
async function roomOn(invoice) {
  const notes = await AccountNote.find({ kind: 'credit', status: 'issued', 'against.docType': 'Invoice', 'against.doc': invoice._id }).select('noteNo totals.grand').lean();
  const credited = r2(notes.reduce((t, n) => t + (n.totals?.grand || 0), 0));
  return { notes: notes.map((n) => ({ noteNo: n.noteNo, amount: n.totals?.grand || 0 })), credited, left: r2((invoice.totals?.grand || 0) - credited) };
}

/**
 * The note before GST, at the invoice's rate: the taxable value it states,
 * else its total worked back. → { taxable, gstPercent, how }
 */
function amountOf(read, gstPercent) {
  if (read.taxable != null && read.taxable > 0) return { taxable: r2(read.taxable), how: 'the taxable value it states' };
  if (read.total != null && read.total > 0) return { taxable: r2(read.total / (1 + gstPercent / 100)), how: `its total less GST at ${gstPercent}%` };
  const lines = r2((read.lines || []).reduce((t, l) => t + (l.amount || 0), 0));
  if (lines > 0) return { taxable: lines, how: 'its lines added up' };
  return { taxable: null, how: '' };
}

async function fromPhoto({ pages, customer = null } = {}) {
  const startedAt = Date.now();
  let read;
  try {
    read = await require('../utils/paperReaders').readDebitNote(pages);
  } catch (err) {
    if (!err.code) await aiLedger.record({ surface: SURFACE, model: '?', promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
    throw err;
  }
  const { model, usage, latencyMs, ...fields } = read;
  const record = (proposed) => aiLedger.record({ surface: SURFACE, model, promptVersion: promptVersion(SURFACE), proposed, latencyMs, usage })
    .then((id) => (id ? String(id) : null)).catch(() => null);
  if (fields.problem) return { read: fields, customer: null, invoice: null, draft: null, checks: [], aiSuggestion: await record({ problem: fields.problem }) };

  const checks = [];
  const flag = (code, severity, message) => checks.push({ code, severity, message });
  const party = await findCustomer(fields, customer);
  if (!party) flag('CUSTOMER', 'danger', `${fields.customerName || 'The customer'} is not matched to a customer on file: pick one`);
  let invoice = null;
  let others = [];
  if (party) {
    const invoices = await Invoice.find({ customer: party._id, status: 'issued' }).select('invoiceNumber invoiceDate totals lines.gstPercent').sort({ invoiceDate: -1 }).limit(500).lean();
    const found = fields.invoices.map((no) => ({ no, ...invoiceFor(no, invoices) }));
    const hits = found.filter((f) => f.invoice);
    for (const f of found.filter((x) => !x.invoice)) flag('INVOICE', 'warning', `${f.why}`);
    invoice = hits[0]?.invoice || null;
    others = hits.slice(1).map((h) => h.invoice.invoiceNumber);
    if (!fields.invoices.length) flag('INVOICE', 'danger', 'It names no invoice of ours: pick the one it is against');
    if (others.length) flag('MANY', 'warning', `It names ${hits.length} invoices; the note is drafted against ${invoice.invoiceNumber}. Split it if each needs its own`);
    if (hits[0]?.short) flag('SHORT_NO', 'info', `"${hits[0].no}" taken as ${invoice.invoiceNumber}`);
  }
  const gstPercent = invoice?.lines?.[0]?.gstPercent ?? 5;
  const amt = amountOf(fields, gstPercent);
  let draft = null;
  let room = null;
  if (invoice && amt.taxable) {
    const today = new Date();
    const lim = creditNoteLimit.check(invoice.invoiceDate, today);
    const financial = lim.past;
    room = await roomOn(invoice);
    const grand = r2(amt.taxable * (1 + (financial ? 0 : gstPercent) / 100));
    if (grand > room.left + 0.5) flag('ROOM', 'danger', `${rupees(grand)} is more than the ${rupees(room.left)} still open to credit on ${invoice.invoiceNumber}${room.notes.length ? ` (after ${room.notes.map((n) => n.noteNo).join(', ')})` : ''}`);
    if (financial) flag('TIME_LIMIT', 'warning', `Past the GST time limit for ${invoice.invoiceNumber}: issued as a financial credit note, no GST`);
    if (fields.gst != null && fields.taxable != null && !financial && Math.abs(r2(fields.taxable * gstPercent / 100) - fields.gst) > 1) flag('GST', 'warning', `Their GST (${rupees(fields.gst)}) is not ${gstPercent}% of ${rupees(fields.taxable)}, the invoice's rate`);
    const reason = [fields.kind === 'short_payment' ? 'Short payment' : `Their debit note${fields.noteNo ? ` ${fields.noteNo}` : ''}`, fields.reason].filter(Boolean).join(': ').slice(0, 300) || 'Their debit note';
    draft = {
      kind: 'credit', against: { docType: 'Invoice', doc: String(invoice._id), docNo: invoice.invoiceNumber },
      reason, partyNoteNo: fields.noteNo || '', financial,
      lines: [{ description: (fields.reason || 'As per their debit note').slice(0, 200), quantity: 1, rate: amt.taxable, gstPercent: financial ? 0 : gstPercent }],
      totals: { taxable: amt.taxable, gst: r2(grand - amt.taxable), grand }, basis: amt.how,
    };
  } else if (invoice && !amt.taxable) {
    flag('AMOUNT', 'danger', 'No amount was read: type it in');
  }
  return {
    read: fields,
    customer: party ? { _id: String(party._id), name: party.name, matchedBy: party.matchedBy } : null,
    invoice: invoice ? { _id: String(invoice._id), invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, grand: invoice.totals?.grand || 0, gstPercent, others } : null,
    notesSoFar: room,
    draft, checks,
    aiSuggestion: await record({ customer: party ? String(party._id) : null, invoice: invoice ? String(invoice._id) : null, taxable: amt.taxable }),
  };
}

/** What the credit note issued from it kept, to score the read. */
function accepted(note) {
  return { customer: note.customer ? String(note.customer) : null, invoice: note.against?.doc ? String(note.against.doc) : null, taxable: note.totals?.taxable ?? null };
}

module.exports = { fromPhoto, findCustomer, invoiceFor, roomOn, amountOf, accepted, SURFACE };
