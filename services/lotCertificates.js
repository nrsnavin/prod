'use strict';
// ══════════════════════════════════════════════════════════════════
//  A YARN LOT'S TEST CERTIFICATE, ON THE LOT
//
//  fromPhoto({ pages, lot }) → { read, lot, candidates, tests, history, checks, aiSuggestion }
//    The supplier's certificate is read (utils/paperReaders.js): each
//    property as printed, with the range the certificate gives. Here, not
//    by the model: the lot it is for (the one picked, else the one its lot
//    number names), each property put under a key so lots can be compared
//    (denier, tenacity, elongation, shrinkage …), and the checks —
//      FAIL         the certificate says the lot failed
//      OUT_OF_SPEC  a value outside the range the certificate itself gives
//      DRIFT        a value more than 10% off the average of the last five
//                   certified lots of the same yarn
//      LOT_NO       the certificate names another lot than the one picked
//      LOT          no lot on file for the number it names
//    Nothing is saved.
//  save(lot, body)   the confirmed certificate kept on the lot, with the
//                    checks as they stood; a newer one replaces it.
//  search({ material, key, min, max })  lots whose certificate has that
//                    property in that range ("tenacity 4.5 and over").
//  compare({ material, lots })  the certified lots side by side, a row a
//                    property, with the average and what is out of range.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const YarnLot = require('../models/YarnLot');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');
const { escapeRegex } = require('../utils/escapeRegex');

const SURFACE = 'lot-certificate-ocr';
const DRIFT = 0.10;
const HISTORY = 5;
const isId = (v) => mongoose.isValidObjectId(String(v || ''));
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The comparable properties, in the order they are shown. */
const KEY_LABELS = {
  denier: 'Denier', dtex: 'Decitex', filaments: 'Filaments', tenacity: 'Tenacity', elongation: 'Elongation', shrinkage: 'Shrinkage',
  modulus: 'Modulus', twist: 'Twist', interlace: 'Interlace', oil: 'Oil pick-up', evenness: 'Evenness', moisture: 'Moisture', colour: 'Colour difference',
};
const KEY_ORDER = Object.keys(KEY_LABELS);

/** The property a printed test name is. Unknown ones keep their own name, so two of them never collide. */
function keyOf(name, unit) {
  const n = String(name || '');
  if (/tenacity|breaking strength|\bstrength\b/i.test(n)) return 'tenacity';
  if (/elongation|extension at break|\beab\b/i.test(n)) return 'elongation';
  if (/shrink|\bbws\b|boiling water|hot air/i.test(n)) return 'shrinkage';
  if (/interlace|\bnips?\b|intermingl|entangle/i.test(n)) return 'interlace';
  if (/twist|\btpm\b|\btpi\b/i.test(n)) return 'twist';
  if (/\boil\b|\bopu\b|spin finish|\bfinish\b/i.test(n)) return 'oil';
  if (/evenness|\bu\s?%|uster|\bcv\b/i.test(n)) return 'evenness';
  if (/moisture|regain/i.test(n)) return 'moisture';
  if (/modulus|\bpower\b/i.test(n)) return 'modulus';
  if (/delta\s?e|colou?r diff|\bshade\b/i.test(n)) return 'colour';
  if (/filament|\bfil\b/i.test(n)) return 'filaments';
  if (/denier|\bden\b|linear density|\bcount\b|dtex/i.test(n)) return /dtex/i.test(`${n} ${unit || ''}`) ? 'dtex' : 'denier';
  return `other:${n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'test'}`;
}
const labelOf = (key, printed) => KEY_LABELS[key] || printed;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : round(Number(v), 4));

/** Tests as read or typed → [{ key, label, value, unit, min, max }]. */
function normalise(tests) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tests) ? tests.slice(0, 40) : []) {
    const printed = String(t?.label ?? t?.name ?? '').trim().slice(0, 60);
    const value = num(t?.value);
    if (!printed || value === null) continue;
    const unit = String(t?.unit || '').trim().slice(0, 16);
    const key = typeof t?.key === 'string' && (KEY_LABELS[t.key] || t.key.startsWith('other:')) ? t.key : keyOf(printed, unit);
    if (seen.has(key)) continue;   // one value a property: the first printed
    seen.add(key);
    out.push({ key, label: printed, value, unit, min: num(t?.min), max: num(t?.max) });
  }
  return out;
}

/** Each property's average over the last certified lots of the yarn. → { key: { avg, n } } */
async function history(rawMaterial, exceptLot) {
  const lots = await YarnLot.find({ rawMaterial, _id: { $ne: exceptLot }, certificate: { $ne: null } })
    .select('certificate.tests certificate.date receivedDate').sort({ 'certificate.date': -1, receivedDate: -1 }).limit(HISTORY).lean();
  const sums = {};
  for (const l of lots) for (const t of l.certificate?.tests || []) {
    const s = sums[t.key] || { total: 0, n: 0 };
    s.total += t.value; s.n += 1;
    sums[t.key] = s;
  }
  return Object.fromEntries(Object.entries(sums).map(([k, s]) => [k, { avg: round(s.total / s.n), n: s.n }]));
}

