'use strict';
// ══════════════════════════════════════════════════════════════════
//  NOTICES IN THE WORKERS' LANGUAGES
//
//  The employee app's screens are in Tamil, but notices were typed in
//  English and shown that way. Now each notice is put into Tamil and
//  Hindi when it is posted (and again when its English changes), kept
//  beside the English on the notice, and an admin can correct either —
//  a correction is marked as a person's and not overwritten until the
//  English itself changes. Workers get their language; anything not
//  translated shows in English. Without the model, notices simply stay
//  English.
// ══════════════════════════════════════════════════════════════════

const Announcement = require('../models/Announcement');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const ledger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const SURFACE = 'notice-translate';
const LANGS = { ta: 'Tamil', hi: 'Hindi' };

// The object in the model's reply, or null (utils/modelJson.js).
const { parseJson } = require('../utils/modelJson');

/** { ta: {title, body}, hi: {title, body} }, or null when the model is off or unusable. */
async function translate({ title, body }, { refId = null } = {}) {
  const claude = anthropic();
  if (!claude) return null;
  const startedAt = Date.now();
  try {
    const prompt = [
      'Translate this notice for workers at an elastic factory in Tamil Nadu into plain, everyday Tamil and Hindi — the words a',
      'supervisor would use on the floor, not formal or literary. Keep numbers, dates, times, money, names and machine numbers exactly',
      'as written. Do not add or leave out anything. Return ONLY JSON:',
      '{"ta":{"title":"…","body":"…"},"hi":{"title":"…","body":"…"}}',
      '', `Title: ${String(title).slice(0, 300)}`, `Body:\n"""\n${String(body).slice(0, 3000)}\n"""`,
    ].join('\n');
    const msg = await claude.messages.create({ model: TEXT_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] });
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    const out = {};
    for (const k of Object.keys(LANGS)) {
      const t = raw?.[k];
      if (t && String(t.title || '').trim() && String(t.body || '').trim()) out[k] = { title: String(t.title).trim().slice(0, 300), body: String(t.body).trim().slice(0, 5000) };
    }
    if (!Object.keys(out).length) throw new Error('model returned no translation');
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), refType: 'Announcement', refId, proposed: { langs: Object.keys(out) }, latencyMs: Date.now() - startedAt, usage: msg.usage }).catch(() => null);
    return out;
  } catch (err) {
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err?.message || String(err) }).catch(() => null);
    return null;
  }
}

/**
 * Translate a notice and keep it. `force` replaces a person's correction
 * too — used when the English has changed under it.
 */
async function applyTo(id, { force = false } = {}) {
  const doc = await Announcement.findById(id).lean();
  if (!doc) return null;
  const tr = await translate(doc, { refId: doc._id });
  if (!tr) return doc;
  const set = {};
  for (const [k, v] of Object.entries(tr)) {
    if (!force && doc.translations?.[k]?.by === 'person') continue;
    set[`translations.${k}`] = { ...v, by: 'ai', at: new Date() };
  }
  if (!Object.keys(set).length) return doc;
  return Announcement.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
}

/** The language asked for: ?lang=, else the first of Accept-Language; null for English. */
function langOf(req) {
  const q = String(req.query?.lang || '').toLowerCase().slice(0, 2);
  if (LANGS[q]) return q;
  const h = String(req.get?.('accept-language') || '').toLowerCase().slice(0, 2);
  return LANGS[h] ? h : null;
}

/** The notice as a worker in `lang` sees it; the English kept alongside. */
function localise(doc, lang) {
  const t = lang && doc.translations?.[lang];
  if (!t?.title || !t?.body) return { ...doc, lang: 'en' };
  return { ...doc, title: t.title, body: t.body, lang, original: { title: doc.title, body: doc.body } };
}

module.exports = { translate, applyTo, localise, langOf, LANGS, SURFACE };
