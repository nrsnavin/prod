'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE YARN, ENTERED THREE TIMES — found, named once, merged
//
//  "40s PC Black", "40/1 PC BLK" and "PC 40s black" are the same cone.
//  Each spelling has its own stock, its own receipts and its own recipes,
//  so none of the three figures is the stock of that yarn.
//
//  yarnKey(name, category) → what the yarn is, spelling aside: the count
//    (40s, 40/1, 2/40 → "40" / "2/40"), denier (840D), fibre (PC, poly,
//    cotton, nylon, spandex/lycra, rubber), shade (black/blk, white/wht,
//    a shade number). Two materials with the same key are the same yarn;
//    one with a different count or denier never is.
//  groups()   → likely duplicates, each with a standard name proposed and
//               which one to keep (the most used).
//  similarTo(name, category) → "did you mean" when a new one is typed.
//  merge({ into, from, name }) → in one transaction: every document that
//    refers to a merged material now refers to the one kept (found by
//    walking every model's schema for refs to RawMaterial, so a field
//    added later is not missed), stock and consumption added up, average
//    cost weighted, and the merged ones archived with a note — never
//    deleted, so anything that still names one still opens.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const RawMaterial = require('../models/RawMaterial');
const ErrorHandler = require('../utils/ErrorHandler');
const { rank } = require('../utils/fuzzyMatch');

const FIBRES = [
  [/\b(p\s*c|poly\s*cotton|polycot|pc)\b/, 'PC'],
  [/\b(poly(ester)?|pet|psf|pfy)\b/, 'Polyester'],
  [/\b(cotton|ctn|cot)\b/, 'Cotton'],
  [/\b(nylon|nyl|ny)\b/, 'Nylon'],
  [/\b(spandex|lycra|elastane)\b/, 'Spandex'],
  [/\b(rubber|latex)\b/, 'Rubber'],
  [/\b(viscose|rayon)\b/, 'Viscose'],
];
const SHADES = [
  [/\b(black|blk|bk)\b/, 'Black'], [/\b(white|wht|wh)\b/, 'White'], [/\b(raw\s*white|rw)\b/, 'Raw White'],
  [/\b(navy)\b/, 'Navy'], [/\b(grey|gray|gry)\b/, 'Grey'], [/\b(red)\b/, 'Red'], [/\b(blue)\b/, 'Blue'],
  [/\b(beige)\b/, 'Beige'], [/\b(skin)\b/, 'Skin'], [/\b(dyed)\b/, 'Dyed'],
];

/** What the yarn is, spelling aside; null when the name says too little to be sure. */
function parseYarn(name) {
  const s = ` ${String(name || '').toLowerCase().replace(/[’']/g, '').replace(/(?<=[a-z])\.(?=[a-z])/g, '').replace(/[_,().-]/g, ' ').replace(/\s+/g, ' ')} `;
  const denier = s.match(/(\d{2,4})\s*(d|den|denier)\b/);
  // 2/40 is two-ply 40s; 40/1 is single 40s; 40s, 40 s, 40 count.
  const ply = s.match(/\b(\d)\s*\/\s*(\d{1,3})\b/);
  const single = s.match(/\b(\d{1,3})\s*\/\s*1\b/) || s.match(/\b(\d{1,3})\s*(s|ne|count|cnt)\b/);
  let count = '';
  if (ply && ply[1] !== '1' && Number(ply[2]) >= 6) count = `${ply[1]}/${ply[2]}`;
  else if (single) count = single[1];
  const fibre = (FIBRES.find(([re]) => re.test(s)) || [])[1] || '';
  const shadeNo = (s.match(/\b(\d{3,5})\b(?!\s*(d|den|denier)\b)/) || [])[1] || '';
  const shade = (SHADES.find(([re]) => re.test(s)) || [])[1] || '';
  return { count, denier: denier ? denier[1] : '', fibre, shade, shadeNo: shadeNo !== count && shadeNo !== (denier && denier[1]) ? shadeNo : '' };
}

function yarnKey(name, category = '') {
  const y = parseYarn(name);
  if (!y.count && !y.denier) return null; // a count or denier is what makes two names the same yarn
  if (!y.fibre && !y.shade) return null;
  return [String(category || '').toLowerCase(), y.count, y.denier && `${y.denier}d`, y.fibre, y.shade, y.shadeNo].join('|');
}

/** "40s PC Black", "2/40 Polyester White", "Spandex 840D". */
function standardName(name) {
  const y = parseYarn(name);
  const count = y.count ? (y.count.includes('/') ? y.count : `${y.count}s`) : '';
  const parts = y.fibre === 'Spandex' || y.fibre === 'Rubber' || (!count && y.denier)
    ? [y.fibre, y.denier && `${y.denier}D`, y.shade, y.shadeNo]
    : [count, y.fibre, y.denier && `${y.denier}D`, y.shade, y.shadeNo];
  return parts.filter(Boolean).join(' ');
}

