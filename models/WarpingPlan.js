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
  },
  { _id: false }
);

const BeamSchema = new mongoose.Schema(
  {
    beamNo:       Number,
    totalEnds:    Number,
    sections:     [BeamSectionSchema],
    pairedBeamNo: { type: Number, default: null }, // set when two beams are combined
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