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

const Elastic       = require("../models/Elastic.js");
const RawMaterial   = require("../models/RawMaterial.js");
const PurchaseOrder = require("../models/PurchaseOrder.js");
// Required for its side effect: populating `supplier` below needs the
// model registered, and this module is loaded by callers (the MRP unit
// tests among them) that have no other reason to pull Supplier in.
require("../models/Supplier.js");

/**
 * How much of each material is bought but not yet delivered.
 *
 * Without this a shortfall reads as unbought, and the natural response
 * to it is to raise the purchase order again — so the yarn arrives
 * twice and the money goes out twice.
 *
 * It is reported BESIDE the shortfall and never netted off it. Stock on
 * order is not stock in the building: subtracting it would report a
 * material as covered while the machine has nothing to run.
 *
 * @returns {Promise<Map<string, number>>} material id → quantity due
 */
async function onOrderByMaterial(materialIds = []) {
  if (!materialIds.length) return new Map();

  const pos = await PurchaseOrder.find({
    // A cancelled PO owes nothing, and a completed one has arrived.
    status: { $nin: ["Cancelled", "Completed"] },
    "items.rawMaterial": { $in: materialIds },
  }).select("items").lean();

  const due = new Map();
  for (const po of pos) {
    for (const item of po.items || []) {
      const key = String(item.rawMaterial ?? "");
      if (!key) continue;
      // What is left on the line, not the whole line — a part-received
      // order still owes only the remainder.
      const outstanding = (Number(item.quantity) || 0) - (Number(item.receivedQuantity) || 0);
      if (outstanding > 0) due.set(key, (due.get(key) || 0) + outstanding);
    }
  }
  return due;
}

// lines: [{ elastic: ObjectId|string, quantity: Number(metres) }]
//
// opts.allocated — Map|object of material id → kg ALREADY drawn from
//   stock for whatever this sheet is about. Approving an order takes
//   its material out of stock immediately, so from that moment the
//   requirement is part-met and `inStock` no longer contains it;
//   comparing the full requirement against that reduced balance
//   reported the order as short of yarn it was already standing on.
//   Omitted means nothing has been drawn, which is the truth before
//   approval and keeps every other caller reading as it did.
//
// Returns: [{ rawMaterial, name, category, requiredWeight, allocated,
//             outstanding, inStock, onOrder, shortfall, toBuy,
//             unitPrice }]
async function computeMaterialRequirement(lines = [], opts = {}) {
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
        // supplier comes along so a shortfall can be turned straight into
        // a purchase order without a second round of lookups.
        .select("name category stock price supplier")
        .populate("supplier", "name")
        .lean()
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
        supplierId:     m?.supplier?._id ? String(m.supplier._id) : null,
        supplierName:   m?.supplier?.name || "",
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

  const due = await onOrderByMaterial(
    Array.from(rawMap.values()).map((m) => m.rawMaterial)
  );

  const allocatedMap = toMap(opts.allocated);

  // Finalise derived fields (round weight to 3 dp; compute shortfall).
  return Array.from(rawMap.values()).map((m) => {
    const key = String(m.rawMaterial);
    const requiredWeight = round3(m.requiredWeight);
    // Never more than the requirement: a draw larger than what this
    // sheet asks for belongs to something else on the same order.
    const allocated = round3(Math.min(requiredWeight, Math.max(0, allocatedMap.get(key) || 0)));
    // What still has to come out of stock. This — not the gross
    // requirement — is the quantity `inStock` has yet to cover.
    const outstanding = round3(Math.max(0, requiredWeight - allocated));

    // Against stock alone. See onOrderByMaterial for why what is on
    // order is shown next to this rather than folded into it.
    const shortfall = Math.max(0, round3(outstanding - m.inStock));
    const onOrder = round3(due.get(key) || 0);
    // What buying should actually cover. A shortfall that has already
    // been purchased is waiting on delivery, not on a second purchase
    // order — the yarn is bought, and buying it again is money out
    // twice for goods nobody ordered.
    const toBuy = Math.max(0, round3(shortfall - onOrder));

    return { ...m, requiredWeight, allocated, outstanding, shortfall, onOrder, toBuy };
  });
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Accept a Map or a plain object for the allocated quantities. */
function toMap(allocated) {
  if (allocated instanceof Map) return allocated;
  if (allocated && typeof allocated === 'object') return new Map(Object.entries(allocated));
  return new Map();
}

module.exports = { computeMaterialRequirement, onOrderByMaterial };
