'use strict';
//
// Bayesian rate posterior update for ETA.
//
// Wraps the EtaRatePosterior model with two operations:
//
//   updatePairPosterior(session, { shift, machine, productionMeters })
//     Called from the shift verify cascade after the production
//     numbers land. Adds one observation per unique elastic on the
//     machine. Idempotent against shift._id.
//
//   getPairRate(elasticId, machineId)
//     Read side — returns null when no posterior exists yet (the
//     ETA route's existing plant/elastic blend handles cold start).
//     Returns meters per head per shift; the caller is responsible
//     for converting to meters per machine-day via the machine's
//     NoOfHead and SHIFTS_PER_DAY.
//
// Both calls are defensive: callers wrap update in try/catch so a
// posterior failure can never break the cascade.

const mongoose          = require("mongoose");
const EtaRatePosterior  = require("../models/EtaRatePosterior.js");
const C                 = require("./etaConfig.js");

// Minimum observations before a posterior is considered "informative"
// enough to override the plant/elastic blended rate. Below this we
// still keep updating, but readers should treat the posterior as
// noisy and prefer existing fallbacks.
const INFORMATIVE_THRESHOLD = 5;

// ── Pure math helpers (no DB, no Mongoose) ────────────────────────
//
// Gamma posterior parameters from a flat prior:
//   shape (α) = sum of observed meters per head per shift
//   rate  (β) = number of shifts observed
// posterior mean    = α / β
// posterior variance = α / β^2
//
// Exposed for unit tests and any caller that wants to compute the
// mean from a raw doc without hydrating the Mongoose model.
function posteriorMean(shape, rate) {
  return rate > 0 ? shape / rate : 0;
}

function posteriorVariance(shape, rate) {
  return rate > 0 ? shape / (rate * rate) : 0;
}

// Convert meters/head/shift → meters/machine-day, the unit the ETA
// heuristic expects. Pure — no I/O.
function toMetersPerMachineDay(metersPerHeadPerShift, noOfHead, shiftsPerDay) {
  const heads  = Number.isFinite(noOfHead)     && noOfHead     > 0 ? noOfHead     : 1;
  const shifts = Number.isFinite(shiftsPerDay) && shiftsPerDay > 0 ? shiftsPerDay : 1;
  return metersPerHeadPerShift * heads * shifts;
}

// ─────────────────────────────────────────────────────────────────
// Update the posterior for every (elastic, machine) pair touching
// this shift. One shift = one observation per pair, regardless of
// how many heads of that elastic the machine ran — the per-head
// production rate is the atomic unit, and heads on one machine share
// the same loom/operator bottleneck (so they aren't independent).
// ─────────────────────────────────────────────────────────────────
async function updatePairPosterior(
  session,
  { shift, machine, productionMeters }
) {
  const prodValue = Number(productionMeters);
  if (!Number.isFinite(prodValue) || prodValue <= 0) return [];
  if (!machine || !Array.isArray(machine.elastics) || machine.elastics.length === 0) return [];
  if (!shift || !shift._id) return [];

  const uniqueElasticIds = [
    ...new Set(machine.elastics.map((h) => h.elastic.toString())),
  ];

  const now = new Date();
  const updated = [];

  for (const elasticId of uniqueElasticIds) {
    // Match by pair AND require the prior update to have come from a
    // different shift. Combined with $setOnInsert, this gives us
    // single-statement create-or-update with idempotency.
    const res = await EtaRatePosterior.findOneAndUpdate(
      {
        elastic: new mongoose.Types.ObjectId(elasticId),
        machine: machine._id,
        lastShiftId: { $ne: shift._id },
      },
      {
        $inc: {
          shape:        prodValue,
          rate:         1,
          observations: 1,
        },
        $set: {
          lastShiftId:   shift._id,
          lastUpdatedAt: now,
        },
        $setOnInsert: { firstSeenAt: now },
      },
      {
        new:           true,
        upsert:        true,
        session,
        setDefaultsOnInsert: true,
      }
    );

    if (res) {
      updated.push({
        elastic:        elasticId,
        machine:        machine._id.toString(),
        observations:   res.observations,
        posteriorMean:  res.posteriorMean(),
      });
    }
  }

  return updated;
}

// ─────────────────────────────────────────────────────────────────
// Read side. Returns null when no posterior or too few observations.
// `metersPerHeadPerShift` is the raw posterior mean; callers convert
// to meters per machine-day with:
//   metersPerMachineDay = metersPerHeadPerShift * NoOfHead * SHIFTS_PER_DAY
// ─────────────────────────────────────────────────────────────────
async function getPairRate(elasticId, machineId) {
  if (!elasticId || !machineId) return null;
  const doc = await EtaRatePosterior.findOne({
    elastic: elasticId,
    machine: machineId,
  }).lean();
  if (!doc || !doc.rate) return null;
  return {
    metersPerHeadPerShift: doc.shape / doc.rate,
    variance:              doc.shape / (doc.rate * doc.rate),
    observations:          doc.observations || 0,
    informative:           (doc.observations || 0) >= INFORMATIVE_THRESHOLD,
  };
}

module.exports = {
  updatePairPosterior,
  getPairRate,
  posteriorMean,
  posteriorVariance,
  toMetersPerMachineDay,
  INFORMATIVE_THRESHOLD,
};
