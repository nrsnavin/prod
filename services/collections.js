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

const Customer = require('../models/Customer');
const outstanding = require('./outstanding');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

const money = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

async function overdue() {
  const rows = await outstanding.receivables();
  const groups = outstanding.byParty(rows).filter((g) => g.overdue > 0);
  const ids = groups.map((g) => g.party);
  const customers = await Customer.find({ _id: { $in: ids } }).select('name phoneNumber contactName email accountant purchase paymentTerms').lean();
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  return groups.map((g) => {
    const c = byId.get(String(g.party)) || {};
    // Overdue rupees × days: a small old debt and a big new one rank near each other.
    const priority = g.docs.reduce((s, d) => s + (d.overdueDays > 0 ? d.outstanding * d.overdueDays : 0), 0);
    return {
      party: g.party, partyName: g.partyName, total: g.total, overdue: g.overdue, oldestDays: g.oldestDays, count: g.count,
      docs: g.docs.filter((d) => d.overdueDays > 0),
      contact: { name: c.contactName || '', phone: c.phoneNumber || '', email: c.email || '', accountant: c.accountant?.name ? `${c.accountant.name}${c.accountant.mobile ? ` · ${c.accountant.mobile}` : ''}` : '', accountantPhone: c.accountant?.mobile || '', paymentTerms: c.paymentTerms || '' },
      priority: Math.round(priority),
    };
  }).sort((a, b) => b.priority - a.priority);
}

function template(entry, company) {
  const lines = entry.docs.map((d) => `• ${d.docNo} dated ${day(d.date)} — ₹${money(d.outstanding)} (${d.overdueDays} days past due)`);
  return [
    `Dear ${entry.contact.name || entry.partyName},`,
    '',
    `A gentle reminder from ${company}: the following invoice${entry.docs.length === 1 ? ' is' : 's are'} past due —`,
    ...lines,
    '',
    `Total overdue: ₹${money(entry.overdue)}. We would be grateful for payment at the earliest. If it has already been made, please share the reference so we can update our records.`,
    '',
    `Thank you,`, company,
  ].join('\n');
}

/** A reminder for one customer; `tone` is "gentle" (default) or "firm". */
async function draft(entry, { company = 'Balu Elastics', tone = 'gentle' } = {}) {
  const fallback = template(entry, company);
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

/** "9677707535" → "+919677707535"; already-international numbers kept. */
function e164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

module.exports = { overdue, draft, template, e164 };
