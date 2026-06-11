const mongoose = require("mongoose");

// ── Warping plan template sub-schemas ──────────────────
// Embedded on the Elastic doc so any Warping created for a job
// containing this elastic can auto-build a WarpingPlan from it.

const PlanSectionSchema = new mongoose.Schema(
  {
    warpYarn: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    ends:      { type: Number, default: 0 },
    maxMeters: { type: Number, default: 0 },
  },
  { _id: false }
);

const PlanBeamSchema = new mongoose.Schema(
  {
    beamNo:       { type: Number },
    totalEnds:    { type: Number, default: 0 },
    sections:     { type: [PlanSectionSchema], default: [] },
    pairedBeamNo: { type: Number, default: null },
  },
  { _id: false }
);

// ── Stock movement ledger (legacy embedded form) ───────────
// Retained as a fallback during the migration window to the
// standalone StockMovement collection. No new rows are written
// here — utils/elasticStock.js writes to StockMovement instead.
// A follow-up PR drops this field once the new collection is
// verified across all environments.
const ElasticMovementSchema = new mongoose.Schema(
  {
    date:     { type: Date, default: Date.now },
    type:     {
      type: String,
      enum: [
        "PACKING_INWARD",
        "PACKING_REVERSE",
        "DC_OUT",
        "DC_CANCEL_RETURN",
        "WASTAGE_OUT",
        "MANUAL_ADJUST",
      ],
      required: true,
    },
    quantity: { type: Number, required: true },
    balance:  { type: Number, required: true },
    refType:  { type: String },
    refId:    { type: mongoose.Types.ObjectId },
    reason:   { type: String },
    by:       { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { _id: true, timestamps: false }
);

// ── Main elastic schema ───────────────────────────
const ElasticSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    weaveType: { type: String, required: true, default: "8" },

    image: { type: String },

    warpSpandex: {
      id:     { type: mongoose.Types.ObjectId, ref: "RawMaterial" },
      ends:   { type: Number },
      weight: { type: Number },
    },

    warpYarn: [
      {
        id:     { type: mongoose.Types.ObjectId, ref: "RawMaterial" },
        ends:   { type: Number },
        type:   { type: String },
        weight: { type: Number },
      },
    ],

    spandexCovering: {
      id:     { type: mongoose.Types.ObjectId, ref: "RawMaterial" },
      weight: { type: Number },
    },

    spandexEnds: { type: Number, required: true },
    yarnEnds:    { type: Number },

    weftYarn: {
      id:     { type: mongoose.Types.ObjectId, ref: "RawMaterial" },
      weight: { type: Number },
    },

    pick:     { type: Number, required: true },
    noOfHook: { type: Number, required: true },
    weight:   { type: Number, required: true },

    testingParameters: {
      width:      { type: Number },
      elongation: { type: Number, required: true, default: 120 },
      recovery:   { type: Number, required: true, default: 90 },
      strech:     { type: String },
    },

    quantityProduced: { type: Number, default: 0 },

    costing: { type: mongoose.Types.ObjectId, ref: "Costing" },

    stock: { type: Number, default: 0 },

    // Low-stock threshold. When stock <= minStock (and minStock > 0)
    // the admin UI flags this elastic as LOW.
    minStock: { type: Number, default: 0 },

    // Units committed to approved orders but not yet dispatched.
    // Available = stock − reservedStock. Maintained by the order
    // reservation routes (PR B) and consumed first when a DC is
    // dispatched against the same order.
    reservedStock: { type: Number, default: 0 },

    // Soft-delete. Archived elastics are excluded from list /
    // stock-summary by default (filter `archived: { $ne: true }`
    // so legacy docs without the key behave as active). History,
    // ledger rows and references stay intact — this is a display
    // filter, not a deletion.
    archived:   { type: Boolean, default: false, index: true },
    archivedAt: { type: Date },

    // Legacy embedded ledger — kept read-only during the migration
    // window. Writers use StockMovement (the standalone collection)
    // via utils/elasticStock.js. Removed in a follow-up PR.
    stockMovements: {
      type: [ElasticMovementSchema],
      default: [],
    },

    status: { type: mongoose.Types.ObjectId, ref: "Order" },

    // ── WARPING PLAN TEMPLATE ──────────────────
    // Optional. Auto-used when Warping is created for a job
    // that includes this elastic.
    warpingPlanTemplate: {
      noOfBeams: { type: Number },
      beams:     { type: [PlanBeamSchema], default: undefined },
    },
  },
  { timestamps: true }
);

const Elastic = mongoose.model("Elastic", ElasticSchema);
module.exports = Elastic;
