'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE PHOTO OR PDF, READ INTO JSON — the call every "fill from a
//  photo" reader shares (the elastic spec, a supplier's challan, a cone
//  label, a cancelled cheque, an ID card).
//
//  readJson({ pages, prompt, maxTokens }) → { data, model, usage, latencyMs }
//  Throws with a code a route turns into a plain message:
//    NO_PAGES · UNSUPPORTED_TYPE · ANTHROPIC_KEY_MISSING
//  `data` is null when the reply was not JSON; the reader says so.
// ══════════════════════════════════════════════════════════════════

const { anthropic, VISION_MODEL } = require('./anthropicClient');

const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

// The object in the model's reply, or null (utils/modelJson.js).
const { parseJson } = require('./modelJson');

async function readJson({ pages, prompt, maxTokens = 1200, maxPages = 3 }) {
  const list = (pages || []).filter((p) => p && p.buffer && p.buffer.length);
  if (!list.length) { const e = new Error('No photo to read.'); e.code = 'NO_PAGES'; throw e; }
  const bad = list.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) { const e = new Error(`Cannot read a ${bad.mimetype} file. Send a photo or a PDF.`); e.code = 'UNSUPPORTED_TYPE'; throw e; }
  const claude = anthropic();
  if (!claude) { const e = new Error('ANTHROPIC_API_KEY not set on the server.'); e.code = 'ANTHROPIC_KEY_MISSING'; throw e; }
  const startedAt = Date.now();
  const content = list.slice(0, maxPages).map((p) => {
    const data = p.buffer.toString('base64');
    return p.mimetype === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: p.mimetype, data } };
  });
  const msg = await claude.messages.create({ model: VISION_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: [...content, { type: 'text', text: prompt }] }] });
  const reply = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { data: parseJson(reply), model: VISION_MODEL, usage: msg.usage, latencyMs: Date.now() - startedAt };
}

/** A number as the reader gave it, or null. */
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : null; };
const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);

/** Map a route-level failure of readJson to { status, message }. */
function failure(err, what) {
  if (err.code === 'ANTHROPIC_KEY_MISSING') return { status: 503, message: `Reading ${what} is not set up on this server — type the details in.` };
  if (err.code === 'NO_PAGES' || err.code === 'UNSUPPORTED_TYPE') return { status: 400, message: err.message };
  return { status: 502, message: `The ${what} could not be read: ${err.message}` };
}

module.exports = { readJson, parseJson, num, str, failure, SUPPORTED };
