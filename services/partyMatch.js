'use strict';
// ══════════════════════════════════════════════════════════════════
//  IS THIS CUSTOMER (OR SUPPLIER) ALREADY ON FILE?
//
//  "Sunrise Garments", "SUNRISE GARMENTS PVT LTD" and "Sunrise Garment"
//  are one firm entered three times, and each gets its own ledger, its
//  own outstanding and its own line in Tally. Before a new one is saved
//  this finds those already there: the same GSTIN (the same firm, for
//  certain), the same phone, or a name that is the same once the legal
//  suffixes and punctuation are set aside.
//
//  It only warns. Two real firms can share a name in different towns.
// ══════════════════════════════════════════════════════════════════

const { escapeRegex } = require('../utils/escapeRegex');

const NOISE = new Set(['the', 'and', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'corp', 'corporation', 'inc', 'firm', 'enterprises', 'enterprise', 'industries', 'industry', 'traders', 'trading', 'mills', 'exports', 'm', 's', 'ms']);

/** The words that name the firm, singular, without the legal suffixes. */
function keyWords(name) {
  return String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
    .filter((w) => w && !NOISE.has(w));
}

/** Share of the shorter name's words found in the longer. */
function nameScore(a, b) {
  const A = keyWords(a); const B = keyWords(b);
  if (!A.length || !B.length) return 0;
  // "Unit 1" and "Unit 2" are two places: numbers that differ are never the same firm.
  const nums = (x) => x.filter((w) => /^\d+$/.test(w)).sort().join(',');
  if (nums(A) && nums(B) && nums(A) !== nums(B)) return 0;
  const [short, long] = A.length <= B.length ? [A, B] : [B, A];
  const set = new Set(long);
  return short.filter((w) => set.has(w)).length / short.length;
}

/**
 * @param Model   Customer or Supplier
 * @param fields  { name, gstin, phone, excludeId, phoneField }
 * @returns up to 3 { _id, name, gstin, phone, why }
 */
async function similar(Model, { name = '', gstin = '', phone = '', excludeId = null, phoneField = 'phoneNumber' } = {}) {
  const out = new Map();
  const add = (doc, why) => { if (!doc || String(doc._id) === String(excludeId || '')) return; if (!out.has(String(doc._id))) out.set(String(doc._id), { _id: doc._id, name: doc.name, gstin: doc.gstin || '', phone: doc[phoneField] || '', why }); };
  const select = `name gstin ${phoneField}`;
  const g = String(gstin || '').trim().toUpperCase();
  if (g.length === 15) for (const d of await Model.find({ gstin: g }).select(select).limit(3).lean()) add(d, 'same GSTIN');
  const p = String(phone || '').replace(/\D/g, '').slice(-10);
  if (p.length === 10) for (const d of await Model.find({ [phoneField]: new RegExp(`${p}$`) }).select(select).limit(3).lean()) add(d, 'same phone');
  const words = keyWords(name).filter((w) => w.length >= 3);
  if (words.length) {
    // Candidates sharing the first distinctive word; scored on all of them.
    const pool = await Model.find({ name: new RegExp(escapeRegex(words[0]).replace(/s$/, ''), 'i') }).select(select).limit(50).lean();
    for (const d of pool.map((x) => ({ d: x, s: nameScore(name, x.name) })).filter((x) => x.s >= 0.75).sort((a, b) => b.s - a.s)) add(d.d, 'similar name');
  }
  return [...out.values()].slice(0, 3);
}

/**
 * Who a name on a paper could be, best first: every party on file whose
 * name is the same once suffixes and punctuation are set aside (75% of
 * the shorter name's words).
 */
async function nameMatches(Model, name, { select = 'name gstin' } = {}) {
  if (!keyWords(name).length) return [];
  const all = await Model.find({}).select(select).lean();
  return all.map((doc) => ({ doc, score: nameScore(name, doc.name) })).filter((x) => x.score >= 0.75).sort((a, b) => b.score - a.score);
}

/**
 * The ONE party a name on a paper means, for a reader that would
 * otherwise have to guess (a payment advice, a customer's debit note):
 * the best match when no other comes close — or, of several that do,
 * the one whose name it is word for word. → { party, candidates }:
 * party null with candidates > 1 means "more than one it could be".
 */
async function oneByName(Model, name, opts) {
  const scored = await nameMatches(Model, name, opts);
  if (!scored.length) return { party: null, candidates: 0 };
  const close = scored.filter((x) => x.score >= scored[0].score - 0.1);
  if (close.length === 1) return { party: scored[0].doc, candidates: 1 };
  const words = keyWords(name).join(' ');
  const exact = close.filter((x) => keyWords(x.doc.name).join(' ') === words);
  return { party: exact.length === 1 ? exact[0].doc : null, candidates: close.length };
}

module.exports = { similar, keyWords, nameScore, nameMatches, oneByName };
