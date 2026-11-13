'use strict';
// ══════════════════════════════════════════════════════════════════
//  SUPPLIERS' PRICE LISTS AND QUOTATIONS
//
//  fromPhoto({ pages, supplier }) → { read, supplier, rows, aiSuggestion }
//    The paper is read (utils/paperReaders.js readPriceList); the
//    supplier found by GSTIN, else by name; each line put against one of
//    our materials — the ones bought from this supplier first, then any —
//    with the rate live for it now. Nothing is saved.
//  save({ supplier, rows, ... })
//    What the person confirmed becomes the live rate for each material
//    from this supplier; the rate it replaces is kept, no longer live.
//  flags({ supplier, lines })
//    A purchase order or bill line above the supplier's live rate (by more
//    than the bills' rate tolerance) is flagged, with the rate, the paper
//    it came from and how long it holds. A line below it, or for a material
//    nobody quoted, says nothing.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const SupplierRate = require('../models/SupplierRate');
const Supplier = require('../models/Supplier');
const RawMaterial = require('../models/RawMaterial');
const PurchaseOrder = require('../models/PurchaseOrder');
const aiLedger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');
const { nameScore } = require('./partyMatch');
const { rank } = require('../utils/fuzzyMatch');
const { r2 } = require('../utils/money');
const bizDates = require('../utils/bizDates');

const SURFACE = 'price-list-ocr';
const isId = (v) => mongoose.isValidObjectId(String(v || ''));
const rupees = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function findSupplier(read, picked) {
  if (isId(picked)) {
    const s = await Supplier.findById(picked).select('name gstin').lean();
    if (s) return { ...s, matchedBy: 'picked' };
  }
  if (/^[0-9A-Z]{15}$/.test(read.supplierGstin || '')) {
    const s = await Supplier.findOne({ gstin: read.supplierGstin }).select('name gstin').lean();
    if (s) return { ...s, matchedBy: 'gstin' };
  }
  if (!read.supplierName) return null;
  const all = await Supplier.find({}).select('name gstin').lean();
  const scored = all.map((s) => ({ s, k: nameScore(read.supplierName, s.name) })).filter((x) => x.k >= 0.75).sort((a, b) => b.k - a.k);
  if (!scored.length || (scored.length > 1 && scored[1].k >= scored[0].k - 0.1)) return null;
  return { ...scored[0].s, matchedBy: 'name' };
}

/** The live rate for each material from a supplier. → Map(materialId → rate doc) */
async function liveRates(supplier, materials) {
  if (!isId(supplier)) return new Map();
  const q = { supplier, live: true };
  if (materials) q.rawMaterial = { $in: materials.filter(isId) };
  const rows = await SupplierRate.find(q).lean();
  return new Map(rows.map((r) => [String(r.rawMaterial), r]));
}

async function fromPhoto({ pages, supplier = null } = {}) {
  const startedAt = Date.now();
  let read;
  try {
    read = await require('../utils/paperReaders').readPriceList(pages);
  } catch (err) {
    if (!err.code) await aiLedger.record({ surface: SURFACE, model: '?', promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err.message }).catch(() => null);
    throw err;
  }
  const { model, usage, latencyMs, ...fields } = read;
  const record = (proposed) => aiLedger.record({ surface: SURFACE, model, promptVersion: promptVersion(SURFACE), proposed, latencyMs, usage })
    .then((id) => (id ? String(id) : null)).catch(() => null);
  if (fields.problem) return { read: fields, supplier: null, rows: [], aiSuggestion: await record({ problem: fields.problem }) };

  const party = await findSupplier(fields, supplier);
  // Materials bought from this supplier come first: a "70D nylon" on their
  // list is far more likely what we buy from them than a namesake.
  const theirs = party ? await PurchaseOrder.distinct('items.rawMaterial', { supplier: party._id }) : [];
  const theirSet = new Set(theirs.map(String));
  const materials = await RawMaterial.find({}).select('name unit').limit(5000).lean();
  const choices = materials.map((m) => ({ id: String(m._id), label: m.name, unit: m.unit || '' }));
  const live = party ? await liveRates(party._id) : new Map();
  const rows = fields.lines.map((l) => {
    const own = choices.filter((c) => theirSet.has(c.id));
    let m = own.length ? rank(l.description, own) : { confident: false, candidates: [] };
    if (!m.confident) {
      const all = rank(l.description, choices);
      m = all.confident || !m.candidates.length ? all : m;
    }
    const best = m.confident ? m.best : null;
    const now = best ? live.get(best.id) : null;
    return {
      ...l,
      rawMaterial: best ? best.id : null,
      materialName: best ? best.label : null,
      candidates: (m.candidates || []).slice(0, 4).map((c) => ({ id: c.id, name: c.label, score: c.score })),
      current: now ? { rate: now.rate, unit: now.unit, ref: now.ref, quotedOn: now.quotedOn } : null,
      change: now && now.rate > 0 ? r2(((l.rate - now.rate) / now.rate) * 100) : null,
    };
  });
  return {
    read: fields,
    supplier: party ? { _id: String(party._id), name: party.name, matchedBy: party.matchedBy } : null,
    rows,
    aiSuggestion: await record({ supplier: party ? String(party._id) : null, lines: rows.map((x) => ({ material: x.rawMaterial, rate: x.rate })) }),
  };
}