function flagsFor(tests, result, hist, materialName) {
  const flags = [];
  const say = (t, v) => `${labelOf(t.key, t.label)} ${v}${t.unit ? ` ${t.unit}` : ''}`;
  if (!tests.length) flags.push({ code: 'NO_TESTS', severity: 'danger', message: 'No test values were read: type them from the certificate' });
  if (result === 'fail') flags.push({ code: 'FAIL', severity: 'danger', message: 'The certificate says the lot failed' });
  for (const t of tests) {
    if (t.min !== null && t.value < t.min) flags.push({ code: 'OUT_OF_SPEC', severity: 'danger', key: t.key, message: `${say(t, t.value)} is below the ${t.min} the certificate itself gives` });
    else if (t.max !== null && t.value > t.max) flags.push({ code: 'OUT_OF_SPEC', severity: 'danger', key: t.key, message: `${say(t, t.value)} is above the ${t.max} the certificate itself gives` });
    const h = hist[t.key];
    if (h && h.n >= 2 && h.avg && Math.abs(t.value - h.avg) / Math.abs(h.avg) > DRIFT) {
      flags.push({ code: 'DRIFT', severity: 'warning', key: t.key, message: `${say(t, t.value)} against ${h.avg} on average over the last ${h.n} lots${materialName ? ` of ${materialName}` : ''}` });
    }
  }
  return flags;
}

const lotSummary = (l) => (l ? {
  _id: String(l._id), lotNo: l.lotNo, shade: l.shade || '', status: l.status,
  rawMaterial: l.rawMaterial?._id ? String(l.rawMaterial._id) : String(l.rawMaterial || ''), materialName: l.rawMaterial?.name || '',
  supplierName: l.supplier?.name || '', hasCertificate: !!l.certificate,
} : null);

async function loadLot(id) {
  return YarnLot.findById(id).select('lotNo shade status rawMaterial supplier certificate').populate('rawMaterial', 'name unit').populate('supplier', 'name').lean();
}

