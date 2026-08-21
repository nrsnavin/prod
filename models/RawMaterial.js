// models/RawMaterial.js
const mongoose = require("mongoose");

// ── Price history entry ───────────────────────────────────────
// Appended every time the price field is changed (via edit or
// bulk-update). Gives a full audit trail of price changes.
const PriceHistorySchema = new mongoose.Schema(
  {
    price:     { type: Number, required: true },   // new price
    oldPrice:  { type: Number, required: true },   // previous price
    changedAt: { type: Date,   default: Date.now },
    reason:    { type: String, default: "" },       // e.g. "Bulk update Mar 2026"
  },
  { _id: false }
);

// ── Running stock movement ────────────────────────────────────
const StockMovementSchema = new mongoose.Schema(
  {
    date:     { type: Date,   required: true },
    type:     { type: String, required: true }, // ORDER_APPROVAL | PO_INWARD | STOCK_ADJUST | ORDER_CANCEL_REFUND
    order:    { type: mongoose.Types.ObjectId, ref: "Order" },

    // ── Why this row exists ──────────────────────────────────────────
    // A ledger that says "-40" and nothing else cannot be audited. The
    // type says what kind of movement it was; these say which document
    // caused it and, where a person typed one, the reason they gave.
    //
    // `order` above is ref:"Order" and a receipt is caused by a PURCHASE
    // order, so PO receipts had nowhere to record their cause and were
    // deliberately written with no reference at all — the ledger's
    // reference column was blank for every goods receipt ever made.
    purchaseOrder: { type: mongoose.Types.ObjectId, ref: "PurchaseOrder" },

    // Snapshot of the human-facing number ("1042", "55"). Kept beside
    // the reference for the same reason the warping programme snapshots
    // its lot numbers: the ledger has to still read correctly years
    // later, when the order or PO may have been deleted. Without it,
    // deleting a document silently blanks its history.
    refNo:  { type: String, trim: true, default: "" },

    // What the person doing it said. Only manual adjustments have one —
    // the rest are explained by the document they point at.
    reason: { type: String, trim: true, default: "" },

    // What actually happened to stock — the delta the balance below
    // moved by. A row where `quantity` and `balance` disagree with the
    // row before it is a ledger that cannot be reconciled, which is the
    // one thing a ledger has to be.
    quantity: { type: Number, required: true },
    balance:  { type: Number },

    // What was asked for, when it differs from what was applied.
    //
    // Stock floors at zero, so a write-off of 50 against 30 on hand
    // moves 30 — and the row used to record the 50, leaving a ledger
    // whose arithmetic did not close. Now `quantity` is always the
    // applied figure and this says what the person actually typed, so
    // the gap is visible rather than baked into the numbers.
    //
    // Absent on the ordinary case where nothing was clamped.
    requested: { type: Number },

    // What one unit was worth when it moved (utils/materialValuation).
    // Snapshotted, not looked up later: the whole point of a weighted
    // average is that it changes, so a movement priced at today's
    // average is priced wrong.
    unitCost: { type: Number },

    // ── Which dye lot ───────────────────────────────────────────────
    // Set by the writers that KNOW — a warping batch draws named lots
    // off the rack, so BATCH_ISSUE and BATCH_RETURN stamp the lot here
    // and it is a record, not a reading.
    //
    // Left empty on every other type, including the receipts and
    // adjustments that did record a lot on their own document. Those
    // are attributed at read time from MaterialInward / MaterialOut by
    // services/lotAttribution.js, so nothing has to be backfilled and
    // the two can never disagree. See that file for the three kinds of
    // answer and why they are kept apart.
    yarnLot: { type: mongoose.Types.ObjectId, ref: "YarnLot" },
    lotNo:   { type: String, trim: true, default: "" },

    // ── How much left the RACK, when that is not how much left STOCK ─
    // A warping batch draws yarn physically and deliberately does not
    // move `stock` — that was debited earlier, at order approval, and
    // debiting it again would take the same yarn out twice. See the
    // long note at the top of models/YarnLot.js.
    //
    // So a batch row's `quantity` is 0, which is the truth about its
    // effect on the balance, and the kilos actually drawn live here.
    // They MUST stay apart: normaliseMovements rebuilds missing
    // balances by walking backwards subtracting `quantity`, so a batch
    // row carrying its draw in that field would subtract yarn the
    // balance never lost and silently restate every older row on the
    // page. That failure looks like plausible numbers, not an error.
    lotQuantity: { type: Number },
  },
  { _id: false }
);

