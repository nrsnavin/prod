'use strict';
// ═════════════════════════════════════════════════════════════════
//  A CUSTOMER'S PAYMENT ADVICE, READ (Claude vision / text)
//
//  When a customer pays, their accounts team often sends a remittance
//  advice: "₹1,02,340 paid by NEFT, UTR …, against INV 701 (₹52,500 less
//  TDS ₹500) and INV 702 (…), less 2% discount". A PDF, a photo of it, or
//  the text of the mail pasted in. This reads it into the payer, the
//  money, the reference and, per invoice, what it settles and what was
//  taken off. It only READS: which invoices on file those are is worked
//  out by services/adviceMatch.js against the books, never by the model.
//
//  readAdvice({ pages?, text? }) -> {
//    problem: null | 'not_an_advice' | 'unreadable',
//    payerName, payerGstin, amount, date: 'YYYY-MM-DD'|null, reference,
//    lines: [{ invoiceNo, invoiceDate, invoiceAmount, paid, tds, discount, other }],
//    tdsTotal, discountTotal, confidence, model, usage, latencyMs
//  }
// ═════════════════════════════════════════════════════════════════
const { anthropic, VISION_MODEL, TEXT_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_PAGES = 4;

const PROMPT = [
  'This is a payment advice (remittance advice) a customer sent to an elastic weaving factory in India',
  'when they paid it: which of the factory\'s invoices the payment settles, and what they deducted.',
  '',
  'Return ONLY a JSON object, no prose, no markdown fences:',
  '{"problem":null,"payerName":"Sunrise Garments","payerGstin":"33AAEPS1001F1Z2","amount":102340,',
  ' "date":"2026-10-28","reference":"UTR HDFC000123456",',
  ' "lines":[{"invoiceNo":"INV/2026-27/0701","invoiceDate":"2026-09-20","invoiceAmount":52500,"paid":51500,"tds":500,"discount":500,"other":0}],',
  ' "tdsTotal":500,"discountTotal":500,"confidence":0.85}',
  '',
  'Rules:',
  '- amount: the money actually paid (net, after every deduction). date: when it was paid, YYYY-MM-DD.',
  '- reference: the UTR, cheque number or transaction id as printed, else "".',
  '- lines: one per invoice of OURS that the payment settles. invoiceNo exactly as printed (it may be',
  '  shortened, like "701" or "INV-701"). invoiceAmount the invoice value if shown; paid the money',
  '  against it; tds the TDS deducted on it; discount any discount or rebate; other any other deduction',
  '  (debit note, short supply, bank charges). Use null for what is not shown, never guess.',
  '- Their own purchase-order or GRN numbers are not invoice numbers: put them nowhere.',
  '- tdsTotal and discountTotal: the totals as printed, else the sum of the lines, else null.',
  '- problem: "not_an_advice" when this is not a payment advice; "unreadable" when it cannot be read.',
  '- confidence: 0 to 1 for the whole reading.',
].join('\n');

function parseJsonReply(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch (_) { return null; }
}

const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const asDate = (v) => {
  const m = str(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const clamp01 = (v, fallback = 0.5) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback; };

function normalise(raw, meta) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const lines = (Array.isArray(r.lines) ? r.lines : []).map((l) => {
    if (!l || typeof l !== 'object') return null;
    const invoiceNo = str(l.invoiceNo).slice(0, 40);
    if (!invoiceNo) return null;
    return {
      invoiceNo,
      invoiceDate: asDate(l.invoiceDate),
      invoiceAmount: num(l.invoiceAmount),
      paid: num(l.paid),
      tds: num(l.tds),
      discount: num(l.discount),
      other: num(l.other),
    };
  }).filter(Boolean).slice(0, 100);
  const gstin = str(r.payerGstin).toUpperCase();
  const problem = r.problem === 'not_an_advice' || r.problem === 'unreadable' ? r.problem : (lines.length || num(r.amount) ? null : 'unreadable');
  return {
    problem,
    payerName: str(r.payerName).slice(0, 120),
    payerGstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) ? gstin : '',
    amount: num(r.amount),
    date: asDate(r.date),
    reference: str(r.reference).slice(0, 60),
    lines,
    tdsTotal: num(r.tdsTotal),
    discountTotal: num(r.discountTotal),
    confidence: clamp01(r.confidence),
    ...meta,
  };
}

function contentFor(page) {
  const data = page.buffer.toString('base64');
  return page.mimetype === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: page.mimetype, data } };
}

/**
 * Read one advice from its file(s), or from its text (a mail pasted in).
 * @param {{ pages?: Array<{buffer: Buffer, mimetype: string}>, text?: string }} p
 */
async function readAdvice({ pages = [], text = '' } = {}) {
  const list = (pages || []).filter((p) => p && p.buffer && p.buffer.length);
  const said = String(text || '').trim().slice(0, 20_000);
  if (!list.length && !said) { const e = new Error('Attach the advice, or paste its text.'); e.code = 'NO_PAGES'; throw e; }
  const bad = list.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) { const e = new Error(`Cannot read a ${bad.mimetype} file. Send a PDF or a photo.`); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  if (list.length > MAX_PAGES) { const e = new Error(`At most ${MAX_PAGES} pages.`); e.code = 'TOO_MANY_PAGES'; throw e; }
  const claude = anthropic();
  if (!claude) { const e = new Error('ANTHROPIC_API_KEY not set on the server.'); e.code = 'ANTHROPIC_KEY_MISSING'; throw e; }

  const model = list.length ? VISION_MODEL : TEXT_MODEL;
  const startedAt = Date.now();
  const message = await claude.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [...list.map(contentFor), { type: 'text', text: `${said ? `The advice:\n"""\n${said}\n"""\n\n` : ''}${PROMPT}` }] }],
  });
  const reply = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalise(parseJsonReply(reply), { model, usage: message.usage, latencyMs: Date.now() - startedAt });
}

module.exports = { readAdvice, normalise, PROMPT, SUPPORTED, MAX_PAGES };