async function fromPhoto({ pages, lot = null } = {}) {
  const startedAt = Date.now();
  let read;
  try {
    read = await require('../utils/paperReaders').readTestCertificate(pages);
  } catch (err) {
    if (!err.code) await aiLedger.record({ surface: SURFACE, model: '?', promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
    throw err;
  }
  const { model, usage, latencyMs, ...fields } = read;
  const record = (proposed) => aiLedger.record({ surface: SURFACE, model, promptVersion: promptVersion(SURFACE), proposed, latencyMs, usage })
    .then((id) => (id ? String(id) : null)).catch(() => null);
  if (fields.problem) return { read: fields, lot: null, candidates: [], tests: [], history: {}, checks: [], aiSuggestion: await record({ problem: fields.problem }) };

  let target = isId(lot) ? await loadLot(lot) : null;
  const candidates = fields.lotNo
    ? await YarnLot.find({ lotNo: new RegExp(`^${escapeRegex(fields.lotNo)}$`, 'i') }).select('lotNo shade status rawMaterial supplier certificate').populate('rawMaterial', 'name').populate('supplier', 'name').limit(10).lean()
    : [];
  if (!target && candidates.length === 1) target = await loadLot(candidates[0]._id);
  const checks = [];
  if (target && fields.lotNo && squash(target.lotNo) !== squash(fields.lotNo)) checks.push({ code: 'LOT_NO', severity: 'warning', message: `The certificate is for lot ${fields.lotNo}; this is lot ${target.lotNo}` });
  if (!target) {
    checks.push({ code: 'LOT', severity: 'danger', message: !fields.lotNo ? 'No lot number was read: pick the lot it belongs to'
      : candidates.length > 1 ? `Lot ${fields.lotNo} is on file for ${candidates.length} yarns: pick the lot` : `Lot ${fields.lotNo} is not on file: pick the lot it belongs to` });
  }
  const tests = normalise(fields.tests);
  const hist = target ? await history(target.rawMaterial?._id || target.rawMaterial, target._id) : {};
  checks.push(...flagsFor(tests, fields.result, hist, target?.rawMaterial?.name));
  return {
    read: fields, lot: lotSummary(target), candidates: candidates.map(lotSummary), tests, history: hist, checks,
    aiSuggestion: await record({ lot: target ? String(target._id) : null, lotNo: fields.lotNo, tests: tests.map((t) => ({ key: t.key, value: t.value })) }),
  };
}

/**
 * Keep the confirmed certificate on the lot. body: { certNo, date, issuer,
 * product, result, tests: [{ key?, label, value, unit, min, max }], aiSuggestion }
 */
async function save(lotId, b = {}, { by = null, byName = '' } = {}) {
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  if (!isId(lotId)) throw fail('Lot not found', 404);
  const lot = await loadLot(lotId);
  if (!lot) throw fail('Lot not found', 404);
  const tests = normalise(b.tests);
  if (!tests.length) throw fail('Put in at least one test with its value');
  const result = b.result === 'pass' || b.result === 'fail' ? b.result : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? new Date(`${b.date}T00:00:00Z`) : null;
  const flags = flagsFor(tests, result, await history(lot.rawMaterial?._id || lot.rawMaterial, lot._id), lot.rawMaterial?.name);
  const certificate = {
    certNo: String(b.certNo || '').trim().slice(0, 40), date, issuer: String(b.issuer || '').trim().slice(0, 120), product: String(b.product || '').trim().slice(0, 120),
    result, tests, flags: flags.map(({ code, severity, message }) => ({ code, severity, message })),
    aiSuggestion: isId(b.aiSuggestion) ? String(b.aiSuggestion) : '', by, byName: String(byName || ''), at: new Date(),
  };
  const saved = await YarnLot.findByIdAndUpdate(lot._id, { $set: { certificate } }, { new: true, runValidators: true }).select('lotNo certificate').lean();
  if (certificate.aiSuggestion) {
    aiLedger.settle(certificate.aiSuggestion, { accepted: { lot: String(lot._id), lotNo: lot.lotNo, tests: tests.map((t) => ({ key: t.key, value: t.value })) }, decidedBy: by, expectSurface: SURFACE }).catch(() => null);
  }
  return saved.certificate;
}

/** Lots whose certificate has `key` within [min, max]. */
async function search({ material, key, min = null, max = null } = {}) {
  if (!key) throw Object.assign(new Error('Say which property to search by'), { status: 400 });
  const range = {};
  if (num(min) !== null) range.$gte = num(min);
  if (num(max) !== null) range.$lte = num(max);
  const q = { 'certificate.tests': { $elemMatch: { key: String(key), ...(Object.keys(range).length ? { value: range } : {}) } } };
  if (isId(material)) q.rawMaterial = material;
  const lots = await YarnLot.find(q).select('lotNo shade status receivedQty consumedQty rawMaterial supplier certificate receivedDate')
    .populate('rawMaterial', 'name').populate('supplier', 'name').sort({ receivedDate: -1 }).limit(200).lean();
  return lots.map((l) => {
    const t = l.certificate.tests.find((x) => x.key === key);
    return {
      ...lotSummary(l), balance: Math.max(0, (l.receivedQty || 0) - (l.consumedQty || 0)),
      value: t.value, unit: t.unit, min: t.min, max: t.max, certNo: l.certificate.certNo, date: l.certificate.date,
      outOfSpec: (t.min !== null && t.min !== undefined && t.value < t.min) || (t.max !== null && t.max !== undefined && t.value > t.max),
    };
  });
}

/** The certified lots of a yarn (or those named) side by side. */
async function compare({ material, lots, limit = 10 } = {}) {
  const ids = (Array.isArray(lots) ? lots : String(lots || '').split(',')).filter(isId);
  const q = ids.length ? { _id: { $in: ids }, certificate: { $ne: null } } : { rawMaterial: material, certificate: { $ne: null } };
  if (!ids.length && !isId(material)) throw Object.assign(new Error('Say which yarn, or which lots'), { status: 400 });
  const rows = await YarnLot.find(q).select('lotNo shade status receivedDate certificate').sort({ 'certificate.date': -1, receivedDate: -1 })
    .limit(Math.min(20, Math.max(1, Number(limit) || 10))).lean();
  const keys = new Map();
  for (const l of rows) for (const t of l.certificate.tests) if (!keys.has(t.key)) keys.set(t.key, { label: labelOf(t.key, t.label), unit: t.unit });
  const order = [...keys.keys()].sort((a, b) => {
    const ia = KEY_ORDER.indexOf(a); const ib = KEY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const table = order.map((key) => {
    const cells = rows.map((l) => {
      const t = l.certificate.tests.find((x) => x.key === key);
      if (!t) return null;
      const out = (t.min !== null && t.min !== undefined && t.value < t.min) || (t.max !== null && t.max !== undefined && t.value > t.max);
      return { value: t.value, min: t.min ?? null, max: t.max ?? null, outOfSpec: out };
    });
    const vals = cells.filter(Boolean).map((c) => c.value);
    return {
      key, label: keys.get(key).label, unit: keys.get(key).unit, cells,
      avg: vals.length ? round(vals.reduce((t, v) => t + v, 0) / vals.length) : null,
      low: vals.length ? Math.min(...vals) : null, high: vals.length ? Math.max(...vals) : null,
    };
  });
  return {
    lots: rows.map((l) => ({ _id: String(l._id), lotNo: l.lotNo, shade: l.shade || '', status: l.status, certNo: l.certificate.certNo, date: l.certificate.date, result: l.certificate.result, flags: (l.certificate.flags || []).length })),
    rows: table,
    keys: order.map((k) => ({ key: k, label: keys.get(k).label, unit: keys.get(k).unit })),
  };
}

module.exports = { fromPhoto, save, search, compare, normalise, keyOf, flagsFor, history, KEY_LABELS, SURFACE };
