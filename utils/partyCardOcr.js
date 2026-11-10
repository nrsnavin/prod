'use strict';
// ═════════════════════════════════════════════════════════════════
//  A visiting card or letterhead into a customer / supplier form
//  (Claude vision), and the GSTIN read the same way every time.
//
//  readCard(pages) -> { problem, name, contactName, phone, email, gstin,
//    address, city, pincode, stateCode, model, usage, latencyMs }
//  gstinInfo(gstin) -> { valid, stateCode, pan, checksumOk } — offline:
//    the state is the first two digits, the PAN the next ten, and the
//    last character a check digit over the first fourteen.
// ═════════════════════════════════════════════════════════════════
const { anthropic, VISION_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The GSTIN check character over its first fourteen (the published mod-36 scheme). */
function checkChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

function gstinInfo(raw) {
  const g = String(raw || '').trim().toUpperCase();
  if (!GSTIN_RE.test(g)) return { valid: false, stateCode: '', pan: '', checksumOk: false };
  return { valid: true, stateCode: g.slice(0, 2), pan: g.slice(2, 12), checksumOk: checkChar(g.slice(0, 14)) === g[14] };
}

const PROMPT = [
  'This is a business card, letterhead or invoice header of a company in India: a customer or a supplier of',
  'an elastic weaving factory. Read the company\'s details for its master record.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"problem":null,"name":"Sunrise Garments","contactName":"R. Kumar","phone":"9876543210","email":"kumar@sunrise.in",',
  ' "gstin":"33AAECS1234F1Z5","address":"12, Mill Road, Avinashi Road","city":"Tiruppur","pincode":"641601"}',
  '',
  'Rules:',
  '- name: the company or firm name, as printed (not a person, unless it is a proprietor\'s firm with no other name).',
  '- contactName: the person on the card, if any. phone: one mobile number, 10 digits, no +91 or spaces.',
  '- gstin: exactly as printed (15 characters), else null. Never make one up.',
  '- address: street and area only; city and pincode separately.',
  '- Null for anything not printed. Not a card or letterhead: {"problem":"not_a_card"}.',
].join('\n');

// The object in the model's reply, or null (utils/modelJson.js).
const { parseJson } = require('./modelJson');

const str = (v, n = 160) => (v == null ? '' : String(v).trim().slice(0, n));

function normalise(raw, meta = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  if (r.problem === 'not_a_card') return { problem: 'not_a_card', ...meta };
  const phone = str(r.phone).replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
  const gstin = str(r.gstin, 20).toUpperCase().replace(/\s/g, '');
  const info = gstinInfo(gstin);
  const email = str(r.email, 120).toLowerCase();
  const out = {
    problem: null,
    name: str(r.name, 120),
    contactName: str(r.contactName, 80),
    phone: /^\d{10}$/.test(phone) ? phone : '',
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    gstin: info.valid ? gstin : '',
    gstinChecksumOk: info.valid ? info.checksumOk : null,
    address: str(r.address, 200),
    city: str(r.city, 60),
    pincode: /^\d{6}$/.test(str(r.pincode).replace(/\s/g, '')) ? str(r.pincode).replace(/\s/g, '') : '',
    stateCode: info.stateCode,
    ...meta,
  };
  if (!out.name && !out.gstin && !out.phone) out.problem = 'unreadable';
  return out;
}

async function readCard(pages) {
  const list = (pages || []).filter((p) => p && p.buffer && p.buffer.length);
  if (!list.length) { const e = new Error('No photo to read.'); e.code = 'NO_PAGES'; throw e; }
  const bad = list.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) { const e = new Error(`Cannot read a ${bad.mimetype} file. Send a photo or a PDF.`); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  const claude = anthropic();
  if (!claude) { const e = new Error('ANTHROPIC_API_KEY not set on the server.'); e.code = 'ANTHROPIC_KEY_MISSING'; throw e; }
  const startedAt = Date.now();
  const content = list.slice(0, 2).map((p) => {
    const data = p.buffer.toString('base64');
    return p.mimetype === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: p.mimetype, data } };
  });
  const msg = await claude.messages.create({ model: VISION_MODEL, max_tokens: 600, messages: [{ role: 'user', content: [...content, { type: 'text', text: PROMPT }] }] });
  const reply = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return normalise(parseJson(reply), { model: VISION_MODEL, usage: msg.usage, latencyMs: Date.now() - startedAt });
}

module.exports = { readCard, gstinInfo, checkChar, normalise, PROMPT };
