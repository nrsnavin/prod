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

module.exports = { similar, keyWords, nameScore };
