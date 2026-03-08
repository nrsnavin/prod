const mongoose = require("mongoose");

// ── Warping plan template sub-schemas ─────────────────────────
// Embedded on the Elastic doc so any Warping created for a job
// containing this elastic can auto-build a WarpingPlan from it.

const PlanSectionSchema = new mongoose.Schema(
  {
    warpYarn: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    ends: { type: Number, default: 0 },
  },
  { _id: false }
);

const PlanBeamSchema = new mongoose.Schema(
  {
    beamNo:    { type: Number },
    totalEnds: { type: Number, default: 0 },
    sections:  { type: [PlanSectionSchema], default: [] },
  },
  { _id: false }
);

// ── Main elastic schema ────────────────────────────────────────
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

    status: { type: mongoose.Types.ObjectId, ref: "Order" },

    // ── WARPING PLAN TEMPLATE ──────────────────────────────
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