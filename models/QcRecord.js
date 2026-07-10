const mongoose = require("mongoose");

// Quality-control result captured at the job's checking stage. Measured
// values are recorded against the elastic's testingParameters so the
// checking pipeline stage carries data, not just a status — and a COA
// (certificate of analysis) can be produced for the customer.
const qcRecordSchema = new mongoose.Schema(
  {
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "JobOrder",
      required: true,
    },
    elastic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Elastic",
      required: true,
    },
    checkedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    results: [
      {
        parameter: { type: String, required: true },
        expected: { type: String, default: "" },
        measured: { type: String, required: true },
        pass: { type: Boolean, required: true },
      },
    ],
    overallResult: {
      type: String,
      enum: ["pass", "fail"],
      required: true,
    },
    defectCode: { type: String, trim: true, default: "" },
    rejectedMeters: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, default: "" },
    // Inspection photo (data URL) — kept as the labelling flywheel: every
    // AI draft the inspector corrects becomes training data for a future
    // fine-tuned defect model.
    image: { type: String, default: "" },
    // Whether the draft was AI-assisted (vision) before the human verified.
    aiAssisted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

qcRecordSchema.index({ job: 1, createdAt: -1 });

module.exports = mongoose.model("QcRecord", qcRecordSchema);
