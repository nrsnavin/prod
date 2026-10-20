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
  'This is a purchase order or an enquiry sent to us by a customer. It is one of:',
  '- a document: a PDF, a letterhead, a typed or handwritten page, a photo of one;',
  '- a WhatsApp chat screenshot: a contact name (or number) in the header at the top,',
  '  message bubbles, and the message input box at the very bottom (between the "+"',
  '  and the send / sticker buttons).',
  'Read it and return what it says.',
  '',
  'First decide sourceType: "whatsapp_chat" for a chat screenshot, otherwise "document".',
  '',
  'For a WhatsApp chat screenshot — the phone number matters most here:',
  '- messageBoxText: copy EXACTLY whatever is typed in the message input box at the',
  '  bottom, character for character, even when it is only a phone number such as',
  '  "+91 97874 98412". This is where we type the customer\'s number before taking the',
  '  screenshot, so never skip it. null only if the box is empty or shows only the grey',
  '  placeholder ("Message").',
  '- chatHeaderTitle: the contact name or number exactly as shown in the header.',
  '- customerName: the chat header title (the customer is the other party, not us),',
  '  unless a message gives their company name more fully.',
  '- customerPhone: the number typed in the message box; failing that, a number in the',
  '  header; failing that, a number the customer wrote in a message.',
  'For a document, messageBoxText and chatHeaderTitle are null, and customerPhone is',
  'the customer\'s phone or mobile number from their letterhead, signature or address.',
  'Copy phone numbers as written. Never use a number that is ours.',
  '',
  'Rules for the order itself, and these matter more than completeness:',
  '- NEVER invent a line, a quantity or a rate. If a cell is blank or you cannot read',
  '  it, return null. A plausible-looking number in a price column is far worse than an',
  '  empty one: an empty cell gets filled in, a wrong one gets confirmed and shipped.',
  '- Copy the product description VERBATIM as written, including the width and any',
  '  colour or finish. Do not tidy it, expand abbreviations, or convert units.',
  '- Quantities and rates are numbers only — strip currency symbols, commas and units.',
  '- Lower a line\'s confidence when the text is unclear. Be honest; a low number is',
  '  useful and a falsely high one is not.',
  '- Ignore our own letterhead if the document quotes it back. We want what THEY ordered.',
  '- Dates as YYYY-MM-DD; confidences from 0 to 1.',
].join('\n');

const str = { type: 'string' };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

/**
 * The reply's shape, enforced by structured outputs: every field is
 * always present, so a missing key can never be mistaken for "not on
 * the document", and the reply always parses.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceType', 'messageBoxText', 'chatHeaderTitle', 'customerName', 'customerPhone',
    'poNumber', 'poDate', 'deliveryDate', 'currency', 'lines', 'notes', 'confidence',
  ],
  properties: {
    sourceType:      { type: 'string', enum: ['whatsapp_chat', 'document'] },
    messageBoxText:  nullable(str),
    chatHeaderTitle: nullable(str),
    customerName:    nullable(str),
    customerPhone:   nullable(str),
    poNumber:        nullable(str),
    poDate:          nullable(str),
    deliveryDate:    nullable(str),
    currency:        nullable(str),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantity', 'unit', 'rate', 'confidence'],
        properties: {
          description: str,
          quantity:    nullable({ type: 'number' }),
          unit:        nullable(str),
          rate:        nullable({ type: 'number' }),
          confidence:  { type: 'number' },
        },
      },
    },
    notes:      str,
    confidence: { type: 'number' },
  },
};

/** A second, narrow look at a chat whose number the first reading missed. */
const BOX_PROMPT = [
  'This is a WhatsApp chat screenshot. Look only at two places:',
  '- the message input box at the very bottom (between the "+" and the send button):',
  '  copy EXACTLY what is typed in it, character for character; null if it is empty or',
  '  shows only the grey "Message" placeholder;',
  '- the header at the top: copy the contact name or number exactly as shown.',
].join('\n');

const BOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['messageBoxText', 'chatHeaderTitle'],
  properties: { messageBoxText: nullable(str), chatHeaderTitle: nullable(str) },
};

const textOf = (message) => (message.content || [])
  .filter((b) => b.type === 'text').map((b) => b.text).join('');

