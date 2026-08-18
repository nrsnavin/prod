'use strict';
// ══════════════════════════════════════════════════════════════════
//  READING A CUSTOMER'S PURCHASE ORDER
//
//  The shift-sheet OCR reads OUR OWN printed form — a known layout,
//  known columns, known codes. This reads somebody else's document: a
//  photo of a letterhead, a forwarded PDF, a WhatsApp image of a page
//  on a desk. There is no layout to rely on and no code to key against.
//
//  So this extracts, and it does not decide. It returns what it read
//  along with per-field confidence, and services/inboundPoIntake.js
//  matches that against the masters. Nothing is created; the draft goes
//  to a person who confirms it.
//
//  ── What it is told never to do ──────────────────────────────────
//  The prompt forbids inventing a line, a quantity or a rate. A missing
//  rate has to come back as null, because a plausible number in a price
//  column is far worse than an empty one: an empty cell gets filled in,
//  and a wrong one gets confirmed.
// ══════════════════════════════════════════════════════════════════

const { anthropic, VISION_MODEL } = require('./anthropicClient');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const PDF_TYPE = 'application/pdf';

/** Pull the first JSON object out of a model reply (handles fences). */
function parseJsonReply(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const PROMPT = [
  'This is a purchase order sent to us by a customer. Read it and return what it says.',
  '',
  'Return ONLY a JSON object, no prose and no markdown fences:',
  '{',
  '  "customerName": string or null,',
  '  "poNumber": string or null,',
  '  "poDate": "YYYY-MM-DD" or null,',
  '  "deliveryDate": "YYYY-MM-DD" or null,',
  '  "currency": string or null,',
  '  "lines": [',
  '    { "description": string, "quantity": number or null, "unit": string or null,',
  '      "rate": number or null, "confidence": 0 to 1 }',
  '  ],',
  '  "notes": string,',
  '  "confidence": 0 to 1',
  '}',
  '',
  'Rules, and these matter more than completeness:',
  '- NEVER invent a line, a quantity or a rate. If a cell is blank or you cannot read',
  '  it, return null. A plausible-looking number in a price column is far worse than an',
  '  empty one: an empty cell gets filled in, a wrong one gets confirmed and shipped.',
  '- Copy the product description VERBATIM as written, including the width and any',
  '  colour or finish. Do not tidy it, expand abbreviations, or convert units.',
  '- Quantities and rates are numbers only — strip currency symbols, commas and units.',
  '- Lower a line\'s confidence when the text is unclear. Be honest; a low number is',
  '  useful and a falsely high one is not.',
  '- Ignore our own letterhead if the document quotes it back. We want what THEY ordered.',
].join('\n');

/**
 * Extract a customer PO from an uploaded document.
 *
 * @returns {{available: boolean, ok?: boolean, draft?: object, model?: string}}
 */
async function extractPurchaseOrder(buffer, mimetype) {
  const claude = anthropic();
  if (!claude) return { available: false };

  const isPdf = mimetype === PDF_TYPE;
  if (!isPdf && !IMAGE_TYPES.has(mimetype)) {
    const err = new Error(`Unsupported file type '${mimetype}'. Use a PDF, JPEG, PNG, WEBP or GIF.`);
    err.code = 'UNSUPPORTED_TYPE';
    throw err;
  }

  const source = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: PDF_TYPE, data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } };

  const message = await claude.messages.create({
    model: VISION_MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: [source, { type: 'text', text: PROMPT }] }],
  });

  const text = (message.content || [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonReply(text);
  if (!parsed) return { available: true, ok: false, model: VISION_MODEL, usage: message.usage };

  return {
    available: true,
    ok: true,
    model: VISION_MODEL,
    usage: message.usage,
    draft: normaliseDraft(parsed),
  };
}

/** Guard-rail whatever came back into a predictable shape. */
function normaliseDraft(raw) {
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const conf = (v) => {
    const n = Number(v);
    // A line with no stated confidence is treated as middling rather
    // than certain. Absent is not the same as sure.
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
  };

  const lines = Array.isArray(raw.lines) ? raw.lines : [];
  return {
    customerName: raw.customerName ? String(raw.customerName).trim() : null,
    poNumber:     raw.poNumber ? String(raw.poNumber).trim() : null,
    poDate:       date(raw.poDate),
    deliveryDate: date(raw.deliveryDate),
    currency:     raw.currency ? String(raw.currency).trim() : null,
    notes:        String(raw.notes || '').trim(),
    confidence:   conf(raw.confidence),
    lines: lines
      .map((l) => ({
        description: String(l?.description || '').trim(),
        quantity: num(l?.quantity),
        unit: l?.unit ? String(l.unit).trim() : null,
        rate: num(l?.rate),
        confidence: conf(l?.confidence),
      }))
      // A line with no description is not a line. Dropped rather than
      // carried as an empty row somebody has to notice and delete.
      .filter((l) => l.description),
  };
}

module.exports = { extractPurchaseOrder, parseJsonReply, normaliseDraft, IMAGE_TYPES, PDF_TYPE };
