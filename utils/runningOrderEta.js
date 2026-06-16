'use strict';
//
// Running-order ETA — pure math.
//
// Given the live state of an in-flight order (jobs already running
// on machines, with per-elastic remaining meters and per-pair
// production rates from the Bayesian posterior), predict when the
// order will finish.
//
// Model
//   For each active job j (one machine each):
//     For each elastic e remaining in j:
//       headsOfE       = number of heads on the machine running e
//       metersPerShift = headsOfE * metersPerHeadPerShift(e, machine)
//       shiftsForE     = ceil(remainingE / metersPerShift)
//     jobShifts = max(shiftsForE)         // job done when slowest elastic finishes
//     jobDays   = ceil(jobShifts / SHIFTS_PER_DAY) + finishBuffer
//   orderDays   = max(jobDays)            // jobs run in parallel on different machines
//
// All "days" are working days; the caller maps to a real calendar
// via etaConfig.addWorkingDays.
//
// No prep buffer is added — by definition prep is already done on
// a running order. Finish buffer is added once at the end so all
// jobs share it (post-weaving stages are not per-job).

const C = require('./etaConfig.js');

const FINISH_BUFFER_WORKING_DAYS = C.STAGE_BUFFER_DAYS.finish;

// ─────────────────────────────────────────────────────────────────
// Estimate completion for a single in-flight job.
//
//   job.machineId         — id (any opaque value; not used for math)
//   job.noOfHead          — number of heads on the machine
//   job.elastics          — array of remaining-elastic entries
//   job.elastics[i].elastic        — id
//   job.elastics[i].remainingMeters — positive number
//   job.elastics[i].headsAssigned   — count of heads producing this elastic
//   job.elastics[i].metersPerHeadPerShift — posterior mean (or fallback)
//
// Returns { jobShifts, jobDays, perElastic: [...] } in working days,
// before finish buffer.
// ─────────────────────────────────────────────────────────────────
function estimateJobCompletion(job) {
  const perElastic = [];
  let jobShifts = 0;

  const elastics = Array.isArray(job?.elastics) ? job.elastics : [];
  for (const e of elastics) {
    const remaining = Number(e?.remainingMeters);
    const heads     = Number(e?.headsAssigned);
    const headRate  = Number(e?.metersPerHeadPerShift);

    // Nothing left of this elastic: contributes 0 shifts and is
    // included in the breakdown so the UI can render "done".
    if (!(remaining > 0)) {
      perElastic.push({
        elastic: e?.elastic,
        remainingMeters: 0,
        shifts: 0,
        days:   0,
      });
      continue;
    }

    if (!(heads > 0) || !(headRate > 0)) {
      perElastic.push({
        elastic: e?.elastic,
        remainingMeters: remaining,
        shifts: null,
        days:   null,
        reason: 'NO_RATE',
      });
      continue;
    }

    const metersPerShift = heads * headRate;
    const shifts = Math.ceil(remaining / metersPerShift);
    perElastic.push({
      elastic: e?.elastic,
      remainingMeters: remaining,
      headsAssigned:   heads,
      metersPerShift:  Math.round(metersPerShift),
      shifts,
      days: Math.ceil(shifts / C.SHIFTS_PER_DAY),
    });

    if (shifts > jobShifts) jobShifts = shifts;
  }

  const jobDays = Math.ceil(jobShifts / C.SHIFTS_PER_DAY);
  return { jobShifts, jobDays, perElastic };
}

// ─────────────────────────────────────────────────────────────────
// Top-level estimator over the full set of active jobs in an order.
//
//   jobs            — array of jobs (see estimateJobCompletion)
//   today           — Date, injectable for tests
//   weeklyOff       — defaults to etaConfig.WEEKLY_OFF
//   holidays        — defaults to etaConfig.HOLIDAYS
//   supplyDate      — promised supply date (optional, for risk chip)
//
// Returns the full prediction shape consumed by the route.
// ─────────────────────────────────────────────────────────────────
function estimateRunningOrderEta({
  jobs,
  today,
  weeklyOff,
  holidays,
  supplyDate,
}) {
  const t    = today || new Date();
  const wOff = weeklyOff || C.WEEKLY_OFF;
  const hol  = holidays  || C.HOLIDAYS;

  const safeJobs = Array.isArray(jobs) ? jobs : [];
  if (safeJobs.length === 0) {
    return {
      ok: false,
      reason: 'NO_ACTIVE_JOBS',
      message: 'Order has no active jobs to estimate from.',
    };
  }

  const perJob = [];
  let maxWeavingDays = 0;
  let anyRated       = false;

  for (const j of safeJobs) {
    const r = estimateJobCompletion(j);
    perJob.push({
      job:           j.job,
      machine:       j.machineId,
      machineLabel:  j.machineLabel || null,
      noOfHead:      j.noOfHead || null,
      jobShifts:     r.jobShifts,
      jobDays:       r.jobDays,
      perElastic:    r.perElastic,
      hasMissingRate: r.perElastic.some((e) => e.reason === 'NO_RATE'),
    });
    if (r.jobShifts > 0) anyRated = true;
    if (r.jobDays > maxWeavingDays) maxWeavingDays = r.jobDays;
  }

  if (!anyRated) {
    return {
      ok: false,
      reason: 'NO_RATE',
      message: 'No production-rate data available for any active job.',
      perJob,
    };
  }

  const weavingDays = maxWeavingDays;
  const leadDays    = FINISH_BUFFER_WORKING_DAYS;
  const workingDays = weavingDays + leadDays;
  const expectedDate = C.addWorkingDays(t, workingDays, wOff, hol);

  // Risk vs promised supplyDate.
  let risk = null;
  if (supplyDate) {
    const promised = new Date(supplyDate);
    const lateDays = C.workingDaysBetween(promised, expectedDate, wOff, hol);
    risk = {
      supplyDate:      promised,
      late:            expectedDate > promised,
      lateWorkingDays: expectedDate > promised ? lateDays : 0,
    };
  }

  return {
    ok: true,
    expectedDate,
    workingDays,
    weavingDays,
    leadDays,
    perJob,
    risk,
    assumptions: buildAssumptions(perJob),
  };
}

function buildAssumptions(perJob) {
  const a = [];
  const missing = perJob.filter((j) => j.hasMissingRate);
  if (missing.length > 0) {
    a.push(
      `${missing.length} job${missing.length === 1 ? '' : 's'} ` +
      `had elastic(s) with no production-rate data — those elastics ` +
      `excluded from the slowest-job calculation.`
    );
  }
  if (C.HOLIDAYS.length === 0) {
    a.push('Sundays-only calendar (no holiday list configured).');
  }
  a.push(
    `Order completes when the slowest of ${perJob.length} parallel ` +
    `job${perJob.length === 1 ? '' : 's'} finishes, plus ` +
    `${FINISH_BUFFER_WORKING_DAYS}d finishing buffer.`
  );
  return a;
}

module.exports = {
  estimateJobCompletion,
  estimateRunningOrderEta,
  FINISH_BUFFER_WORKING_DAYS,
};