/** Token counts of two calls, added. */
function addUsage(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = (Number(out[k]) || 0) + v;
  }
  return out;
}

/**
 * Extract a customer PO / enquiry from an uploaded document or screenshot.
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
    max_tokens: 8192,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: [source, { type: 'text', text: PROMPT }] }],
  });

  const parsed = message.stop_reason === 'refusal' ? null : parseJsonReply(textOf(message));
  if (!parsed) return { available: true, ok: false, model: VISION_MODEL, usage: message.usage };

  let usage = message.usage;
  let draft = normaliseDraft(parsed);

  // A chat screenshot is expected to carry the number in its message box.
  // When the first reading came back without one, look again at just the
  // box and the header — a narrow question gets the small text right far
  // more often than a whole-page reading does.
  if (draft.sourceType === 'whatsapp_chat' && !draft.customerMobile && !isPdf) {
    try {
      const again = await claude.messages.create({
        model: VISION_MODEL,
        max_tokens: 1024,
        output_config: { format: { type: 'json_schema', schema: BOX_SCHEMA } },
        messages: [{ role: 'user', content: [source, { type: 'text', text: BOX_PROMPT }] }],
      });
      usage = addUsage(usage, again.usage);
      const box = again.stop_reason === 'refusal' ? null : parseJsonReply(textOf(again));
      if (box) {
        draft = normaliseDraft({
          ...parsed,
          messageBoxText: box.messageBoxText ?? parsed.messageBoxText,
          chatHeaderTitle: box.chatHeaderTitle ?? parsed.chatHeaderTitle,
        });
      }
    } catch {
      // The order reading stands without the number; a person adds it.
    }
  }

  return { available: true, ok: true, model: VISION_MODEL, usage, draft };
}

/**
 * A phone number as written, or null when it is not one: 10 to 13 digits
 * once spaces, dashes, brackets and a leading + are set aside.
 */
function phone(v) {
  if (v == null) return null;
  const text = String(v).trim();
  const digits = text.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13 ? text : null;
}

/**
 * The first phone number inside some text — "+91 97874 98412", or
 * "call 97874-98412 pls" — as written; null when it holds none.
 */
function phoneIn(text) {
  if (!text) return null;
  for (const m of String(text).matchAll(/\+?\d[\d\s().-]{8,18}\d/g)) {
    const p = phone(m[0]);
    if (p) return p;
  }
  return null;
}

/** The last ten digits — how +91 98765 43210, 098765 43210 and 9876543210 compare equal. */
function phoneKey(v) {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * The customer's number, and where it was found. A chat's message box
 * comes first — it is where the number is typed before the screenshot —
 * then a number shown in the chat header, then whatever the reading
 * named (a letterhead, a signature, a number written in a message).
 */
function resolvePhone(raw) {
  const fromBox = phoneIn(raw.messageBoxText);
  if (fromBox) return { number: fromBox, source: 'message_box' };
  const fromHeader = phoneIn(raw.chatHeaderTitle);
  if (fromHeader) return { number: fromHeader, source: 'chat_header' };
  const named = phone(raw.customerPhone) || phoneIn(raw.customerPhone);
  if (named) return { number: named, source: raw.sourceType === 'whatsapp_chat' ? 'chat_message' : 'document' };
  return { number: null, source: null };
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
  const text = (v) => (v == null ? null : String(v).trim() || null);

  const { number, source } = resolvePhone(raw);
  const lines = Array.isArray(raw.lines) ? raw.lines : [];
  return {
    sourceType:     raw.sourceType === 'whatsapp_chat' ? 'whatsapp_chat' : 'document',
    customerName:   text(raw.customerName),
    // One number: the customer reached us on WhatsApp from it, so it is
    // their mobile and their WhatsApp number both.
    customerMobile:   number,
    customerWhatsapp: number,
    phoneSource:      source,
    messageBoxText:   text(raw.messageBoxText),
    chatHeaderTitle:  text(raw.chatHeaderTitle),
    poNumber:     text(raw.poNumber),
    poDate:       date(raw.poDate),
    deliveryDate: date(raw.deliveryDate),
    currency:     text(raw.currency),
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

module.exports = {
  extractPurchaseOrder, parseJsonReply, normaliseDraft, phoneIn, phoneKey,
  OUTPUT_SCHEMA, IMAGE_TYPES, PDF_TYPE,
};