// ── Who refers to a material: every model's paths with ref RawMaterial ──
function refPaths(schema, prefix = '', arrays = []) {
  const out = [];
  schema.eachPath((path, type) => {
    const full = prefix ? `${prefix}.${path}` : path;
    if (type.schema && type.$isMongooseDocumentArray) {
      out.push(...refPaths(type.schema, full, [...arrays, full]));
    } else if (type.schema && type.$isSingleNested) {
      out.push(...refPaths(type.schema, full, arrays));
    } else if (type.options?.ref === 'RawMaterial') {
      out.push({ path: full, arrays, leafArray: false });
    } else if (type.$isMongooseArray && (type.caster?.options?.ref === 'RawMaterial' || type.options?.type?.[0]?.ref === 'RawMaterial')) {
      out.push({ path: full, arrays, leafArray: true });
    }
  });
  return out;
}

const MODEL_FILES = ['Elastic', 'Order', 'PurchaseOrder', 'MaterialInward', 'YarnLot', 'WarpingBatch', 'WarpingPlan', 'StockCount', 'SupplierBill', 'Expense', 'Invoice', 'AccountNote'];
function referringModels() {
  for (const f of MODEL_FILES) { try { require(`../models/${f}`); } catch { /* optional */ } }
  try { require('../models/MaterialOut.cjs'); } catch { /* optional */ }
  return mongoose.modelNames().filter((n) => n !== 'RawMaterial').map((n) => {
    const model = mongoose.model(n);
    return { model, paths: refPaths(model.schema) };
  }).filter((m) => m.paths.length);
}

/**
 * The update that moves `path` from `from` ids to `to`, through any depth
 * of arrays. Each array level gets its own filtered identifier, so only
 * the elements that hold one of the ids are touched — and an element
 * without the inner array is never addressed.
 */
function moveOp({ path, arrays, leafArray }, from, to) {
  const filter = { [path]: { $in: from } };
  if (!arrays.length && !leafArray) return { filter, update: { $set: { [path]: to } }, options: {} };
  let target = ''; let prev = '';
  arrays.forEach((a, i) => {
    const seg = prev ? a.slice(prev.length + 1) : a;
    target += `${target ? '.' : ''}${seg}.$[a${i}]`;
    prev = a;
  });
  target += `${target ? '.' : ''}${arrays.length ? path.slice(prev.length + 1) : path}`;
  if (leafArray) target += '.$[m]';
  const arrayFilters = arrays.map((a, i) => ({ [`a${i}.${path.slice(a.length + 1)}`]: { $in: from } }));
  if (leafArray) arrayFilters.push({ m: { $in: from } });
  return { filter, update: { $set: { [target]: to } }, options: { arrayFilters } };
}

async function usage(ids) {
  const counts = new Map(ids.map((id) => [String(id), 0]));
  for (const { model, paths } of referringModels()) {
    for (const p of paths) {
      const rows = await model.aggregate([{ $match: { [p.path]: { $in: ids } } }, { $project: { v: `$${p.path}` } }]);
      for (const r of rows) {
        const flat = [r.v].flat(4).map(String);
        for (const id of new Set(flat)) if (counts.has(id)) counts.set(id, counts.get(id) + 1);
      }
    }
  }
  return counts;
}

async function groups() {
  const mats = await RawMaterial.find({ archived: { $ne: true } }).select('name category stock unit price avgCost').lean();
  const byKey = new Map();
  for (const m of mats) {
    const k = yarnKey(m.name, m.category);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }
  const dupes = [...byKey.entries()].filter(([, list]) => list.length > 1);
  if (!dupes.length) return [];
  const used = await usage(dupes.flatMap(([, l]) => l.map((m) => m._id)));
  return dupes.map(([key, list]) => {
    const members = list.map((m) => ({ ...m, _id: String(m._id), uses: used.get(String(m._id)) || 0 }))
      .sort((a, b) => b.uses - a.uses || b.stock - a.stock);
    const units = new Set(members.map((m) => m.unit || 'kg'));
    return {
      key, keep: members[0]._id, name: standardName(members[0].name), members,
      stock: Math.round(members.reduce((s, m) => s + (m.stock || 0), 0) * 1000) / 1000,
      warning: units.size > 1 ? `Kept in different units (${[...units].join(', ')}) — check before merging.` : null,
    };
  }).sort((a, b) => b.members.length - a.members.length || b.stock - a.stock);
}

