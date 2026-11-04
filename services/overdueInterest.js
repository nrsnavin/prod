'use strict';
// ══════════════════════════════════════════════════════════════════
//  INTEREST ON OVERDUE RECEIVABLES
//
//  Simple interest on what each invoice still owes, from its due date
//  to the day asked, at the customer's rate (else the rate in
//  Settings), once the invoice is past the grace days. Interest already
//  charged by an earlier debit note (which carries, per invoice, the
//  day it was charged up to) is not charged twice: the next note runs
//  from there.
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
const outstanding = require('./outstanding');
const { getSettings } = require('./booksLock');
const { isId, r2, DAY } = require('./accountsHelpers');

const dmy = (d) => { const t = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${p(t.getUTCDate())}-${p(t.getUTCMonth() + 1)}-${t.getUTCFullYear()}`; };
const dayOf = (d) => new Date(new Date(d).toISOString().slice(0, 10) + 'T00:00:00Z');

/** The rate and grace that apply to a customer: theirs, else the books'. */
function termsFor(customer, settings) {
  const s = settings.receivables || {};
  const rate = customer?.interestRate !== null && customer?.interestRate !== undefined && customer.interestRate !== '' ? Number(customer.interestRate) : Number(s.interestRate) || 0;
  const grace = customer?.interestGraceDays !== null && customer?.interestGraceDays !== undefined ? Number(customer.interestGraceDays) : Number(s.graceDays) || 0;
  return { rate, grace };
}

/** Interest due per invoice, grouped by customer, as at `asOf`. */
async function compute({ asOf = new Date(), customer } = {}) {
  const day = dayOf(asOf);
  const settings = await getSettings();
  const rows = (await outstanding.receivables({ customer, asOf: new Date(day.getTime() + DAY - 1) })).filter((r) => r.docType === 'Invoice' && r.overdueDays > 0);
  const custIds = [...new Set(rows.map((r) => String(r.party)))];
  const customers = new Map((await Customer.find({ _id: { $in: custIds } }).select('name interestRate interestGraceDays gstin').lean()).map((c) => [String(c._id), c]));
  // Interest already charged, per invoice: the latest day a note ran to.
  const charged = new Map();
  const notes = custIds.length ? await AccountNote.find({ status: 'issued', kind: 'debit', partyType: 'customer', 'interest.0': { $exists: true }, customer: { $in: custIds } }).select('interest').lean() : [];
  for (const n of notes) for (const i of n.interest || []) {
    const k = String(i.invoice);
    if (!charged.has(k) || new Date(i.to) > new Date(charged.get(k))) charged.set(k, i.to);
  }
  const invIds = rows.map((r) => r.id);
  const gstOf = new Map((await Invoice.find({ _id: { $in: invIds } }).select('lines.gstPercent').lean()).map((i) => [String(i._id), Math.max(0, ...(i.lines || []).map((l) => Number(l.gstPercent) || 0))]));
  const byCustomer = new Map();
  for (const r of rows) {
    const c = customers.get(String(r.party));
    const { rate, grace } = termsFor(c, settings);
    if (!(rate > 0) || r.overdueDays <= grace) continue;
    const due = dayOf(r.dueDate);
    const last = charged.get(String(r.id));
    // Runs from the day after the due date (or after the last charge) to asOf.
    const from = last ? new Date(dayOf(last).getTime() + DAY) : new Date(due.getTime() + DAY);
    const days = Math.round((day - from) / DAY) + 1;
    if (days <= 0) continue;
    const interest = r2(r.outstanding * (rate / 100) * (days / 365));
    if (interest < 1) continue;
    const g = byCustomer.get(String(r.party)) || { party: r.party, partyName: r.partyName, rate, grace, rows: [], total: 0, outstanding: 0 };
    g.rows.push({ invoice: r.id, docNo: r.docNo, date: r.date, dueDate: r.dueDate, outstanding: r.outstanding, overdueDays: r.overdueDays, from, to: day, days, rate, interest, gstPercent: gstOf.get(String(r.id)) || 0, chargedTo: last || null });
    g.total = r2(g.total + interest); g.outstanding = r2(g.outstanding + r.outstanding);
    byCustomer.set(String(r.party), g);
  }
  const groups = [...byCustomer.values()].sort((a, b) => b.total - a.total);
  return { asOf: day, settings: { rate: Number(settings.receivables?.interestRate) || 0, graceDays: Number(settings.receivables?.graceDays) || 0 }, groups, total: r2(groups.reduce((s, g) => s + g.total, 0)) };
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
      lines: g.rows.map((r) => ({ description: `Interest on ${r.docNo} (₹${r.outstanding.toFixed(2)} due ${dmy(r.dueDate)}): ${dmy(r.from)} to ${dmy(r.to)}, ${r.days} days @ ${r.rate}% p.a.`, quantity: 1, rate: r.interest, gstPercent: r.gstPercent, hsn: '' })),
      interest: g.rows.map((r) => ({ invoice: r.invoice, docNo: r.docNo, from: r.from, to: r.to, days: r.days, rate: r.rate, amount: r.interest })),
    },
  };
}

/** Interest markers from a note body, checked. */
function readMarkers(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.map((m, i) => {
    if (!isId(m?.invoice)) throw new ErrorHandler(`Interest ${i + 1}: invoice is required`, 400);
    const from = new Date(m.from); const to = new Date(m.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new ErrorHandler(`Interest ${i + 1}: from and to must be dates in order`, 400);
    return { invoice: m.invoice, docNo: String(m.docNo || '').slice(0, 40), from, to, days: Number(m.days) || Math.round((to - from) / DAY) + 1, rate: Number(m.rate) || 0, amount: r2(m.amount) };
  });
}

module.exports = { compute, draft, readMarkers, termsFor };
