'use strict';
//
// Material Requirement computation from the elastic BOM.
//
// Given a list of { elastic, quantity } lines (metres), roll up the
// raw materials each elastic consumes and the total weight (kg)
// required. This is the same formula the order-approval flow uses in
// api/order.js `computeRawMaterialRequired`; extracted here so the
// Job-Order MRP sheet can reuse it without importing the order router.
//
// BOM source (models/Elastic.js): each elastic references RawMaterial
// docs with a per-metre `weight` in GRAMS:
//   warpSpandex.{id,weight}
//   spandexCovering.{id,weight}
//   weftYarn.{id,weight}
//   warpYarn[].{id,weight}
// Required kg = Σ (weight_grams × metres) / 1000.

const Elastic     = require("../models/Elastic.js");
const RawMaterial = require("../models/RawMaterial.js");

// lines: [{ elastic: ObjectId|string, quantity: Number(metres) }]
// Returns: [{ rawMaterial, name, category, requiredWeight, inStock,
//             shortfall, unitPrice }]
async function computeMaterialRequirement(lines = []) {
  const cleanLines = (lines || [])
    .map((l) => ({
      elastic:  l.elastic?._id || l.elastic,
      quantity: Number(l.quantity) || 0,
    }))
    .filter((l) => l.elastic && l.quantity > 0);

  if (cleanLines.length === 0) return [];

  const elasticIds = cleanLines.map((l) => l.elastic);
  // Deliberately NOT populated: populate replaces a dangling reference with
  // null, which loses the id and made deleted materials disappear from the
  // sheet entirely. Read the raw refs, then resolve them ourselves so a
  // missing material can still be reported.
  const elastics = await Elastic.find({ _id: { $in: elasticIds } }).lean();

  const refIds = [];
  const pushRef = (r) => { if (r) refIds.push(String(r)); };
  for (const e of elastics) {
    pushRef(e.warpSpandex?.id);
    pushRef(e.spandexCovering?.id);
    pushRef(e.weftYarn?.id);
    for (const wy of e.warpYarn || []) pushRef(wy.id);
  }
  const materials = refIds.length
    ? await RawMaterial.find({ _id: { $in: [...new Set(refIds)] } })
        .select("name category stock price").lean()
    : [];
  const matById = new Map(materials.map((m) => [String(m._id), m]));

  const rawMap = new Map();
  // Takes the REFERENCE id, not a populated doc, so a material that no
  // longer exists still produces a row (flagged) instead of vanishing and
  // silently under-reporting the requirement.
  const addMaterial = (refId, weightKg) => {
    if (!refId) return;
    const key = String(refId);
    if (!rawMap.has(key)) {
      const m = matById.get(key);
      rawMap.set(key, {
        rawMaterial:    refId,
        name:           m?.name ?? "Unknown material (deleted?)",
        category:       m?.category || "",
        requiredWeight: 0,
        // Always a number, so the UI never has to render a blank cell.
        inStock:        Number(m?.stock) || 0,
        unitPrice:      Number(m?.price) || 0,
        // false when the material could not be resolved — the stock figure
        // is a placeholder, not a real reading.
        stockKnown:     !!m,
      });
    }
    rawMap.get(key).requiredWeight += weightKg;
  };

  for (const line of cleanLines) {
    const elastic = elastics.find((e) => e._id.toString() === String(line.elastic));
    if (!elastic) continue;
    const qty = line.quantity;

    if (elastic.warpSpandex?.id)
      addMaterial(elastic.warpSpandex.id, (Number(elastic.warpSpandex.weight) || 0) * qty / 1000);
    if (elastic.spandexCovering?.id)
      addMaterial(elastic.spandexCovering.id, (Number(elastic.spandexCovering.weight) || 0) * qty / 1000);
    if (elastic.weftYarn?.id)
      addMaterial(elastic.weftYarn.id, (Number(elastic.weftYarn.weight) || 0) * qty / 1000);
    for (const wy of elastic.warpYarn || []) {
      if (wy.id) addMaterial(wy.id, (Number(wy.weight) || 0) * qty / 1000);
    }
  }

  // Finalise derived fields (round weight to 3 dp; compute shortfall).
  return Array.from(rawMap.values()).map((m) => {
    const requiredWeight = Math.round(m.requiredWeight * 1000) / 1000;
    const shortfall = Math.max(0, Math.round((requiredWeight - m.inStock) * 1000) / 1000);
    return { ...m, requiredWeight, shortfall };
  });
}

module.exports = { computeMaterialRequirement };
