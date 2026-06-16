// models/EtaRatePosterior.js
//
// Bayesian rate posterior for ETA, one document per
// (elastic, machine) pair.
//
// Treats meters-per-head-per-shift as Poisson-distributed and keeps
// a Gamma(shape, rate) conjugate posterior. Each closed shift adds
// exactly one observation. Posterior mean shape/rate is the expected
// meters per head per shift; multiply by Machine.NoOfHead and
// SHIFTS_PER_DAY downstream to get meters per machine-day for the
// ETA heuristic.
//
// Cold start: when a pair has no document, the rate engine falls
// back to the plant prior (caller's job — not stored here).
//
// Idempotency: lastShiftId guards against the same shift being
// cascaded twice (shouldn't happen, but is cheap insurance).
const mongoose = require("mongoose");

const EtaRatePosteriorSchema = new mongoose.Schema(
  {
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
      index: true,
    },
    machine: {
      type: mongoose.Types.ObjectId,
      ref: "Machine",
      required: true,
      index: true,
    },

    // Gamma posterior parameters.
    //   shape (α)  = sum of observed meters per head per shift
    //   rate  (β)  = number of shifts observed
    // posterior mean    = shape / rate
    // posterior variance = shape / rate^2
    shape: { type: Number, required: true, default: 0 },
    rate:  { type: Number, required: true, default: 0 },

    // Audit + diagnostics.
    observations:  { type: Number, required: true, default: 0 },
    lastShiftId:   { type: mongoose.Types.ObjectId, ref: "ShiftDetail" },
    lastUpdatedAt: { type: Date },
    firstSeenAt:   { type: Date },
  },
  { timestamps: true }
);

EtaRatePosteriorSchema.index({ elastic: 1, machine: 1 }, { unique: true });

// ── Helpers (don't persist; computed on read) ──────────────────────

EtaRatePosteriorSchema.methods.posteriorMean = function () {
  return this.rate > 0 ? this.shape / this.rate : 0;
};

EtaRatePosteriorSchema.methods.posteriorVariance = function () {
  return this.rate > 0 ? this.shape / (this.rate * this.rate) : 0;
};

module.exports = mongoose.model("EtaRatePosterior", EtaRatePosteriorSchema);
