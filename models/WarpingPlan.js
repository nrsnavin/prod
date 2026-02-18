const mongoose = require("mongoose");

const BeamSectionSchema = new mongoose.Schema(
  {
   
    warpYarn: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    ends: Number,
  },
  { _id: false }
);

const BeamSchema = new mongoose.Schema(
  {
    beamNo: Number,
    totalEnds: Number,
    sections: [BeamSectionSchema],
  },
  { _id: false }
);

const WarpingPlanSchema = new mongoose.Schema(
  {
    warping: {
      type: mongoose.Types.ObjectId,
      ref: "Warping",
      required: true,
     // 🔒 ONE PLAN PER WARPING
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
