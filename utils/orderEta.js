'use strict';
/**
 * Order completion-date heuristic.
 *
 * Pure functions over already-fetched aggregates. The route in
 * api/order.js does the DB queries, this file does the math. Keeps
 * the algorithm trivially unit-testable without spinning Mongo.
 *
 * Inputs you must supply:
 *   - aggregates.elasticRate[elasticId] (optional, per-elastic
 *     meters/machine active-day from the trailing window)
 *   - aggregates.plantRate             (plant-wide meters/machine
 *     active-day from the trailing window — always required as the
 *     blended fallback)
 *   - aggregates.consistencyScore      (0..100 from /analytics)
 *   - aggregates.attendanceMomentum    (effectivePresent ratio
 *     last7d ÷ trailing30d, clamped to a sane range)
 *   - aggregates.machineHealth         (availableMachines ÷ typical
 *     running, clamped)
 *   - aggregates.freeMachines          (number of machines currently
 *     not in maintenance / running)
 *   - aggregates.machineNoOfHeadAvg    (plant-wide avg NoOfHead, used
 *     only for the cold-start fallback)
 *
 * The route can hydrate these from real queries; tests supply them
 * directly.
 */

const C = require('./etaConfig.js');

// ── Rate engine ───────────────────────────────────────────────────
//
// Returns meters per machine per active (working) day. Empirical
// data first, plant-wide blend second, cold-start physics last —
// every step is recorded in `source` so the API response can show
// it on the assumptions list.
function metersPerMachineDay({ aggregates, elasticId }) {
  const a = aggregates || {};

  const elasticRate = elasticId
    && a.elasticRate
    && Number.isFinite(a.elasticRate[elasticId])
    ? Number(a.elasticRate[elasticId])
    : null;
  if (elasticRate && elasticRate > 0) {
    return { rate: elasticRate, source: 'empirical_elastic' };
  }

  if (Number.isFinite(a.plantRate) && a.plantRate > 0) {
    return { rate: Number(a.plantRate), source: 'empirical_plant' };
  }

  // Cold-start: physical formula. Single place we trust the loom
  // theory rather than the data.
  const heads = Number.isFinite(a.machineNoOfHeadAvg) && a.machineNoOfHeadAvg > 0
    ? Number(a.machineNoOfHeadAvg)
    : 1;
  const rate = C.COLDSTART_METERS_PER_HEAD_DAY * heads * C.LOOM_EFFICIENCY;
  return { rate, source: 'coldstart' };
}

function effectiveRate({ aggregates, elasticId }) {
  const { rate, source } = metersPerMachineDay({ aggregates, elasticId });
  const att = C.clamp(
    Number.isFinite(aggregates?.attendanceMomentum) ? aggregates.attendanceMomentum : 1,
    C.ATTENDANCE_MOMENTUM_MIN, C.ATTENDANCE_MOMENTUM_MAX,
  );
  const mac = C.clamp(
    Number.isFinite(aggregates?.machineHealth) ? aggregates.machineHealth : 1,
    C.MACHINE_HEALTH_MIN, C.MACHINE_HEALTH_MAX,
  );
  return {
    rate: rate * att * mac,
    rawRate: rate,
    rateSource: source,
    attendanceMomentum: att,
    machineHealth: mac,
  };
}

// ── ETA for a single (M machines dedicated) scenario ──────────────
function estimateForMachines({ totalMeters, machines, effRate, today, weeklyOff, holidays }) {
  if (!Number.isFinite(totalMeters) || totalMeters <= 0) {
    return { workingDays: 0, machineDays: 0, expectedDate: new Date(today) };
  }
  const M = Math.max(1, Math.floor(machines));
  const machineDays = totalMeters / effRate;
  const weavingDays = Math.ceil(machineDays / M);
  const leadDays   = C.STAGE_BUFFER_DAYS.prep + C.STAGE_BUFFER_DAYS.finish;
  const workingDays = weavingDays + leadDays;
  const expectedDate = C.addWorkingDays(today, workingDays, weeklyOff, holidays);
  return { workingDays, machineDays, weavingDays, leadDays, expectedDate };
}

// ── Confidence band — quote a range, not false precision ──────────
function band({ workingDays, today, consistencyScore, weeklyOff, holidays }) {
  const conf = C.clamp(
    Number.isFinite(consistencyScore) ? consistencyScore / 100 : 0.7,
    0, 1,
  );
  const spread = 1 - conf;
  const optDays = Math.max(1, Math.ceil(workingDays * (1 - 0.25 * spread)));
  const pesDays = Math.max(workingDays, Math.ceil(workingDays * (1 + 0.5 * spread)));
  return {
    confidence: conf,
    optimistic:  C.addWorkingDays(today, optDays, weeklyOff, holidays),
    pessimistic: C.addWorkingDays(today, pesDays, weeklyOff, holidays),
    optimisticDays:  optDays,
    pessimisticDays: pesDays,
  };
}

