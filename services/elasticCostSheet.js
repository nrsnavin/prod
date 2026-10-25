'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN ELASTIC'S COST SHEET — what each material costs in a metre
//
//  Cost a metre = Σ (material price ₹/kg × grams a metre / 1000)
//               + conversion cost.
//
//  The elastic page showed only the totals. This lays out every line of
//  the recipe with the material's price TODAY, what it costs in a metre,
//  and the price the last costing used — so a price that moved since
//  then is visible, and the total the elastic carries can be seen to be
//  out of date before anyone quotes from it.
//
//  Read here; written through api/elastic.js (POST /:id/cost-sheet),
//  which changes material prices and re-costs with the same
//  calculation every other costing uses (utils/elasticCosting.js).
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const Elastic = require('../models/Elastic');
const RawMaterial = require('../models/RawMaterial');
const Costing = require('../models/Costing');

const DEFAULT_CONVERSION = 1.25;
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

/** The recipe's lines in the order the costing walks them. */
function recipeLines(elastic) {
  const lines = [];
  const add = (role, slot) => {
    if (!slot?.id) return;
    lines.push({ role, materialId: String(slot.id._id ?? slot.id), grams: Number(slot.weight) || 0 });
  };
  add('Warp spandex', elastic.warpSpandex);
  add('Spandex covering', elastic.spandexCovering);
  add('Weft yarn', elastic.weftYarn);
  (elastic.warpYarn || []).forEach((w, i) => add(`Warp yarn ${i + 1}`, w));
  return lines;
}

/** Every material id the elastic's recipe names, once each. */
function recipeMaterialIds(elastic) {
  return [...new Set(recipeLines(elastic).map((l) => l.materialId))];
}

/** Elastics other than this one, still in use, whose recipe names `materialId`. */
function usingMaterial(materialId, exceptId) {
  const id = new mongoose.Types.ObjectId(String(materialId));
  return {
    _id: { $ne: exceptId },
    archived: { $ne: true },
    $or: [{ 'warpSpandex.id': id }, { 'spandexCovering.id': id }, { 'weftYarn.id': id }, { 'warpYarn.id': id }],
  };
}

/**
 * The sheet for one elastic, or null when there is no such elastic.
 *
 * lines[]   one per recipe slot: role, material, grams a metre, today's
 *           price ₹/kg, cost ₹ a metre, the price the last costing used
 * now       material + conversion + total at today's prices
 * costed    what the elastic carries now (its Costing), and when
 * stale     the two differ — a price moved, or the recipe changed
 */
async function buildCostSheet(elasticId) {
  if (!mongoose.isValidObjectId(String(elasticId))) return null;
  const elastic = await Elastic.findById(elasticId).lean();
  if (!elastic) return null;

  const lines = recipeLines(elastic);
  const ids = [...new Set(lines.map((l) => l.materialId))].filter((x) => mongoose.isValidObjectId(x));
  const [materials, costing] = await Promise.all([
    RawMaterial.find({ _id: { $in: ids } }).select('name category unit price').lean(),
    elastic.costing ? Costing.findById(elastic.costing).lean() : null,
  ]);
  const byId = new Map(materials.map((m) => [String(m._id), m]));

  // The last costing's lines, matched to the recipe by material and
  // role. A slot with no weight was never costed and has no line.
  const costedLines = (costing?.details || []).map((d) => ({ ...d, used: false }));
  const costedRateFor = (materialId, role) => {
    const baseRole = role.replace(/ \d+$/, '').toLowerCase();
    const hit = costedLines.find((d) => !d.used && String(d.reference) === materialId
      && String(d.description || '').toLowerCase() === baseRole)
      || costedLines.find((d) => !d.used && String(d.reference) === materialId);
    if (!hit) return null;
    hit.used = true;
    return Number(hit.rate);
  };

  const sharedWith = {};
  await Promise.all(ids.map(async (id) => {
    sharedWith[id] = await Elastic.countDocuments(usingMaterial(id, elastic._id));
  }));

  let materialCost = 0;
  let missing = 0;
  const out = lines.map((l) => {
    const m = byId.get(l.materialId);
    const price = m ? Number(m.price) || 0 : null;
    const cost = price != null ? (price * l.grams) / 1000 : null;
    if (cost != null) materialCost += cost;
    else missing += 1;
    const costedRate = l.grams > 0 ? costedRateFor(l.materialId, l.role) : null;
    return {
      role: l.role,
      material: m
        ? { id: l.materialId, name: m.name, category: m.category || '', unit: m.unit || 'kg' }
        : { id: l.materialId, name: 'Material not found', category: '', unit: 'kg' },
      found: !!m,
      grams: l.grams,
      price,
      cost: cost != null ? round4(cost) : null,
      costedRate: Number.isFinite(costedRate) ? costedRate : null,
      priceChanged: Number.isFinite(costedRate) && price != null && Math.abs(costedRate - price) > 1e-9,
      sharedWith: sharedWith[l.materialId] ?? 0,
    };
  });

  const conversionCost = Number.isFinite(Number(costing?.conversionCost)) ? Number(costing.conversionCost) : DEFAULT_CONVERSION;
  const now = {
    materialCost: round4(materialCost),
    conversionCost,
    totalCost: round4(materialCost + conversionCost),
  };
  const costed = costing
    ? { materialCost: costing.materialCost ?? null, conversionCost: costing.conversionCost ?? null, totalCost: costing.totalCost ?? null, at: costing.date || costing.updatedAt || null }
    : null;

  return {
    elasticId: String(elastic._id),
    name: elastic.name,
    lines: out,
    now,
    costed,
    missing,
    // Rounded to the paisa, as every screen shows it.
    stale: !costed || round2(Number(costed.totalCost) || 0) !== round2(now.totalCost),
  };
}

module.exports = { buildCostSheet, recipeMaterialIds, usingMaterial, DEFAULT_CONVERSION };
