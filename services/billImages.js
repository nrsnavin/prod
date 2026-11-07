'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SAME BILL PHOTO, SENT TWICE
//
//  check(pages)            → [{ docType, docNo, partyName, amount, date, exact }]
//    the bills and expenses already saved with this photo (the same
//    file, or the same picture resized or recompressed)
//  remember(pages, aiSuggestion)   a scan's fingerprints, waiting
//  link(aiSuggestion, doc)         …until the bill made from it is saved
//  rememberAttached(file, doc)     a photo attached to a saved document
// ══════════════════════════════════════════════════════════════════

const ImageFingerprint = require('../models/ImageFingerprint');
const { fingerprint, distance } = require('../utils/imageHash');

const NEAR = 6; // of 64 bits

const prints = (pages) => (pages || []).map((p) => fingerprint(p)).filter(Boolean);

async function check(pages) {
  const fps = prints(pages);
  if (!fps.length) return [];
  const exact = await ImageFingerprint.find({ linked: true, sha: { $in: fps.map((f) => f.sha) } }).lean();
  const hashes = fps.map((f) => f.dhash).filter(Boolean);
  let near = [];
  if (hashes.length) {
    const since = new Date(Date.now() - 3 * 366 * 86_400_000);
    const pool = await ImageFingerprint.find({ linked: true, dhash: { $ne: null }, createdAt: { $gte: since } }).select('dhash docType docId docNo partyName amount date sha').lean();
    near = pool.filter((r) => hashes.some((h) => distance(h, r.dhash) <= NEAR));
  }
  const out = new Map();
  for (const r of [...exact, ...near]) {
    const k = `${r.docType}:${r.docId}`;
    if (!out.has(k)) out.set(k, { docType: r.docType, docId: String(r.docId), docNo: r.docNo, partyName: r.partyName, amount: r.amount ?? null, date: r.date || null, exact: exact.some((e) => String(e._id) === String(r._id)) });
  }
  return [...out.values()];
}

async function remember(pages, aiSuggestion) {
  if (!aiSuggestion) return;
  const fps = prints(pages);
  if (fps.length) await ImageFingerprint.insertMany(fps.map((f) => ({ ...f, aiSuggestion })), { ordered: false }).catch(() => null);
}

const docFields = (doc) => ({ linked: true, docType: doc.docType, docId: doc.docId, docNo: doc.docNo || '', partyName: doc.partyName || '', amount: doc.amount, date: doc.date });

async function link(aiSuggestion, doc) {
  if (!aiSuggestion) return;
  await ImageFingerprint.updateMany({ aiSuggestion, linked: false }, { $set: docFields(doc) }).catch(() => null);
}

async function rememberAttached(file, doc) {
  const f = fingerprint({ buffer: file.buffer, mimetype: file.mimetype });
  if (!f) return;
  const already = await ImageFingerprint.exists({ sha: f.sha, docId: doc.docId });
  if (!already) await ImageFingerprint.create({ ...f, ...docFields(doc) }).catch(() => null);
}

module.exports = { check, remember, link, rememberAttached, NEAR };
