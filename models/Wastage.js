const mongoose = require("mongoose");

const WastageSchema = new mongoose.Schema(
  {
    // Client-generated idempotency key — a retried submit must not
    // record the wastage (and its penalty) twice. sparse for legacy.
    requestId: {
      type: String,
      unique: true,
      sparse: true,
    },

    job: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
    },

    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
    },

    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
    },

    penalty: {
      type: Number,
      default: 0,
    },

    // When the wastage actually occurred (the shift/incident date), used
    // to attribute the penalty to the correct payroll month. Falls back to
    // createdAt for legacy rows that never set it.
    incidentDate: {
      type: Date,
      default: null,
    },

    reason: {
      type: String,
      required: true,
    },

    // The loom it happened on: the one this employee ran this job on, as
    // the shifts stood when it was entered (utils/wastageMachine.js). Kept
    // here because the job forgets its machine when it leaves the loom.
    // Older records have none, and are worked out from the shifts.
    machine: { type: mongoose.Types.ObjectId, ref: "Machine" },

    // Who entered it. A penalty is taken from somebody's pay, and the
    // record of it did not say who put it there (api/wastage.js).
    recordedBy:     { type: mongoose.Types.ObjectId, ref: "User" },
    recordedByName: { type: String, default: "" },

  },
  { timestamps: true }
);

module.exports = mongoose.model("Wastage", WastageSchema);
