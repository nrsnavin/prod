const mongoose = require("mongoose");

const BeamSectionSchema = new mongoose.Schema(
  {
    warpYarn: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    ends:      Number,
    maxMeters: { type: Number, default: 0 }, // max run length for this section

    // ── Which dye lot this section runs off ──────────────────────────
    // Decided here, at programming time, because that is when it can
    // still be changed: a section wants to come off one lot, since two
    // lots meeting inside a beam show as a shade band in the finished
    // elastic. Optional — an undyed or untracked yarn has no lot, and
    // plans made before lot tracking existed have none either.
    yarnLot: {
      type: mongoose.Types.ObjectId,
      ref: "YarnLot",
      default: null,
    },
    // Snapshot, so the printed programme still reads correctly years
    // later even if the lot record is archived. The programme sheet is
    // the copy that goes to the machine and gets filed.
    lotNo: { type: String, trim: true, default: "" },
    shade: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const BeamSchema = new mongoose.Schema(
  {
    beamNo:       Number,
    totalEnds:    Number,
    sections:     [BeamSectionSchema],
    pairedBeamNo: { type: Number, default: null }, // set when two beams are combined

    // Which elastic this beam is warping. A job can carry several, each
    // with its own template, and a mixed job's programme cannot be read
    // without saying which beam belongs to which product. Optional —
    // hand-built plans and everything made before templates have none.
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      default: null,
    },
  },
  { _id: false }
);

const WarpingPlanSchema = new mongoose.Schema(
  {
    warping: {
      type: mongoose.Types.ObjectId,
      ref: "Warping",
      required: true,
      unique: true, // 🔒 ONE PLAN PER WARPING
    },
    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
    },
    noOfBeams: Number,
    beams: [BeamSchema],
    remarks: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("WarpingPlan", WarpingPlanSchema);