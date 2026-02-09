const RawMaterial = require("../models/RawMaterial");

/**
 * Calculate costing for an Elastic
 */
async function calculateElasticCosting(elasticData) {
  let materialCost = 0;
  const details = [];

  const addMaterialCost = async ({
    materialId,
    quantity, // in grams
    description,
  }) => {
    if (!materialId || !quantity || quantity <= 0) return;

    const material = await RawMaterial.findById(materialId);
    if (!material) throw new Error("Raw material not found");

    const cost = (material.price * quantity) / 1000;

    materialCost += cost;

    details.push({
      type: "material",
      reference: material._id,
      description,
      quantity,
      rate: material.price,
      cost,
    });
  };

  // 🧵 Warp Spandex
  await addMaterialCost({
    materialId: elasticData.warpSpandex.id,
    quantity: elasticData.warpSpandex.weight,
    description: "Warp Spandex",
  });

  // 🧵 Spandex Covering
  await addMaterialCost({
    materialId: elasticData.spandexCovering.id,
    quantity: elasticData.spandexCovering.weight,
    description: "Spandex Covering",
  });

  // 🧶 Weft Yarn
  await addMaterialCost({
    materialId: elasticData.weftYarn.id,
    quantity: elasticData.weftYarn.weight,
    description: "Weft Yarn",
  });

  // 🧶 Warp Yarns (Multiple)
  for (const w of elasticData.warpYarn || []) {
    await addMaterialCost({
      materialId: w.id,
      quantity: w.weight,
      description: "Warp Yarn",
    });
  }

  return {
    materialCost,
    details,
  };
}

module.exports = { calculateElasticCosting };
