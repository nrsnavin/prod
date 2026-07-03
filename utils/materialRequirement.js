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

const Elastic = require("../models/Elastic.js");

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
  const elastics = await Elastic.find({ _id: { $in: elasticIds } })
    .populate("warpSpandex.id")
    .populate("spandexCovering.id")
    .populate("weftYarn.id")
    .populate("warpYarn.id")
    .lean();

  const rawMap = new Map();
  const addMaterial = (material, weightKg) => {
    if (!material || !material._id) return;
    const key = material._id.toString();
    if (!rawMap.has(key)) {
      rawMap.set(key, {
        rawMaterial:    material._id,
        name:           material.name || "Unknown",
        category:       material.category || "",
        requiredWeight: 0,
        inStock:        Number(material.stock) || 0,
        unitPrice:      Number(material.price) || 0,
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
