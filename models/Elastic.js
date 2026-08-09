const mongoose = require("mongoose");
const { elasticNameKey } = require("../utils/elasticName.js");

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
    // Stored exactly as typed — the operator chose that capitalisation
    // and it goes on the programme sheet. Only the ends are trimmed,
    // because a trailing space is never intentional and it is the
    // easiest way to smuggle a second copy of a product past a check.
    name: { type: String, required: true, trim: true },

    // What "the same elastic" means, derived from `name` on every save
    // (see the hook below and utils/elasticName.js). Case-folded and
    // whitespace-collapsed, so "Newday Romeo Black" cannot join
    // "NEWDAY  ROMEO BLACK" in the catalogue as a separate product.
    //
    // The unique index on this is declared below and built by mongoose
    // at startup rather than by a migration — see the note there.
    nameKey: { type: String },

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

// Derived, never supplied. A hook rather than a line in each route
// because every write goes through save() — create-elastic, the demo
// seeder, and anything added later — and a route that forgot to set it
// would write a row the uniqueness check cannot see.
ElasticSchema.pre("validate", function deriveNameKey(next) {
  // The `undefined` arm self-heals a row written before any of this
  // existed: the first save after the upgrade derives its key without
  // needing the backfill to have run.
  if (this.isModified("name") || this.nameKey === undefined) {
    this.nameKey = elasticNameKey(this.name);
  }
  next();
});

// The same invariant for the update pipeline, which does not run
// document hooks. Nothing renames an elastic this way today; the point
// is that if something ever does, it cannot leave a stale key behind —
// and a stale key is worse than no key, because it holds the OLD name
// reserved while leaving the new one free.
ElasticSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"],
  function syncNameKey(next) {
    const u = this.getUpdate();
    if (!u) return next();
    const name = u.name ?? u.$set?.name;
    if (name === undefined) return next();
    this.set("nameKey", elasticNameKey(name));
    next();
  });

// The constraint under the API's own duplicate check. It lives here,
// not in a migration: an index created at the end of the migration
// chain does not return — the command never reaches an idle database —
// and a step that can stall `npm start` is worse than no index. Built
// by autoIndex at startup instead, where a failure is recoverable and
// gets retried on the next boot.
//
// sparse, because an elastic with no name has no key, and several of
// those must not collide with each other.
ElasticSchema.index(
  { nameKey: 1 },
  { unique: true, sparse: true, name: "elastic_nameKey_unique" }
);

const Elastic = mongoose.model("Elastic", ElasticSchema);

// On a catalogue that still holds duplicates, that build fails. Left
// unhandled it is an unhandled rejection, and this process exits on
// those (index.js) — which would turn a data problem into a crash loop
// under systemd. So it is handled: say what is wrong, keep serving.
// New duplicates are refused by the API either way; the existing ones
// need a person, and the build is retried every boot until they are
// dealt with.
Elastic.on("index", (err) => {
  if (!err) return;
  console.warn(
    `[elastic] unique name index not built — ${err.message}. ` +
    `New duplicate names are still refused by the API. Run ` +
    `"node scripts/find-duplicate-elastics.js", resolve what it lists, ` +
    `and restart to build it.`
  );
});

module.exports = Elastic;