/**
 * Save the confirmed rates. rows: [{ rawMaterial, rate, unit, description,
 * gstPercent, minQty }]. Each becomes the live rate for its material
 * from this supplier. → { saved: n, replaced: n }
 */
async function save({ supplier, rows, source = 'quotation', ref = '', quotedOn = null, validUntil = null, aiSuggestion = '', by = null }) {
  if (!isId(supplier)) throw Object.assign(new Error('Pick the supplier'), { status: 400 });
  const s = await Supplier.findById(supplier).select('name').lean();
  if (!s) throw Object.assign(new Error('Supplier not found'), { status: 404 });
  const list = (Array.isArray(rows) ? rows : []).filter((r) => isId(r?.rawMaterial) && Number(r?.rate) > 0);
  if (!list.length) throw Object.assign(new Error('Put at least one line against a material, with its rate'), { status: 400 });
  const mats = new Map((await RawMaterial.find({ _id: { $in: list.map((r) => r.rawMaterial) } }).select('name unit').lean()).map((m) => [String(m._id), m]));
  let saved = 0;
  let replaced = 0;
  for (const r of list) {
    const m = mats.get(String(r.rawMaterial));
    if (!m) continue;
    const doc = await SupplierRate.create({
      supplier: s._id, supplierName: s.name, rawMaterial: m._id, materialName: m.name,
      description: String(r.description || '').slice(0, 200), rate: r2(Number(r.rate)), unit: String(r.unit || m.unit || '').slice(0, 10),
      gstPercent: Number.isFinite(Number(r.gstPercent)) && r.gstPercent !== null && r.gstPercent !== '' ? Number(r.gstPercent) : null,
      minQty: Number.isFinite(Number(r.minQty)) && r.minQty !== null && r.minQty !== '' ? Number(r.minQty) : null,
      source: ['price_list', 'quotation', 'manual'].includes(source) ? source : 'quotation', ref: String(ref || '').slice(0, 40),
      quotedOn: quotedOn ? new Date(quotedOn) : null, validUntil: validUntil ? new Date(validUntil) : null,
      aiSuggestion: String(aiSuggestion || ''), createdBy: by || null,
    });
    const old = await SupplierRate.updateMany({ supplier: s._id, rawMaterial: m._id, live: true, _id: { $ne: doc._id } }, { $set: { live: false, replacedBy: doc._id } });
    replaced += old.modifiedCount || 0;
    saved += 1;
  }
  if (aiSuggestion) aiLedger.settle(aiSuggestion, { accepted: { supplier: String(s._id), lines: list.map((x) => ({ material: String(x.rawMaterial), rate: r2(Number(x.rate)) })) }, decidedBy: by, expectSurface: SURFACE }).catch(() => null);
  return { saved, replaced };
}

/**
 * Lines above the supplier's live rate. lines: [{ rawMaterial, rate,
 * description }]. → flags [{ code, severity, message, line }]
 */
async function flags({ supplier, lines }) {
  const list = (Array.isArray(lines) ? lines : []).map((l, i) => ({ ...l, i })).filter((l) => isId(l.rawMaterial) && Number(l.rate) > 0);
  if (!isId(supplier) || !list.length) return [];
  const live = await liveRates(supplier, list.map((l) => l.rawMaterial));
  const tolerance = Number((await require('./booksLock').getSettings().catch(() => null))?.bills?.rateVariancePercent ?? 2);
  const today = bizDates.today();
  const out = [];
  for (const l of list) {
    const q = live.get(String(l.rawMaterial));
    if (!q || !(q.rate > 0)) continue;
    const over = (Number(l.rate) - q.rate) / q.rate * 100;
    if (over <= tolerance + 1e-9) continue;
    const lapsed = q.validUntil && new Date(q.validUntil) < today;
    out.push({
      code: 'ABOVE_QUOTE', severity: 'warning', line: l.i,
      message: `${l.description || q.materialName} at ${rupees(l.rate)} is ${r2(over)}% above ${q.supplierName}'s ${q.source === 'price_list' ? 'price list' : 'quotation'}${q.ref ? ` ${q.ref}` : ''} of ${rupees(q.rate)}${q.unit ? `/${q.unit}` : ''}${q.validUntil ? `, ${lapsed ? 'which lapsed on' : 'good till'} ${bizDates.dmy(q.validUntil, '/')}` : ''}`,
    });
  }
  return out;
}

/** A supplier's live rates, for their page. */
async function list(supplier) {
  if (!isId(supplier)) return [];
  return SupplierRate.find({ supplier, live: true }).sort({ materialName: 1 }).lean();
}

module.exports = { fromPhoto, save, flags, list, liveRates, findSupplier, SURFACE };