const RawMaterialSchema = new mongoose.Schema(
  {
    name:     { type: String, required: true },

    // ── Two independent classifications ────────────────────────────
    //
    // These used to be one thing wearing two hats: `category` held the
    // GROUP'S NAME, and renaming a group rewrote it on every member.
    // That made the mill's own groups and the system's vocabulary the
    // same field, so adding a group called "Trim Tape" put a value into
    // `category` that the elastic recipe picker, the MRP sheet and the
    // phone's colour chips had never heard of — and renaming a group
    // silently restated eighty materials.
    //
    // They are now separate, because they answer separate questions:
    //
    //   category — WHAT THE SYSTEM NEEDS TO KNOW. warp / weft /
    //              covering / Rubber / Chemicals, and nothing else.
    //              This is the vocabulary the recipe pickers, the MRP
    //              sheet and the forecast are written in. It is fixed:
    //              a new value here is a code change, because code
    //              would have to learn what to do with it.
    //
    //   group    — WHAT THE MILL WANTS TO TRACK. Free, admin-managed,
    //              as many as they like, renameable at will. Nothing
    //              in the engine branches on it; it exists for
    //              filtering, colour and reporting.
    //
    // The schema deliberately does NOT enum `category`. Live rows
    // written under the old scheme hold group names, and an enum would
    // make every one of them unsaveable the moment somebody edited an
    // unrelated field. The WRITE ROUTES validate against
    // MATERIAL_CATEGORIES instead, so new and edited data converges
    // while old data keeps loading. See api/rawMaterial.js.
    category: { type: String, required: true },

    // The mill's own classification. Optional and always was —
    // a material can exist before anyone has filed it.
    group: {
      type: mongoose.Types.ObjectId,
      ref: 'MaterialGroup',
      default: null,
      index: true,
    },

    // ── Unit of measure ────────────────────────────────────────────
    // api/rawMaterial.js has been reading `m.unit || ""` since long
    // before this field existed, so every unit it returned was the
    // empty string. Defaulted to kg because that is what every yarn and
    // every price in this system is already denominated in — `price` is
    // documented as per kg, and materialValuation costs against it.
    unit: { type: String, default: 'kg', trim: true },

    // Per-material override of the supplier's lead time. A dyed yarn
    // from the same supplier as a greige one takes longer, and the
    // difference belongs to the material rather than to the vendor.
    // Null (not 0) means "use the supplier's" — 0 is a real answer
    // meaning same-day, and the two must not read alike.
    leadTimeDays: { type: Number, default: null, min: 0 },

    supplier: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      default:"697e40c4e79c50e10e17ab61"
    },

    // min: 0 — schema-level floor so a stray negative from a missed
    // route validation can never persist into money / stock math.
    price:    { type: Number, default: 0, min: 0 },  // per kg — current price

    // ── What the stock on the shelf actually cost ──────────────────
    // `price` above is the LATEST purchase price. It is what a new PO
    // should default to, and it is what everything used to be costed
    // at — which meant buying 100 kg at ₹300 and then 100 kg at ₹360
    // instantly revalued all 200 kg at ₹360, over-stating consumption
    // and under-stating margin every time a supplier moved their quote.
    //
    // This is the weighted average of what the stock on hand cost, and
    // it is what issues are priced at. Moved only by a receipt; see
    // utils/materialValuation.js for the arithmetic and the reasoning
    // behind weighted average rather than FIFO.
    //
    // 0 means "never received since averaging existed" — readers fall
    // back to `price` for those, which is what they were using anyway.
    avgCost:  { type: Number, default: 0, min: 0 },

    stock:            { type: Number, default: 0, min: 0 },
    minStock:         { type: Number, default: 0, min: 0 },

    totalConsumption: { type: Number, default: 0, min: 0 },

    // ── Soft delete ────────────────────────────────────────────────
    // A material named by an order requirement, a PO line, a goods
    // receipt or an elastic's recipe cannot be deleted without
    // orphaning all of them — the documents survive, pointing at
    // nothing, and every screen that reads them renders a blank where
    // a yarn name should be. So a used material is archived instead:
    // excluded from the pickers so nobody chooses it again, while
    // every existing reference still resolves.
    //
    // Filter with `{ archived: { $ne: true } }`, never
    // `{ archived: false }` — rows written before this field existed
    // have no value at all and must behave as active. Mirrors
    // Elastic.archived and Customer.archived, deliberately: three soft
    // deletes that behave differently are three things to remember.
    archived:   { type: Boolean, default: false, index: true },
    archivedAt: { type: Date },

    // ── Price history (appended on every price change) ────────
    priceHistory: {
      type: [PriceHistorySchema],
      default: [],
    },

    // ── Running balance log (last 50 entries) ─────────────────
    stockMovements: {
      type: [StockMovementSchema],
      default: [],
      // Excluded from every query unless asked for with select("+stockMovements").
      // Mongo cannot return part of a document, so without this a list of 40
      // materials drags 40 full movement histories across the wire — and the
      // MRP, forecast and category pickers all list every material.
      select: false,
    },
  },
  { timestamps: true }
);