// ── Top-level: estimate at order-entry time ───────────────────────
//
//   lines    — [{ elastic, quantity }]   meters per elastic
//   machines — number of machines admin will dedicate (default:
//              min(freeMachines, lines.length, WHATIF_MAX_MACHINES))
//   supplyDate — admin-entered promised date (optional, for risk chip)
//   today    — Date, defaults to now (injectable for tests)
function estimateOrderEta({ lines, machines, supplyDate, today, aggregates, weeklyOff, holidays }) {
  const t = today || new Date();
  const wOff = weeklyOff || C.WEEKLY_OFF;
  const hol  = holidays  || C.HOLIDAYS;

  const cleanLines = (lines || [])
    .filter((l) => Number(l.quantity) > 0)
    .map((l) => ({
      elastic:  String(l.elastic || ''),
      quantity: Number(l.quantity),
    }));
  const totalMeters = cleanLines.reduce((s, l) => s + l.quantity, 0);

  // Default machine count: prefer free machines, capped by line count
  // (no point dedicating more machines than there are independent
  // elastic lines, because one machine per job).
  const defaultMachines = Math.min(
    Math.max(1, Number(aggregates?.freeMachines) || 1),
    Math.max(1, cleanLines.length),
    C.WHATIF_MAX_MACHINES,
  );
  const M = Number.isFinite(machines) && machines > 0
    ? Math.min(Math.floor(machines), C.WHATIF_MAX_MACHINES)
    : defaultMachines;

  // Blended rate: weight per line by meters share so a 90/10 split
  // doesn't get dragged by a tiny line on a slow elastic.
  let weightedRate = 0, weightSum = 0;
  let usedColdStart = false;
  const perLineRates = [];
  for (const l of cleanLines) {
    const { rate, source } = metersPerMachineDay({ aggregates, elasticId: l.elastic });
    perLineRates.push({ elastic: l.elastic, meters: l.quantity, rate, source });
    if (source === 'coldstart') usedColdStart = true;
    weightedRate += rate * l.quantity;
    weightSum    += l.quantity;
  }
  const baseRate = weightSum > 0 ? weightedRate / weightSum : 0;

  // Apply momentum + health to the blended base rate.
  const att = C.clamp(
    Number.isFinite(aggregates?.attendanceMomentum) ? aggregates.attendanceMomentum : 1,
    C.ATTENDANCE_MOMENTUM_MIN, C.ATTENDANCE_MOMENTUM_MAX,
  );
  const mac = C.clamp(
    Number.isFinite(aggregates?.machineHealth) ? aggregates.machineHealth : 1,
    C.MACHINE_HEALTH_MIN, C.MACHINE_HEALTH_MAX,
  );
  const effRate = baseRate * att * mac;
  if (!(effRate > 0)) {
    return {
      ok:     false,
      reason: 'NO_RATE',
      assumptions: ['No production-rate data available; cannot estimate.'],
    };
  }

  const core = estimateForMachines({
    totalMeters, machines: M, effRate, today: t, weeklyOff: wOff, holidays: hol,
  });
  const bands = band({
    workingDays: core.workingDays,
    today: t,
    consistencyScore: aggregates?.consistencyScore,
    weeklyOff: wOff, holidays: hol,
  });

  // Risk vs admin-entered promise.
  let risk = null;
  if (supplyDate) {
    const promised = new Date(supplyDate);
    const lateDays = C.workingDaysBetween(promised, core.expectedDate, wOff, hol);
    risk = {
      supplyDate: promised,
      late: core.expectedDate > promised,
      lateWorkingDays: core.expectedDate > promised ? lateDays : 0,
    };
  }

  // What-if curve so the UI can show the trade-off.
  const whatIf = [];
  const upTo = Math.max(M, Math.min(C.WHATIF_MAX_MACHINES, Math.max(1, Number(aggregates?.freeMachines) || M)));
  for (let m = 1; m <= upTo; m += 1) {
    const r = estimateForMachines({ totalMeters, machines: m, effRate, today: t, weeklyOff: wOff, holidays: hol });
    whatIf.push({ machines: m, workingDays: r.workingDays, expectedDate: r.expectedDate });
  }

  const assumptions = [];
  if (usedColdStart) {
    assumptions.push('Some elastic(s) had no recent production history — cold-start fallback rate applied.');
  }
  if (att !== 1) {
    assumptions.push(`Attendance momentum factor: ${att.toFixed(2)} (last 7d vs trailing 30d).`);
  }
  if (mac !== 1) {
    assumptions.push(`Machine availability factor: ${mac.toFixed(2)}.`);
  }
  if (C.HOLIDAYS.length === 0) {
    assumptions.push('Sundays-only calendar (no holiday list configured).');
  }

  return {
    ok: true,
    expectedDate: core.expectedDate,
    workingDays:  core.workingDays,
    machineDays:  Math.round(core.machineDays * 10) / 10,
    weavingDays:  core.weavingDays,
    leadDays:     core.leadDays,
    effRate:      Math.round(effRate),
    machines:     M,
    totalMeters,
    perLineRates,
    confidence:   bands.confidence,
    optimistic:   bands.optimistic,
    pessimistic:  bands.pessimistic,
    optimisticDays:  bands.optimisticDays,
    pessimisticDays: bands.pessimisticDays,
    risk,
    whatIf,
    usedColdStart,
    assumptions,
    factors: {
      attendanceMomentum: att,
      machineHealth:      mac,
      rawBlendedRate:     Math.round(baseRate),
    },
  };
}

module.exports = {
  metersPerMachineDay,
  effectiveRate,
  estimateForMachines,
  estimateOrderEta,
};
