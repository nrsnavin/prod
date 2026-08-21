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
const mongoose      = require("mongoose");
const RawMaterial   = require("../models/RawMaterial.js");
const PurchaseOrder = require("../models/PurchaseOrder.js");
const YarnLot       = require("../models/YarnLot.js");
const { isLotTracked } = require("./materialCategories.js");
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

  // Matched as BOTH an ObjectId and a string.
  //
  // A purchase order line whose `rawMaterial` was stored as a string —
  // which some rows are, from imports and raw writes that never went
  // through the schema's casting — is invisible to an $in of ObjectIds.
  // Nothing errors; the material simply never appears in the result and
  // the On order column reads blank beside a real shortfall.
  //
  // That is the worst possible way for this to fail: a shortfall with
  // no "on order" next to it looks unbought, and the response is to
  // raise the purchase order again. The yarn arrives twice and the
  // money goes out twice — the exact outcome this function exists to
  // prevent. So both forms are queried, and the result is keyed on the
  // string either way.
  const wanted = [];
  for (const id of materialIds) {
    if (!id) continue;
    const asString = String(id);
    wanted.push(asString);
    if (mongoose.Types.ObjectId.isValid(asString)) {
      wanted.push(new mongoose.Types.ObjectId(asString));
    }
  }
  if (!wanted.length) return new Map();

  // Through the raw collection, not the model.
  //
  // Mongoose casts a query against a typed path, so the mixed array
  // above would be turned straight back into ObjectIds and the string
  // rows lost again. The driver does not cast, which is the entire
  // point here.
  const pos = await PurchaseOrder.collection
    .find(
      {
        // A cancelled PO owes nothing, and a completed one has arrived.
        // $nin also matches a document with no status at all, which is
        // what the oldest rows look like.
        status: { $nin: ["Cancelled", "Completed"] },
        "items.rawMaterial": { $in: wanted },
      },
      { projection: { items: 1 } }
    )
    .toArray();

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

/**
 * The dye lots standing behind each material on the sheet.
 *
 * ── Two different facts, and the sheet says which ────────────────
 * A job's warping programme usually names the lot each beam section
 * will run off — the choice is made at programming time, because two
 * lots meeting inside one beam show as a shade band. That is a
 * COMMITMENT, and it is a far better answer than anything this
 * function could work out. It is passed in by the caller (only the
 * job MRP has a programme to read) and marked `committed: true`.
 *
 * Everything else is what is simply AVAILABLE: open lots with
 * something left, oldest first, because the oldest is the one the
 * floor should be using up and the one to look at when a shade
 * complaint arrives.
 *
 * The two are never merged into one list without the flag. "This yarn
 * will come off D-4471" and "there are three lots you could use" are
 * different sentences, and a sheet that printed them the same way
 * would have an operator warping off the wrong bag.
 *
 * ── Only for the materials it means anything for ─────────────────
 * Non-warp materials are skipped: nothing in the system ever chooses
 * a lot for them, so listing their lots on a requirement sheet would
 * be filling a column because it exists.
 *
 * @param {Array}  rows           the MRP rows, needing `rawMaterial` + `category`
 * @param {Map}    committedByMat materialId → [{ lotNo, shade, yarnLot }]
 * @returns {Promise<Map<string, Array>>} materialId → lot rows
 */
async function lotsForMaterials(rows = [], committedByMat = new Map()) {
  const trackedIds = rows
    .filter((r) => isLotTracked(r.category))
    .map((r) => String(r.rawMaterial))
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const out = new Map();
  if (!trackedIds.length) return out;

  // Virtuals are needed for `balance` and `ageDays`, so not .lean().
  const lots = await YarnLot.find({
    rawMaterial: { $in: trackedIds },
    status: "open",
  }).sort({ receivedDate: 1 });

  for (const id of trackedIds) {
    const committed = committedByMat.get(id) || [];
    const seen = new Set();
    const list = [];

    for (const c of committed) {
      const key = String(c.yarnLot || c.lotNo || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      list.push({
        yarnLot: c.yarnLot || null,
        lotNo: c.lotNo || "",
        shade: c.shade || "",
        // A committed lot may be quarantined, exhausted or gone since
        // it was named. Balance is filled in below from the open lots
        // when it is still one of them, and left null when it is not —
        // which is itself worth seeing on the sheet.
        balance: null,
        ageDays: null,
        committed: true,
        // WHICH commitment. Two different decisions arrive as
        // `committed` and the sheet has to be able to tell them apart:
        //
        //   order      the order earmarked this bag when it was
        //              approved — a claim on the yarn, made before any
        //              beam existed;
        //   programme  the warping plan chose it for a beam section,
        //              which is a decision about where in the cloth it
        //              goes.
        //
        // They usually agree. When they do not, that disagreement is
        // the single most useful thing this column can show, so it is
        // not flattened.
        source: c.source || "programme",
        // Kg the order set aside, when the commitment came from there.
        quantity: c.quantity != null ? Number(c.quantity) : null,
      });
    }

    for (const lot of lots) {
      if (String(lot.rawMaterial) !== id) continue;
      if (lot.balance <= 0) continue;

      const already = list.find(
        (l) => (l.yarnLot && String(l.yarnLot) === String(lot._id)) || l.lotNo === lot.lotNo
      );
      if (already) {
        already.balance = lot.balance;
        already.ageDays = lot.ageDays;
        continue;
      }
      list.push({
        yarnLot: String(lot._id),
        lotNo: lot.lotNo || "",
        shade: lot.shade || "",
        balance: lot.balance,
        ageDays: lot.ageDays,
        committed: false,
        source: "available",
        quantity: null,
      });
    }

    if (list.length) out.set(id, list);
  }
  return out;
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

  // Which dye lots stand behind each material. Only the job MRP has a
  // warping programme to read commitments from, so `committedLots` is
  // optional and every other caller gets the available lots alone.
  const lotsByMaterial = await lotsForMaterials(
    Array.from(rawMap.values()),
    toMap(opts.committedLots)
  );

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

    // ── Named lotOptions, not lots, and that matters ───────────────
    // api/job.js assigns this whole result onto
    // `order.rawMaterialRequired`, relying on Mongoose to keep the
    // paths it knows and drop the rest. That is safe for every extra
    // field EXCEPT one the schema also has.
    //
    // `Order.rawMaterialRequired[].lots` is the order's EARMARKS —
    // bags promised to it, where quantity is required and means kilos.
    // These are display rows for a sheet: one per lot that could be
    // used, with a null quantity on the merely available ones. Calling
    // them both `lots` made the assignment throw
    // ("lots.0.quantity: Path `quantity` is required") and, where it
    // cast, silently replace a promise with a list of candidates.
    //
    // The rename is what makes that impossible rather than fixed once.
    // See tests/utils/requirementIntoOrder.test.js.
    //
    // Always an array, so the sheet never has to guard a null — an
    // empty one means "no lots", which the UI renders as such rather
    // than as a missing field.
    const lotOptions = lotsByMaterial.get(key) || [];

    return {
      ...m, requiredWeight, allocated, outstanding, shortfall, onOrder, toBuy,
      lotOptions,
    };
  });
}

const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/** Accept a Map or a plain object for the allocated quantities. */
function toMap(allocated) {
  if (allocated instanceof Map) return allocated;
  if (allocated && typeof allocated === 'object') return new Map(Object.entries(allocated));
  return new Map();
}

module.exports = { computeMaterialRequirement, onOrderByMaterial, lotsForMaterials };
