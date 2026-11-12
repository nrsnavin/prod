'use strict';
// ══════════════════════════════════════════════════════════════════
//  INTEREST ON OVERDUE RECEIVABLES
//
//  Simple interest on an invoice past its due date, at the customer's
//  rate (else the rate in Settings), once it is past the grace days.
//  What the interest is worked on is a setting (receivables.
//  interestBasis):
//
//    balance    what the invoice still owes on the day asked, for the
//               days since it fell due. The way it has always been
//               worked. A part paid late is not charged for the days it
//               was late, and an invoice paid late in full is not
//               charged at all.
//    payments   each rupee, for the days it stayed unpaid after the due
//               date: up to the day it was paid, or the day asked. Parts
//               are paid oldest first. An invoice paid late in full in
//               the last year is charged for its lateness.
//
//  Interest already charged by an earlier debit note (which carries, per
//  invoice, the days it covered) is not charged twice: the next note
//  runs from the day after. The server checks that itself when a note
//  arrives — the days a note says it covers came from the browser, and
//  nothing used to stop the same days being charged again.
//
//  The debit note goes out through the ordinary notes route; this
//  drafts its body. Interest on a delayed payment is part of the value
//  of the supply (CGST s.15(2)(d)), so each line carries the invoice's
//  own GST rate.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const AccountNote = require('../models/AccountNote');
const Payment = require('../models/Payment');
const OpeningBalance = require('../models/OpeningBalance');
const Journal = require('../models/Journal');
const outstanding = require('./outstanding');
const { getSettings } = require('./booksLock');
const { isId, r2, DAY, businessDay } = require('./accountsHelpers');

const BASES = ['balance', 'payments'];
/** On the payments basis an invoice already paid is still looked at for this long after it fell due. */
const LOOKBACK_DAYS = 365;