/** Materials a new name is probably the same as. */
async function similarTo(name, category, excludeId) {
  const n = String(name || '').trim();
  if (n.length < 3) return [];
  const mats = await RawMaterial.find({ archived: { $ne: true }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).select('name category stock unit').lean();
  const key = yarnKey(n, category);
  const same = key ? mats.filter((m) => yarnKey(m.name, category || m.category) === key) : [];
  const fuzzy = rank(n, mats.map((m) => ({ id: String(m._id), label: m.name })), { limit: 3, floor: 0.8 }).candidates.map((c) => c.id);
  const ids = new Set([...same.map((m) => String(m._id)), ...fuzzy]);
  return mats.filter((m) => ids.has(String(m._id))).slice(0, 5)
    .map((m) => ({ _id: String(m._id), name: m.name, category: m.category, stock: m.stock, unit: m.unit, sameYarn: same.some((s) => String(s._id) === String(m._id)) }));
}

async function merge({ into, from, name, by }) {
  const keepId = new mongoose.Types.ObjectId(String(into));
  const fromIds = [...new Set((from || []).map(String))].filter((id) => id !== String(into)).map((id) => new mongoose.Types.ObjectId(id));
  if (!fromIds.length) throw new ErrorHandler('Pick at least one material to merge into it', 400);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const keep = await RawMaterial.findById(keepId).session(session).lean();
      if (!keep || keep.archived) throw new ErrorHandler('The material to keep is not there, or is archived', 404);
      const others = await RawMaterial.find({ _id: { $in: fromIds } }).session(session).lean();
      if (others.length !== fromIds.length || others.some((o) => o.archived)) throw new ErrorHandler('One of the materials to merge is not there, or already archived', 409);
      const units = new Set([keep, ...others].map((m) => (m.unit || 'kg').toLowerCase()));
      if (units.size > 1) throw new ErrorHandler(`They are kept in different units (${[...units].join(', ')}) — merging would add kilograms to cones. Fix the unit first.`, 400);

      const moved = {};
      for (const { model, paths } of referringModels()) {
        for (const p of paths) {
          const { filter, update, options } = moveOp(p, fromIds, keepId);
          const r = await model.updateMany(filter, update, { ...options, session, strict: false, timestamps: false });
          if (r.modifiedCount) moved[`${model.modelName}.${p.path}`] = r.modifiedCount;
        }
      }

      const stockIn = others.reduce((sum, o) => sum + (o.stock || 0), 0);
      const valueIn = others.reduce((sum, o) => sum + (o.stock || 0) * (o.avgCost || o.price || 0), 0);
      const before = keep.stock || 0;
      const total = Math.round((before + stockIn) * 1000) / 1000;
      const set = {
        stock: total,
        totalConsumption: (keep.totalConsumption || 0) + others.reduce((sum, o) => sum + (o.totalConsumption || 0), 0),
        minStock: Math.max(keep.minStock || 0, ...others.map((o) => o.minStock || 0)),
      };
      if (total > 0) set.avgCost = Math.round((((before * (keep.avgCost || keep.price || 0)) + valueIn) / total) * 100) / 100;
      const oldName = keep.name;
      if (name && name.trim()) set.name = name.trim().slice(0, 120);
      const keptName = set.name || keep.name;
      const now = new Date();
      // The movement history is select:false on the model: rows are pushed,
      // never written back whole, so the tail already there is kept.
      await RawMaterial.updateOne({ _id: keep._id }, {
        $set: set,
        ...(stockIn ? { $push: { stockMovements: { date: now, type: 'MERGE_IN', quantity: stockIn, balance: total, reason: `Merged from ${others.map((o) => o.name).join(', ')}`.slice(0, 300) } } } : {}),
      }, { session });
      for (const o of others) {
        const had = o.stock || 0;
        await RawMaterial.updateOne({ _id: o._id }, {
          $set: { archived: true, archivedAt: now, stock: 0, name: `${o.name} (merged into ${keptName})`.slice(0, 200) },
          ...(had ? { $push: { stockMovements: { date: now, type: 'MERGE_OUT', quantity: -had, balance: 0, reason: `Merged into ${keptName}` } } } : {}),
        }, { session });
      }
      keep.name = keptName; keep.stock = total;
      result = { kept: { _id: String(keep._id), name: keep.name, previousName: oldName, stock: keep.stock }, merged: others.map((o) => String(o._id)), moved, by: by ? String(by) : null };
    });
  } finally {
    session.endSession();
  }
  return result;
}

module.exports = { parseYarn, yarnKey, standardName, groups, similarTo, merge, refPaths, moveOp, referringModels };
