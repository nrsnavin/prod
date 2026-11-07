'use strict';
// ══════════════════════════════════════════════════════════════════
//  A GOVERNMENT NOTICE, READ: what it is, what period, how much, and
//  above all by when it must be answered.
//
//  readNotice(pages) → { problem, authority, form, reference, subject,
//    periodText, financialYear, amount, issuedOn, replyBy, hearingOn,
//    summary, asks[], replyByAssumed, documents[], model, usage, latencyMs }
//
//  The deadline is copied as printed. Only where the law fixes it and the
//  notice does not print one (ASMT-10, DRC-01: 30 days) is a date worked
//  out, and it is marked assumed. What the reply needs is a list kept in
//  code per form, plus whatever the notice itself asks for.
// ══════════════════════════════════════════════════════════════════

const { readJson, num, str } = require('./docRead');

const AUTHORITIES = ['gst', 'income_tax', 'tds', 'pf', 'esi', 'professional_tax', 'other'];

const PROMPT = [
  'This is a notice or letter from an Indian government authority to a business: GST (e.g. ASMT-10, DRC-01, DRC-01A,',
  'DRC-01B, DRC-01C, REG-03, REG-17, ADT-01), income tax (e.g. 143(1), 143(2), 148, 142(1), 245, 26QB default), TDS (TRACES',
  'default), EPFO (PF) or ESIC (ESI), or professional tax. Return ONLY JSON:',
  '{"problem":null,"authority":"gst","form":"ASMT-10","reference":"ZD3311240012345","subject":"Scrutiny of returns — ITC mismatch",',
  ' "periodText":"Apr 2024 – Mar 2025","financialYear":"2024-25","amount":184500,"issuedOn":"2026-10-28","replyBy":"2026-11-27",',
  ' "hearingOn":"","summary":"ITC claimed in GSTR-3B is ₹1,84,500 more than GSTR-2B. Explain or pay with interest.",',
  ' "asks":["Reconciliation of ITC in GSTR-3B with GSTR-2B","Copies of supplier invoices"]}',
  '- authority: gst, income_tax, tds, pf, esi, professional_tax or other. form: the form/section as printed. reference: the DIN,',
  '  notice number or reference number.',
  '- amount: the tax/demand/difference it names in rupees (the total if several), else null. Never add up yourself.',
  '- issuedOn, replyBy, hearingOn: YYYY-MM-DD as printed (day first: 05/11/26 is 5 November 2026). replyBy is the last date to',
  '  reply, pay or appear; "" when the notice gives none — never compute one.',
  '- summary: two sentences in plain English: what they say is wrong and what they want. asks: the documents or actions it asks for.',
  '- Not a government notice: {"problem":"not_a_notice"}. Unreadable: {"problem":"unreadable"}.',
].join('\n');

/** What a reply to each kind of notice needs, from what the app keeps. */
const REPLY_NEEDS = {
  'ASMT-10': ['GSTR-1 vs GSTR-3B for the period (Accounts → Statutory → GST summary)', 'GSTR-2B vs ITC in books (Accounts → Statutory → GSTR-2B)', 'Reply in ASMT-11 on the GST portal'],
  'DRC-01': ['Working of the demand, line by line', 'Proof of tax already paid (challans, GSTR-3B)', 'Reply in DRC-06 on the GST portal'],
  'DRC-01A': ['Working of the amount', 'Pay with DRC-03, or reply in Part B of DRC-01A'],
  'DRC-01B': ['GSTR-1 vs GSTR-3B liability for the period', 'Pay the difference with DRC-03, or explain in Part B'],
  'DRC-01C': ['GSTR-2B vs ITC claimed in GSTR-3B', 'Explain in Part B, or reverse with DRC-03'],
  'REG-03': ['The clarification or documents it asks for, within 7 working days (REG-04)'],
  'REG-17': ['Reply in REG-18 explaining why registration should not be cancelled; file pending returns'],
  'ADT-01': ['Books of account, returns, e-way bills and invoices for the audit period'],
  '143(1)': ['Computation of income and the return as filed', 'Respond on the e-filing portal (agree / disagree)'],
  '143(2)': ['Books of account and audit report', 'Reply on the e-proceedings portal'],
  '148': ['Return in response, then reasons for reopening'],
};
/** Days to reply fixed by law, where the notice does not print a date. */
const LAW_DAYS = { 'ASMT-10': 30, 'DRC-01': 30 };

const asDate = (v) => { const d = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : ''; };
const formKey = (form) => {
  const f = String(form || '').toUpperCase().replace(/\s+/g, '').replace(/^FORM(GST)?/, '').replace(/^GST/, '');
  return Object.keys(REPLY_NEEDS).find((k) => f === k.replace(/\s+/g, '') || f.startsWith(`${k}`)) || '';
};
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function normaliseNotice(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'not_a_notice' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  const form = str(raw.form, 40);
  const key = formKey(form);
  const issuedOn = asDate(raw.issuedOn);
  let replyBy = asDate(raw.replyBy);
  let replyByAssumed = false;
  if (!replyBy && issuedOn && LAW_DAYS[key]) { replyBy = addDays(issuedOn, LAW_DAYS[key]); replyByAssumed = true; }
  const asks = (Array.isArray(raw.asks) ? raw.asks : []).map((a) => str(a, 200)).filter(Boolean).slice(0, 10);
  const amount = num(raw.amount);
  const fy = str(raw.financialYear, 7);
  return {
    problem: null,
    authority: AUTHORITIES.includes(raw.authority) ? raw.authority : 'other',
    form, reference: str(raw.reference, 60), subject: str(raw.subject, 200),
    periodText: str(raw.periodText, 60), financialYear: /^\d{4}-\d{2}$/.test(fy) ? fy : '',
    amount: amount != null && amount >= 0 ? amount : null,
    issuedOn, replyBy, replyByAssumed, hearingOn: asDate(raw.hearingOn),
    summary: str(raw.summary, 600), asks,
    documents: [...new Set([...(REPLY_NEEDS[key] || []), ...asks])],
    ...meta,
  };
}

async function readNotice(pages) {
  const r = await readJson({ pages, prompt: PROMPT, maxTokens: 900, maxPages: 4 });
  return normaliseNotice(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

module.exports = { readNotice, normaliseNotice, AUTHORITIES, REPLY_NEEDS, LAW_DAYS, PROMPT };
