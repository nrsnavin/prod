'use strict';
// ═════════════════════════════════════════════════════════════════
//  Supplier bill / expense receipt OCR  (Claude vision)
//
//  Reads a PHOTO or PDF of somebody else's document — a yarn supplier's
//  tax invoice, a transporter's bill, a shop receipt — into the fields
//  a draft bill needs: who, their number and date, the lines with HSN,
//  quantity, rate and GST, the totals. No known layout, so the ledger
//  (services/aiLedger.js, surface 'bill-ocr') is how its accuracy will
//  be known.
//
//  This only READS. Which supplier on file it is, and which purchase
//  order and receipts it bills, is worked out by api/accounts.js
//  against the database, never by the model.
//
//  readBill(pages) -> {
//    kind: 'bill' | 'receipt' | null, problem: null | 'not_a_bill' | 'unreadable',
//    supplierName, supplierGstin, billNo, billDate: 'YYYY-MM-DD'|null, dueDate,
//    lines: [{ description, hsn, quantity, unit, rate, gstPercent, amount, confidence }],
//    totals: { taxable, cgst, sgst, igst, grand } (as printed, or null),
//    confidence, model, usage, latencyMs
//  }
// ═════════════════════════════════════════════════════════════════
const { anthropic, VISION_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_PAGES = 4;

const PROMPT = [
  'This is a bill received by an elastic (narrow-fabric) weaving factory in India: a supplier\'s',
  'GST tax invoice for yarn or spares, a job-work / dyeing bill, a transporter\'s bill, or a',
  'shop receipt for an expense.',
  '',
  'Read it and return ONLY a JSON object, no prose, no markdown fences:',
  '{"kind":"bill","problem":null,',
  ' "supplierName":"Sri Yarn Traders","supplierGstin":"33AAAPS1234F1Z5","billNo":"SY/118",',
  ' "billDate":"2026-07-04","dueDate":null,',
  ' "lines":[{"description":"Nylon 70D","hsn":"5402","quantity":60,"unit":"kg","rate":310,"gstPercent":5,"amount":18600,"confidence":0.9}],',
  ' "totals":{"taxable":18600,"cgst":465,"sgst":465,"igst":0,"grand":19530},',
  ' "confidence":0.85}',
  '',
  'Rules:',
  '- kind: "bill" for a GST invoice with line items; "receipt" for a simple expense receipt.',
  '- supplierName: the SELLER (the party issuing the bill), not the buyer. The buyer is the factory.',
  '- supplierGstin: the seller\'s 15-character GSTIN exactly as printed, else null.',
  '- billNo: the seller\'s own invoice / bill number as printed. billDate as YYYY-MM-DD (dates are',
  '  written day first: 04/07/26 is 4 July 2026). Null when not visible; never guess.',
  '- lines: one per printed line item. Copy quantity, rate and amount as printed; never compute',
  '  them. gstPercent: the rate printed for that line (CGST + SGST added, or IGST). hsn: the',
  '  HSN/SAC printed on the line or in a summary, else null. unit: as printed (kg, m, pcs, nos).',
  '- A receipt with just a total and no lines: one line with description = what was bought,',
  '  quantity 1, rate = the amount before tax (or the total if no tax is shown), gstPercent 0',
  '  or the printed rate.',
  '- totals: as printed; null for any figure not printed.',
  '- confidence: 0 to 1 for the whole read; per line too. Lower it for faded or handwritten figures.',
  '- If this is not a bill or receipt at all, return {"kind":null,"problem":"not_a_bill","lines":[]}.',
  '- If it is one but cannot be read, return {"kind":null,"problem":"unreadable","lines":[]}.',
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
    const description = str(l.description);
    if (!description) return null;
    const hsn = str(l.hsn).replace(/\D/g, '').slice(0, 8);
    return {
      description: description.slice(0, 200),
      hsn: /^\d{4,8}$/.test(hsn) ? hsn : '',
      quantity: num(l.quantity) ?? 1,
      unit: str(l.unit).slice(0, 10),
      rate: num(l.rate),
      gstPercent: num(l.gstPercent),
      amount: num(l.amount),
      confidence: clamp01(l.confidence),
    };
  }).filter(Boolean);
  const t = r.totals && typeof r.totals === 'object' ? r.totals : {};
  const gstin = str(r.supplierGstin).toUpperCase();
  return {
    kind: r.kind === 'bill' || r.kind === 'receipt' ? r.kind : null,
    problem: r.problem === 'not_a_bill' || r.problem === 'unreadable' ? r.problem : (lines.length ? null : 'unreadable'),
    supplierName: str(r.supplierName).slice(0, 120),
    supplierGstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin) ? gstin : '',
    billNo: str(r.billNo).slice(0, 40),
    billDate: asDate(r.billDate),
    dueDate: asDate(r.dueDate),
    lines,
    totals: { taxable: num(t.taxable), cgst: num(t.cgst), sgst: num(t.sgst), igst: num(t.igst), grand: num(t.grand) },
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
 * Read one bill from its photo(s) or PDF.
 * @param {Array<{buffer: Buffer, mimetype: string}>} pages
 */
async function readBill(pages) {
  const list = (pages || []).filter((p) => p && p.buffer && p.buffer.length);
  if (!list.length) { const e = new Error('No photo to read.'); e.code = 'NO_PAGES'; throw e; }
  const bad = list.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) { const e = new Error(`Cannot read a ${bad.mimetype} file. Send a photo (JPEG or PNG) or a PDF.`); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  if (list.length > MAX_PAGES) { const e = new Error(`At most ${MAX_PAGES} pages per bill.`); e.code = 'TOO_MANY_PAGES'; throw e; }
  const claude = anthropic();
  if (!claude) { const e = new Error('ANTHROPIC_API_KEY not set on the server.'); e.code = 'ANTHROPIC_KEY_MISSING'; throw e; }

  const startedAt = Date.now();
  const message = await claude.messages.create({
    model: VISION_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [...list.map(contentFor), { type: 'text', text: PROMPT }] }],
  });
  const reply = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalise(parseJsonReply(reply), { model: VISION_MODEL, usage: message.usage, latencyMs: Date.now() - startedAt });
}

module.exports = { readBill, normalise, PROMPT, SUPPORTED, MAX_PAGES };
