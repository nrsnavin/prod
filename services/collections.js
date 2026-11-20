'use strict';
// ══════════════════════════════════════════════════════════════════
//  COLLECTIONS — who to chase, and what to say
//
//  overdue()   customers with past-due invoices, biggest and oldest
//              first, with the numbers the office rings
//  draft()     a short reminder for one customer, written by the model
//              from the invoice list (or by a template when no model is
//              configured); the office edits and sends it
// ══════════════════════════════════════════════════════════════════

const factoryDay = require('../utils/factoryDay');
const { indiaDay } = require('../utils/indiaLabel');
const Customer = require('../models/Customer');
const CollectionNote = require('../models/CollectionNote');
const outstanding = require('./outstanding');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const { r2 } = require('../utils/money');
const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => indiaDay(d, { day: '2-digit', month: 'short', year: 'numeric' });

// ── Did a reminder go? ─────────────────────────────────────────────
// Every send is kept in the customer's history with what it came back
// with: "sent"; a dry run when WhatsApp is not connected (the office
// copies the message and sends it itself); or the provider's refusal.
// A note kept by hand — a call, a promise — has no result at all.
//
// A refused send is not contact. It used to count as one: "contacted in
// the last 7 days" looked for any note, so a reminder that never left
// stood the customer down for a week — off the scheduled run, and
// "give them the week" on the office's list.
const WENT = ['sent', 'dry run', 'dry_run', '', null];
/** Notes that are contact made: everything but a reminder that did not go. */
const REACHED = Object.freeze({ $or: [{ kind: { $ne: 'reminder' } }, { result: { $in: WENT } }] });
const sendFailed = (note) => !!note && note.kind === 'reminder' && !WENT.includes(note.result ?? '');
/** What is kept as the result of a send the provider refused. */
const failedResult = (error) => `error: ${String(error || 'not sent').slice(0, 300)}`;

/**
 * The escalation ladder: a gentle reminder first, a firm one at three
 * weeks past due, a phone call past six — and past ninety days, the
 * owner's call and no new goods until it is settled: another reminder
 * from the office is not what moves a debt that old.
 */
function nextStep(oldestDays) {
  if (oldestDays > 90) return { action: 'escalate', tone: 'firm', label: 'Owner to call; hold new orders' };
  if (oldestDays > 45) return { action: 'call', tone: 'firm', label: 'Call them' };
  if (oldestDays > 21) return { action: 'remind', tone: 'firm', label: 'Firm reminder' };
  return { action: 'remind', tone: 'gentle', label: 'Gentle reminder' };
}

