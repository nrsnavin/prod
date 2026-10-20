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
  'This is a purchase order or an enquiry from a customer. It is one of:',
  '- "whatsapp_chat": a WhatsApp chat screenshot — a contact name (or number) in the',
  '  header at the top, message bubbles, and the message input box at the very bottom',
  '  (between the "+" and the send / sticker buttons);',
  '- "email": a screenshot of an email — From / To / Subject, the body, a signature;',
  '- "visiting_card": a photo or scan of a business card (front or back);',
  '- "document": anything else — a PDF, a letterhead, a typed or handwritten page.',
  'Decide sourceType first, then read it and return what it says.',
  '',
  'Who the customer is, and how to reach them:',
  '- customerName: their company (or their own name when no company shows).',
  '  whatsapp_chat: the header title, unless a message names the company more fully.',
  '  email: the sender\'s company from the signature or the address domain; else the sender.',
  '  visiting_card: the company printed on the card.',
  '- contactPerson: the person — the email sender, the name on the card, or null.',
  '- customerEmail: their email address — the email\'s From address, or the one on the card',
  '  or letterhead. Never our own address (the To address of an email sent to us).',
  '- phoneNumbers: EVERY phone number of theirs that shows, each copied as written, with',
  '  its label as printed ("Mob", "Cell", "WhatsApp", "Tel", "Off", "Fax") or null. A',
  '  WhatsApp icon beside a number counts as the label "WhatsApp".',
  '- customerPhone: their mobile / WhatsApp number — the one they can be messaged on.',
  '  Prefer a number labelled WhatsApp, then one labelled mobile, then a mobile-looking',
  '  number over a landline. In a WhatsApp chat it is the number typed in the message box.',
  'Never give a number or address that is ours.',
  '',
  'For a WhatsApp chat screenshot — the phone number matters most here:',
  '- messageBoxText: copy EXACTLY whatever is typed in the message input box at the',
  '  bottom, character for character, even when it is only a phone number such as',
  '  "+91 97874 98412". This is where we type the customer\'s number before taking the',
  '  screenshot, so never skip it. null only if the box is empty or shows only the grey',
  '  placeholder ("Message").',
  '- chatHeaderTitle: the contact name or number exactly as shown in the header.',
  'For anything that is not a WhatsApp chat, messageBoxText and chatHeaderTitle are null.',
  '',
  'What they want: a visiting card usually has no order on it — return no lines rather',
  'than inventing any. For the rest, and these rules matter more than completeness:',
  '- NEVER invent a line, a quantity or a rate. If a cell is blank or you cannot read',
  '  it, return null. A plausible-looking number in a price column is far worse than an',
  '  empty one: an empty cell gets filled in, a wrong one gets confirmed and shipped.',
  '- Copy the product description VERBATIM as written, including the width and any',
  '  colour or finish. Do not tidy it, expand abbreviations, or convert units.',
  '- Quantities and rates are numbers only — strip currency symbols, commas and units.',
  '- Lower a line\'s confidence when the text is unclear. Be honest; a low number is',
  '  useful and a falsely high one is not.',
  '- Ignore our own letterhead if the document quotes it back. We want what THEY ordered.',
  '- Dates as YYYY-MM-DD; confidences from 0 to 1. Anything else worth knowing (an email',
  '  subject, a card\'s address or GSTIN, a question asked) goes in notes.',
].join('\n');

/** What an enquiry can arrive as. */
const SOURCE_TYPES = ['whatsapp_chat', 'email', 'visiting_card', 'document'];

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
    'sourceType', 'messageBoxText', 'chatHeaderTitle', 'customerName', 'contactPerson',
    'customerEmail', 'phoneNumbers', 'customerPhone', 'poNumber', 'poDate', 'deliveryDate', 'currency', 'lines', 'notes', 'confidence',
  ],
  properties: {
    sourceType:      { type: 'string', enum: SOURCE_TYPES },
    messageBoxText:  nullable(str),
    chatHeaderTitle: nullable(str),
    customerName:    nullable(str),
    contactPerson:   nullable(str),
    customerEmail:   nullable(str),
    phoneNumbers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'label'],
        properties: { number: str, label: nullable(str) },
      },
    },
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

/** An Indian mobile: ten digits starting 6–9, after any 91 / 0 prefix. */
function isMobile(n) {
  const d = String(n || '').replace(/\D/g, '').replace(/^(91|0)(?=[6-9]\d{9}$)/, '');
  return /^[6-9]\d{9}$/.test(d);
}

/**
 * The number they can be messaged on, from all the numbers a card, an
 * email signature or a letterhead shows: one marked WhatsApp, then one
 * marked mobile, then any mobile-looking number, then whatever there is.
 */
function pickFromList(list) {
  const numbers = (Array.isArray(list) ? list : [])
    .map((p) => ({ number: phoneIn(p?.number) || phone(p?.number), label: String(p?.label || '').toLowerCase() }))
    .filter((p) => p.number);
  return (
    numbers.find((p) => /whats\s*app|\bwa\b/.test(p.label)) ||
    numbers.find((p) => /mob|cell|\bm\b|hp/.test(p.label)) ||
    numbers.find((p) => isMobile(p.number)) ||
    numbers[0] ||
    null
  )?.number ?? null;
}

/**
 * The customer's number, and where it was found. A chat's message box
 * comes first — it is where the number is typed before the screenshot —
 * then a number shown in the chat header. Otherwise the reading's own
 * pick, checked against every number it listed: a mobile wins over a
 * landline, because the one number is also their WhatsApp number.
 */
function resolvePhone(raw) {
  const type = SOURCE_TYPES.includes(raw.sourceType) ? raw.sourceType : 'document';
  if (type === 'whatsapp_chat') {
    const fromBox = phoneIn(raw.messageBoxText);
    if (fromBox) return { number: fromBox, source: 'message_box' };
    const fromHeader = phoneIn(raw.chatHeaderTitle);
    if (fromHeader) return { number: fromHeader, source: 'chat_header' };
  }
  // The number alone: "M: 97874 98412" gives "97874 98412".
  const named = phoneIn(raw.customerPhone) || phone(raw.customerPhone);
  const listed = pickFromList(raw.phoneNumbers);
  // The reading's pick stands unless it is a landline and a mobile was listed.
  const number = named && (isMobile(named) || !listed || !isMobile(listed)) ? named : listed || named;
  if (!number) return { number: null, source: null };
  const source = { whatsapp_chat: 'chat_message', email: 'email', visiting_card: 'visiting_card' }[type] || 'document';
  return { number, source };
}

/** An email address, lower-cased, or null. */
function email(v) {
  const m = String(v || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
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
    sourceType:     SOURCE_TYPES.includes(raw.sourceType) ? raw.sourceType : 'document',
    customerName:   text(raw.customerName),
    contactPerson:  text(raw.contactPerson),
    customerEmail:  email(raw.customerEmail),
    // One number, their mobile and their WhatsApp number both: the one
    // they reached us on, or can be messaged on.
    customerMobile:   number,
    customerWhatsapp: number,
    phoneSource:      source,
    // Every number shown (a card often has several), labelled as printed.
    phoneNumbers: (Array.isArray(raw.phoneNumbers) ? raw.phoneNumbers : [])
      .map((p) => ({ number: phoneIn(p?.number) || phone(p?.number), label: text(p?.label) }))
      .filter((p) => p.number),
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
  extractPurchaseOrder, parseJsonReply, normaliseDraft, phoneIn, phoneKey, isMobile,
  OUTPUT_SCHEMA, SOURCE_TYPES, IMAGE_TYPES, PDF_TYPE,
};