// ── Indexes ─────────────────────────────────────────────────────────
// Materials are looked up by name (search, import matching) and grouped by
// category (warp/weft/covering pickers on the MRP and job forms).
RawMaterialSchema.index({ name: 1 });
RawMaterialSchema.index({ category: 1, name: 1 });

/**
 * Cap on the embedded stockMovements ledger.
 *
 * This array is append-only and was unbounded: every order approval, cancel
 * refund, inward and outward pushed a row onto the material document, so a
 * material used by every order grew forever. Two problems, and the second
 * arrives long before the first:
 *
 *   1. It marches toward MongoDB's 16 MB per-document limit, after which
 *      every write to that material fails — including ones that have
 *      nothing to do with stock.
 *   2. Mongo has no way to read "part of" a document, so every load of the
 *      material drags the whole history with it, and the whole document is
 *      rewritten on each append.
 *
 * The authoritative history lives in the MaterialInward / MaterialOutward
 * collections — which is what the stock-movements report actually reads —
 * so this array is a convenience tail, not a system of record. The detail
 * endpoint already only ever displays the newest 50.
 */
const MAX_EMBEDDED_MOVEMENTS = 500;

RawMaterialSchema.pre("save", function trimStockMovements(next) {
  const moves = this.stockMovements;
  if (Array.isArray(moves) && moves.length > MAX_EMBEDDED_MOVEMENTS) {
    // Keep the newest; entries are appended in chronological order.
    this.stockMovements = moves.slice(-MAX_EMBEDDED_MOVEMENTS);
  }
  next();
});

const RawMaterial = mongoose.model("RawMaterial", RawMaterialSchema);

module.exports = RawMaterial;
module.exports.MAX_EMBEDDED_MOVEMENTS = MAX_EMBEDDED_MOVEMENTS;

// The vocabulary lives in utils/materialCategories.js — a frozen
// array and a string comparison are not model behaviour, and putting
// them here made them vanish under jest.mock(). Re-exported so a
// caller that already has the model does not need a second require.
const materialCategories = require("../utils/materialCategories");

module.exports.MATERIAL_CATEGORIES = materialCategories.MATERIAL_CATEGORIES;
module.exports.MATERIAL_POSITIONS  = materialCategories.MATERIAL_POSITIONS;
module.exports.canonicalCategory   = materialCategories.canonicalCategory;