const dmy = (d) => { const t = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`; };
const dayOf = (d) => new Date(new Date(d).toISOString().slice(0, 10) + 'T00:00:00Z');

/** The rate and grace that apply to a customer: theirs, else the books'. */
function termsFor(customer, settings) {
  const s = settings.receivables || {};
  const rate = customer?.interestRate !== null && customer?.interestRate !== undefined && customer.interestRate !== '' ? Number(customer.interestRate) : Number(s.interestRate) || 0;
  const grace = customer?.interestGraceDays !== null && customer?.interestGraceDays !== undefined ? Number(customer.interestGraceDays) : Number(s.graceDays) || 0;
  return { rate, grace };
}

/** Interest already charged, per invoice: the latest day a note ran to. Map(invoiceId → Date) */
async function chargedTo(customerIds) {
  const charged = new Map();
  if (!customerIds.length) return charged;
  const notes = await AccountNote.find({ status: 'issued', kind: 'debit', partyType: 'customer', 'interest.0': { $exists: true }, customer: { $in: customerIds } }).select('interest').lean();
  for (const n of notes) for (const i of n.interest || []) {
    const k = String(i.invoice);
    if (!charged.has(k) || new Date(i.to) > new Date(charged.get(k))) charged.set(k, i.to);
  }
  return charged;
}

/**
 * What each invoice was settled by, and when. Map(invoiceId → [{ on, amount }]),
 * oldest first; a debit note that raised the invoice is a negative amount.
 */
async function settlementsOf(invoiceIds) {
  const out = new Map(invoiceIds.map((id) => [String(id), []]));
  if (!invoiceIds.length) return out;
  const add = (doc, on, amount) => { const list = out.get(String(doc)); if (list && amount) list.push({ on: dayOf(on), amount: r2(amount) }); };
  const [vouchers, notes, advances, journals] = await Promise.all([
    Payment.find({ status: 'posted', 'allocations.doc': { $in: invoiceIds } }).select('date allocations').lean(),
    AccountNote.find({ status: 'issued', partyType: 'customer', $or: [{ 'against.doc': { $in: invoiceIds } }, { 'applications.doc': { $in: invoiceIds } }] }).select('kind date against applied unapplied applications totals').lean(),
    OpeningBalance.find({ status: 'posted', 'applications.doc': { $in: invoiceIds } }).select('applications').lean(),
    Journal.find({ status: 'posted', 'lines.refs.doc': { $in: invoiceIds } }).select('date lines.refs').lean(),
  ]);
  // A receipt settles on its own date; credit applied later, on the day it was applied.
  for (const v of vouchers) for (const a of v.allocations || []) if (a.docType === 'Invoice') add(a.doc, a.appliedAt ? businessDay(a.appliedAt) : v.date, a.amount);
  for (const n of notes) {
    // What a note set against its own invoice (an older note carries no `applied`: all of it).
    const whole = n.applied === undefined || n.applied === null || (n.applied === 0 && !n.unapplied && !(n.applications || []).length);
    const own = whole ? n.totals?.grand || 0 : n.applied;
    if (n.against?.docType === 'Invoice') add(n.against.doc, n.date, n.kind === 'debit' ? -own : own);
    for (const a of n.applications || []) if (a.docType === 'Invoice') add(a.doc, businessDay(a.at || n.date), a.amount);
  }
  for (const o of advances) for (const a of o.applications || []) if (a.docType === 'Invoice') add(a.doc, businessDay(a.at), a.amount);
  for (const j of journals) for (const l of j.lines || []) for (const r of l.refs || []) if (r.docType === 'Invoice') add(r.doc, j.date, r.amount);
  for (const list of out.values()) list.sort((x, y) => x.on - y.on);
  return out;
}

/**
 * Interest on one invoice, each rupee for the days it stayed unpaid
 * after it fell due. What was paid goes against the oldest part first;
 * a debit note raising the invoice is a part of its own, due the day it
 * was raised. A part settled within the grace days bears nothing; one
 * settled later bears interest from the day after it fell due (or the
 * day after the last charge) to the day it was paid.
 *
 * @param events  [{ on, amount }] oldest first; negative = a raise
 * @returns {{ interest, parts: [{ amount, from, to, days }], outstanding }}
 */
function byPayments({ grand, due, events = [], charged = null, asOf, rate, grace = 0 }) {
  const lots = [{ amount: r2(grand), start: dayOf(due) }];
  const last = charged ? dayOf(charged) : null;
  const parts = [];
  const piece = (amount, start, end) => {   // `amount` unpaid from the day after `start` up to `end`
    if (amount <= 0.005 || Math.round((end - start) / DAY) <= grace) return;
    const from = last && last > start ? last : start;
    const days = Math.round((end - from) / DAY);
    if (days > 0) parts.push({ amount: r2(amount), from: new Date(from.getTime() + DAY), to: end, days });
  };
  for (const e of events) {
    if (e.on > asOf) break;                  // what happened after the day asked is not counted
    if (e.amount < 0) { lots.push({ amount: r2(-e.amount), start: e.on }); continue; }
    let left = e.amount;
    while (left > 0.005 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.amount, left);
      piece(take, lot.start, e.on);
      lot.amount = r2(lot.amount - take);
      left = r2(left - take);
      if (lot.amount <= 0.005) lots.shift();
    }
  }
  for (const lot of lots) piece(lot.amount, lot.start, asOf);
  return {
    interest: r2(parts.reduce((t, p) => t + p.amount * (rate / 100) * (p.days / 365), 0)),
    parts,
    outstanding: r2(lots.reduce((t, l) => t + l.amount, 0)),
  };
}

/** Interest due per invoice, grouped by customer, as at `asOf`. */
async function compute({ asOf = new Date(), customer } = {}) {
  const day = dayOf(asOf);
  const settings = await getSettings();
  const basis = BASES.includes(settings.receivables?.interestBasis) ? settings.receivables.interestBasis : 'balance';
  const rows = basis === 'payments' ? await rowsByPayments({ day, customer, settings }) : await rowsByBalance({ day, customer, settings });
  const invIds = rows.map((r) => r.invoice);
  const gstOf = new Map((await Invoice.find({ _id: { $in: invIds } }).select('lines.gstPercent').lean()).map((i) => [String(i._id), Math.max(0, ...(i.lines || []).map((l) => Number(l.gstPercent) || 0))]));
  const byCustomer = new Map();
  for (const { party, partyName, grace, ...r } of rows) {
    const g = byCustomer.get(String(party)) || { party, partyName, rate: r.rate, grace, rows: [], total: 0, outstanding: 0 };
    g.rows.push({ ...r, gstPercent: gstOf.get(String(r.invoice)) || 0 });
    g.total = r2(g.total + r.interest); g.outstanding = r2(g.outstanding + r.outstanding);
    byCustomer.set(String(party), g);
  }
  const groups = [...byCustomer.values()].sort((a, b) => b.total - a.total);
  return { asOf: day, settings: { rate: Number(settings.receivables?.interestRate) || 0, graceDays: Number(settings.receivables?.graceDays) || 0, basis }, groups, total: r2(groups.reduce((s, g) => s + g.total, 0)) };
}

/** On what each invoice still owes on the day asked. */
async function rowsByBalance({ day, customer, settings }) {
  const open = (await outstanding.receivables({ customer, asOf: new Date(day.getTime() + DAY - 1) })).filter((r) => r.docType === 'Invoice' && r.overdueDays > 0);
  const custIds = [...new Set(open.map((r) => String(r.party)))];
  const customers = new Map((await Customer.find({ _id: { $in: custIds } }).select('name interestRate interestGraceDays gstin').lean()).map((c) => [String(c._id), c]));
  const charged = await chargedTo(custIds);
  const rows = [];
  for (const r of open) {
    const { rate, grace } = termsFor(customers.get(String(r.party)), settings);
    if (!(rate > 0) || r.overdueDays <= grace) continue;
    const due = dayOf(r.dueDate);
    const last = charged.get(String(r.id));
    // Runs from the day after the due date (or after the last charge) to asOf.
    const from = last ? new Date(dayOf(last).getTime() + DAY) : new Date(due.getTime() + DAY);
    const days = Math.round((day - from) / DAY) + 1;
    if (days <= 0) continue;
    const interest = r2(r.outstanding * (rate / 100) * (days / 365));
    if (interest < 1) continue;
    rows.push({ party: r.party, partyName: r.partyName, grace, invoice: r.id, docNo: r.docNo, date: r.date, dueDate: r.dueDate, outstanding: r.outstanding, overdueDays: r.overdueDays, from, to: day, days, rate, interest, chargedTo: last || null });
  }
  return rows;
}

/** On each rupee for the days it stayed unpaid: open invoices, and those paid in the last year. */
async function rowsByPayments({ day, customer, settings }) {
  const q = {
    status: 'issued', invoiceDate: { $lt: day },
    $or: [
      { $expr: outstanding.stillOpen(['$totals.grand', '$debitedAmount'], ['$paidAmount', '$creditedAmount']) },
      { dueDate: { $gte: new Date(day.getTime() - LOOKBACK_DAYS * DAY) } },
    ],
  };
  if (customer) q.customer = customer;
  const invoices = await Invoice.find(q).select('invoiceNumber invoiceDate dueDate customer buyer.name totals.grand').sort({ invoiceDate: 1 }).lean();
  const custIds = [...new Set(invoices.map((i) => String(i.customer)))];
  const customers = new Map((await Customer.find({ _id: { $in: custIds } }).select('name interestRate interestGraceDays').lean()).map((c) => [String(c._id), c]));
  // Only customers who are charged interest at all.
  const charging = invoices.filter((i) => termsFor(customers.get(String(i.customer)), settings).rate > 0 && dayOf(outstanding.dueOf(i.dueDate, i.invoiceDate)) < day);
  const [charged, settled] = await Promise.all([chargedTo([...new Set(charging.map((i) => String(i.customer)))]), settlementsOf(charging.map((i) => i._id))]);
  const rows = [];
  for (const inv of charging) {
    const { rate, grace } = termsFor(customers.get(String(inv.customer)), settings);
    const due = dayOf(outstanding.dueOf(inv.dueDate, inv.invoiceDate));
    const last = charged.get(String(inv._id)) || null;
    const r = byPayments({ grand: inv.totals?.grand || 0, due, events: settled.get(String(inv._id)), charged: last, asOf: day, rate, grace });
    if (r.interest < 1) continue;
    const from = r.parts.reduce((m, p) => (p.from < m ? p.from : m), r.parts[0].from);
    rows.push({
      party: inv.customer, partyName: inv.buyer?.name || '', grace, invoice: inv._id, docNo: inv.invoiceNumber, date: inv.invoiceDate, dueDate: due,
      outstanding: r.outstanding, overdueDays: Math.max(0, Math.round((day - due) / DAY)), from, to: day, days: Math.round((day - from) / DAY) + 1, rate, interest: r.interest,
      chargedTo: last, parts: r.parts,
    });
  }
  return rows;
}

/** A note line's wording for one invoice: what was charged, on what, for which days. */
function describe(r) {
  if (!r.parts) return `Interest on ${r.docNo} (₹${r.outstanding.toFixed(2)} due ${dmy(r.dueDate)}): ${dmy(r.from)} to ${dmy(r.to)}, ${r.days} days @ ${r.rate}% p.a.`;
  // Each part with the days it was late; a long list is cut short (the days covered are kept on the note in full).
  const shown = r.parts.slice(0, 3).map((p) => `₹${p.amount.toFixed(2)} × ${p.days} days`).join(', ');
  return `Interest on ${r.docNo} (due ${dmy(r.dueDate)}) to ${dmy(r.to)} @ ${r.rate}% p.a.: ${shown}${r.parts.length > 3 ? ` and ${r.parts.length - 3} more` : ''}`.slice(0, 200);
}

/** The body of the debit note that charges one customer's interest. */
async function draft({ customer, asOf = new Date() }) {
  if (!isId(customer)) throw new ErrorHandler('customer is required', 400);
  const c = await compute({ asOf, customer });
  const g = c.groups[0];
  if (!g) throw new ErrorHandler('No interest is due from this customer on that day', 409);
  const oldest = [...g.rows].sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  return {
    customer: g.party, partyName: g.partyName, asOf: c.asOf, total: g.total, rows: g.rows,
    body: {
      kind: 'debit', partyType: 'customer', against: { doc: oldest.invoice, docNo: oldest.docNo }, date: c.asOf.toISOString().slice(0, 10),
      reason: `Interest on overdue invoices to ${dmy(c.asOf)} @ ${g.rate}% p.a.`,
      lines: g.rows.map((r) => ({ description: describe(r), quantity: 1, rate: r.interest, gstPercent: r.gstPercent, hsn: '' })),
      interest: g.rows.map((r) => ({ invoice: r.invoice, docNo: r.docNo, from: r.from, to: r.to, days: r.days, rate: r.rate, amount: r.interest })),
    },
  };
}

/** Interest markers from a note body, read: whole days, and the days counted from the dates themselves. */
function readMarkers(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const seen = new Set();
  return raw.map((m, i) => {
    if (!isId(m?.invoice)) throw new ErrorHandler(`Interest ${i + 1}: invoice is required`, 400);
    if (seen.has(String(m.invoice))) throw new ErrorHandler(`Interest ${i + 1}: the same invoice twice`, 400);
    seen.add(String(m.invoice));
    const from = new Date(m.from); const to = new Date(m.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new ErrorHandler(`Interest ${i + 1}: from and to must be dates in order`, 400);
    return { invoice: m.invoice, docNo: String(m.docNo || '').slice(0, 40), from: dayOf(from), to: dayOf(to), days: Math.round((dayOf(to) - dayOf(from)) / DAY) + 1, rate: Number(m.rate) || 0, amount: r2(m.amount) };
  });
}

/**
 * The days an interest note says it covers, held to the books. Each
 * invoice is this customer's and live; the days start after it fell due
 * and end by the note's own date; and none of them were charged by an
 * earlier note. Throws ErrorHandler. Call it where two notes for one
 * customer cannot run together (api/accountsNotes.js takes a lease).
 */
async function checkMarkers(markers, { customer, date }) {
  if (!markers.length) return;
  const ids = markers.map((m) => m.invoice);
  const invoices = new Map((await Invoice.find({ _id: { $in: ids } }).select('invoiceNumber customer status invoiceDate dueDate').lean()).map((i) => [String(i._id), i]));
  for (const [i, m] of markers.entries()) {
    const inv = invoices.get(String(m.invoice));
    if (!inv) throw new ErrorHandler(`Interest ${i + 1}: invoice not found`, 404);
    if (String(inv.customer) !== String(customer)) throw new ErrorHandler(`Interest ${i + 1}: ${inv.invoiceNumber} belongs to another customer`, 400);
    if (inv.status !== 'issued') throw new ErrorHandler(`Interest ${i + 1}: ${inv.invoiceNumber} is cancelled`, 409);
    const due = dayOf(outstanding.dueOf(inv.dueDate, inv.invoiceDate));
    if (m.from <= due) throw new ErrorHandler(`Interest ${i + 1}: ${inv.invoiceNumber} fell due on ${dmy(due)} — interest runs from the day after`, 400);
    if (m.to > dayOf(date)) throw new ErrorHandler(`Interest ${i + 1}: ${inv.invoiceNumber} is charged to ${dmy(m.to)}, after the note's own date`, 400);
  }
  const earlier = await AccountNote.find({ status: 'issued', kind: 'debit', partyType: 'customer', customer, 'interest.invoice': { $in: ids } }).select('noteNo interest').lean();
  for (const m of markers) {
    for (const n of earlier) for (const x of n.interest || []) {
      if (String(x.invoice) !== String(m.invoice)) continue;
      if (m.from <= dayOf(x.to) && m.to >= dayOf(x.from)) {
        throw new ErrorHandler(`Interest on ${invoices.get(String(m.invoice)).invoiceNumber} was already charged from ${dmy(x.from)} to ${dmy(x.to)} by ${n.noteNo} — draft the note again to charge from the day after`, 409);
      }
    }
  }
}

module.exports = { compute, draft, readMarkers, checkMarkers, termsFor, byPayments, BASES };