async function overdue({ includeHeld = false } = {}) {
  const rows = await outstanding.receivables();
  const groups = outstanding.byParty(rows).filter((g) => g.overdue > 0);
  const ids = groups.map((g) => g.party);
  // What each has paid ahead (an advance, an unused credit note, an
  // opening advance): a customer whose money on account covers what is
  // overdue owes nothing — the office sets it off; no one chases them.
  const ahead = await require('./credits').byParty('customer');
  const [customers, notes, reached] = await Promise.all([
    Customer.find({ _id: { $in: ids } }).select('name phoneNumber contactName email accountant purchase paymentTerms').lean(),
    CollectionNote.aggregate([
      { $match: { customer: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$customer', newest: { $first: '$$ROOT' }, promises: { $push: { $cond: [{ $eq: ['$kind', 'promise'] }, '$$ROOT', '$$REMOVE'] } } } },
    ]),
    // The last contact that was one: not a reminder the provider refused.
    CollectionNote.aggregate([
      { $match: { customer: { $in: ids }, ...REACHED } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$customer', last: { $first: '$$ROOT' } } },
    ]),
  ]);
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  const lastReached = new Map(reached.map((n) => [String(n._id), n.last]));
  const history = new Map(notes.map((n) => [String(n._id), { ...n, last: lastReached.get(String(n._id)) || null }]));
  const today = factoryDay.calendarDay();
  const out = groups.map((g) => {
    const c = byId.get(String(g.party)) || {};
    const h = history.get(String(g.party));
    const promise = h?.promises?.[0] || null;
    const promiseLive = !!(promise && promise.promiseDate && new Date(promise.promiseDate) >= today);
    // Overdue rupees × days: a small old debt and a big new one rank near each other.
    const priority = g.docs.reduce((s, d) => s + (d.overdueDays > 0 ? d.outstanding * d.overdueDays : 0), 0);
    return {
      party: g.party, partyName: g.partyName, total: g.total, overdue: g.overdue, oldestDays: g.oldestDays, count: g.count,
      docs: g.docs.filter((d) => d.overdueDays > 0),
      contact: { name: c.contactName || '', phone: c.phoneNumber || '', email: c.email || '', accountant: c.accountant?.name ? `${c.accountant.name}${c.accountant.mobile ? ` · ${c.accountant.mobile}` : ''}` : '', accountantPhone: c.accountant?.mobile || '', paymentTerms: c.paymentTerms || '' },
      priority: Math.round(priority),
      lastContact: h?.last ? { kind: h.last.kind, at: h.last.createdAt, byName: h.last.byName, note: h.last.note || '', channel: h.last.channel || '' } : null,
      promise: promise ? { date: promise.promiseDate, amount: promise.promiseAmount || 0, note: promise.note || '', live: promiseLive, broken: !promiseLive } : null,
      // Contacted in the last 7 days: give them the week.
      recentlyContacted: !!(h?.last && Date.now() - new Date(h.last.createdAt).getTime() < 7 * 86_400_000),
      // The latest thing tried was a reminder that did not go: the office
      // should know, and should not take it for a contact.
      failedSend: sendFailed(h?.newest)
        ? { at: h.newest.createdAt, to: h.newest.to || '', result: String(h.newest.result || '').replace(/^error:\s*/i, '') }
        : null,
      held: promiseLive,
      onAccount: r2(ahead.get(String(g.party))?.available || 0),
      covered: (ahead.get(String(g.party))?.available || 0) + 0.005 >= g.overdue,
      next: (ahead.get(String(g.party))?.available || 0) + 0.005 >= g.overdue
        ? { action: 'apply', tone: 'gentle', label: `Set off the ₹${inr(ahead.get(String(g.party)).available)} they paid ahead` }
        : nextStep(g.oldestDays),
    };
  }).sort((a, b) => (a.held - b.held) || (a.covered - b.covered) || (a.recentlyContacted - b.recentlyContacted) || (b.priority - a.priority));
  return includeHeld ? out : out.filter((r) => !r.held);
}

/** Record a contact; returns the note. */
async function log({ customer, kind, channel = '', tone = '', to = '', message = '', note = '', promiseDate = null, promiseAmount = 0, result = '', user = null }) {
  return CollectionNote.create({
    customer, kind, channel, tone, to, message: String(message || '').slice(0, 2000), note: String(note || '').slice(0, 500),
    promiseDate: promiseDate || undefined, promiseAmount: Number(promiseAmount) || 0, result,
    by: user?._id, byName: user?.name || '',
  });
}

async function historyOf(customer, limit = 30) {
  return CollectionNote.find({ customer }).sort({ createdAt: -1 }).limit(limit).lean();
}

/**
 * The reminder when no model writes it, in the tone asked for. It was
 * the gentle one whatever the tone: past three weeks the ladder asks
 * for a firm reminder, and the office was handed "a gentle reminder".
 */
function template(entry, company, tone = 'gentle') {
  const lines = entry.docs.map((d) => `• ${d.docNo} dated ${day(d.date)} — ₹${money(d.outstanding)} (${d.overdueDays} days past due)`);
  const one = entry.docs.length === 1;
  if (tone === 'firm') {
    return [
      `Dear ${entry.contact.name || entry.partyName},`,
      '',
      `Our records show the following invoice${one ? ' from' : 's from'} ${company} ${one ? 'is' : 'are'} still unpaid and past due —`,
      ...lines,
      '',
      `Total overdue: ₹${money(entry.overdue)}. Please arrange payment now, or reply with the date it will be made. If it has already been paid, please send the payment reference so we can update our records.`,
      '',
      'Regards,', company,
    ].join('\n');
  }
  return [
    `Dear ${entry.contact.name || entry.partyName},`,
    '',
    `A gentle reminder from ${company}: the following invoice${one ? ' is' : 's are'} past due —`,
    ...lines,
    '',
    `Total overdue: ₹${money(entry.overdue)}. We would be grateful for payment at the earliest. If it has already been made, please share the reference so we can update our records.`,
    '',
    `Thank you,`, company,
  ].join('\n');
}

/** A reminder for one customer; `tone` is "gentle" (default) or "firm". */
async function draft(entry, { company = 'Balu Elastics', tone = 'gentle' } = {}) {
  const fallback = template(entry, company, tone);
  const claude = anthropic();
  if (!claude) return { message: fallback, byModel: false };
  const startedAt = Date.now();
  try {
    const prompt = [
      `Write a ${tone === 'firm' ? 'firm but courteous' : 'polite, warm'} WhatsApp payment reminder from ${company}, an elastic manufacturer in Tamil Nadu, to their customer.`,
      'Plain text, no markdown, no subject line, under 120 words, Indian business English. Address the contact by name if given.',
      'List every invoice below with its number, date, amount and days past due — copy the figures exactly, never total or round them yourself except the overdue total given.',
      'Ask for the payment reference if already paid. Sign off with the company name.',
      '',
      JSON.stringify({ customer: entry.partyName, contactName: entry.contact.name || null, paymentTerms: entry.contact.paymentTerms, overdueTotal: money(entry.overdue), invoices: entry.docs.map((d) => ({ number: d.docNo, date: day(d.date), amount: money(d.outstanding), daysPastDue: d.overdueDays })) }),
    ].join('\n');
    const resp = await claude.messages.create({ model: TEXT_MODEL, max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    await ledger.record({ surface: 'collection-reminder', model: TEXT_MODEL, promptVersion: promptVersion('collection-reminder'), refType: 'Customer', refId: entry.party, proposed: { message: text }, latencyMs: Date.now() - startedAt, usage: resp.usage });
    return { message: text || fallback, byModel: !!text };
  } catch (err) {
    await ledger.record({ surface: 'collection-reminder', model: TEXT_MODEL, promptVersion: promptVersion('collection-reminder'), refType: 'Customer', refId: entry.party, latencyMs: Date.now() - startedAt, error: err.message });
    return { message: fallback, byModel: false };
  }
}

/**
 * "9677707535" → "+919677707535"; already-international numbers kept.
 * "09677707535" is the same phone written with its trunk 0 — how a
 * number is often kept in India. It used to become "+09677707535": a
 * number that does not exist to send to, and one the customer's own
 * reply (from +91 96777 07535) never matched.
 */
function e164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

/**
 * Where a payment reminder goes: the accountant's mobile when the
 * customer gave one, else the customer's own — as a receipt, a statement
 * and a balance confirmation do. The reminder sent on a schedule used
 * the customer's own first, so the timer and the office reminded the
 * same customer at two different numbers.
 *
 * The first that IS a number: an accountant's mobile kept as "NA" used
 * to stand in front of a perfectly good one. '' when neither is.
 */
const reminderPhone = (contact) => e164(contact?.accountantPhone) || e164(contact?.phone);

/**
 * Whether a number (in any form) is a customer's or a supplier's on file:
 * the party's own number, or their accountant's. Compared as E.164, so
 * "96777 07535" and "+91 9677707535" are the same number.
 */
async function knownPhone(phone) {
  const want = e164(phone);
  if (!want) return false;
  const Supplier = require('../models/Supplier');
  const [customers, suppliers] = await Promise.all([
    Customer.find({}).select('phoneNumber accountant.mobile').lean(),
    Supplier.find({}).select('phoneNumber').lean(),
  ]);
  const numbers = [
    ...customers.flatMap((c) => [c.phoneNumber, c.accountant?.mobile]),
    ...suppliers.map((s) => s.phoneNumber),
  ].filter(Boolean).map(e164);
  return numbers.includes(want);
}

module.exports = { overdue, draft, template, e164, reminderPhone, log, historyOf, nextStep, knownPhone, REACHED, sendFailed, failedResult };
