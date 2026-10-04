'use strict';
// ══════════════════════════════════════════════════════════════════
//  HOW MUCH WILL THIS LOOM MAKE?
//
//  Predicts the metres a machine produces in a shift from three things:
//  how long it ran (the timer), the pick of the elastic on its heads, and
//  how that machine has actually performed in its past shifts.
//
//  ── The physics first ────────────────────────────────────────────
//  A needle loom lays one pick per revolution. An elastic with pick P
//  needs P picks for every unit of length, so one head makes
//
//      metres  =  speed × minutes run ÷ pick  × (a constant for units)
//
//  That is not a guess to be learned, it is how weaving works, so it is
//  built in rather than left for a model to rediscover from noisy data.
//  What is NOT known is each machine's real speed: the speed on its
//  plate, less slippage, warp breaks inside the timer, and whatever else
//  makes LOOM-03 always a little slower than LOOM-07. That one number per
//  machine is what is learned:
//
//      metres per head  =  rate(machine) × minutes ÷ pick
//
//  ── Learning each machine's rate from its past shifts ────────────
//  Every verified shift gives one observed rate:
//      metres per head × pick ÷ minutes.
//  The machine's rate is the average of its observed rates (on a log
//  scale, so a shift that made half as much counts as much as one that
//  made double), with recent shifts counting more: a shift 45 days old
//  counts half as much as yesterday's, because a loom that was serviced
//  or started slipping last month is the loom that matters. A loom runs
//  two shifts a day, so that still leaves dozens of shifts behind each
//  rate.
//
//  A machine with three shifts on record has three noisy numbers, and
//  taking their average at face value would give it a confident,
//  probably wrong rate. So each machine's average is pulled toward the
//  plant's typical rate, strongly when it has few shifts and hardly at
//  all when it has many (empirical Bayes: how far to pull is worked out
//  from how much machines really differ against how much shifts on one
//  machine scatter). A machine with no history gets the plant rate, and
//  a wider range to say so.
//
//  ── The range ────────────────────────────────────────────────────
//  Every prediction carries a likely range (8 shifts in 10 should land
//  inside it) from the machine's own shift-to-shift scatter plus the
//  uncertainty in its rate. A wider "check this" band (49 in 50) is what
//  an entry screen uses to ask whether a figure was typed right.
//
//  ── Is it any good? ──────────────────────────────────────────────
//  The model is trained on all but the most recent fifth of shifts and
//  scored on that fifth, which it has not seen, against simpler ways of
//  guessing: the machine's average per shift (what the low-output alerts
//  use today), the machine's metres per hour (run time, no pick), and
//  the plant rate with the physics (no machine history). All four are
//  reported side by side, so whether the model earns its keep is a
//  number on the screen and not a claim in a comment.
//
//  ── What is used, and what is left out ───────────────────────────
//  Only VERIFIED (closed) shifts with a run time, metres above zero, and
//  a pick for every elastic on the heads. A shift whose rate is more
//  than four times off the plant's typical rate either way is left out
//  as a typing slip (an extra zero, metres entered as a total) rather
//  than allowed to drag a machine's rate. Each reason a shift was left
//  out is counted in the response.
//
//  ── Units ────────────────────────────────────────────────────────
//  Production is entered per head and stored on the shift multiplied by
//  the machine's heads (api/shift.js /verify-production), so the target
//  here is the stored metres ÷ heads, and predictions are given both per
//  head (what is typed in) and for the machine. Where heads carry
//  different elastics, the pick used is their harmonic mean, the pick
//  that gives the same total length.
// ══════════════════════════════════════════════════════════════════

const ShiftDetail = require('../models/ShiftDetail');
const Machine = require('../models/Machine');
const Elastic = require('../models/Elastic');
const { memoizeAsync } = require('../utils/memo');

// ── The knobs, all reported in the response ──────────────────────

/** How far back shifts are read for training. */
const HISTORY_DAYS = 365;
/** A shift this many days old counts half as much as today's. */
const HALF_LIFE_DAYS = 45;
/** A rate this many times above or below the plant's typical one is a slip. */
const OUTLIER_FACTOR = 4;
/** Fewer usable shifts than this in the whole plant → no model at all. */
const MIN_TRAINING_SHIFTS = 20;
/** The most recent share of shifts held back to score the model. */
const HOLDOUT_SHARE = 0.2;
/** Fewer held-back shifts than this → accuracy is not reported. */
const MIN_HOLDOUT_SHIFTS = 10;
/** Shifts' worth of "plant-like" scatter each machine's own scatter is blended with. */
const SCATTER_PRIOR_SHIFTS = 5;
/** Shorter runs than this say more about the timer than the loom. */
const MIN_RUN_MINUTES = 30;
/** How long a trained model is reused before retraining. */
const CACHE_MS = 15 * 60_000;

/** Normal quantiles for the two bands. */
const Z_LIKELY = 1.2816; // 10th–90th percentile: 8 in 10
const Z_CHECK = 2.3263;  // 1st–99th percentile: 49 in 50

const SHIFT_MINUTES = 720;
const DAY_MS = 86_400_000;

// ── Reading the inputs ───────────────────────────────────────────

/** "7:45", "07:45:12" → minutes; anything else → 0. */
function runMinutes(timer) {
  const m = String(timer ?? '').trim().match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3] ?? 0) / 60;
}

/**
 * One pick for a set of heads: the harmonic mean. Heads with pick 10 and
 * 20 together make as much length as two heads at 13.3, not at 15.
 * Returns null when any head has no usable pick: a shift whose length
 * can't be accounted for is not evidence about the loom.
 */
function effectivePick(picks) {
  if (!Array.isArray(picks) || picks.length === 0) return null;
  let inv = 0;
  for (const p of picks) {
    const n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return null;
    inv += 1 / n;
  }
  return picks.length / inv;
}

const ln = Math.log;
const sum = (xs) => xs.reduce((t, x) => t + x, 0);

function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Shifts → training rows, with a count of every reason one was left out.
 *
 * @param shifts     lean ShiftDetail docs: { _id, date, timer, productionMeters, machine, elastics: [{ elastic }] }
 * @param heads      Map machineId → NoOfHead
 * @param picks      Map elasticId → pick
 */
function buildRows(shifts, heads, picks) {
  const skipped = { noRunTime: 0, shortRun: 0, noMetres: 0, noPick: 0, noHeads: 0, outlier: 0 };
  const rows = [];
  for (const s of shifts) {
    const minutes = runMinutes(s.timer);
    if (!minutes) { skipped.noRunTime++; continue; }
    if (minutes < MIN_RUN_MINUTES) { skipped.shortRun++; continue; }
    const total = Number(s.productionMeters);
    if (!Number.isFinite(total) || total <= 0) { skipped.noMetres++; continue; }
    const machine = String(s.machine);
    const h = Number(heads.get(machine));
    if (!Number.isFinite(h) || h <= 0) { skipped.noHeads++; continue; }
    const pick = effectivePick((s.elastics || []).map((e) => picks.get(String(e.elastic))));
    if (pick == null) { skipped.noPick++; continue; }
    const perHead = total / h;
    rows.push({
      shift: String(s._id),
      machine,
      date: new Date(s.date),
      minutes,
      pick,
      perHead,
      // The observed rate, on a log scale: log(metres × pick ÷ minutes).
      lr: ln(perHead * pick / minutes),
    });
  }

  // Slips: far off the plant's typical rate either way.
  const mid = median(rows.map((r) => r.lr));
  const bound = ln(OUTLIER_FACTOR);
  const kept = rows.filter((r) => Math.abs(r.lr - mid) <= bound);
  skipped.outlier = rows.length - kept.length;
  return { rows: kept, skipped };
}

// ── Training ─────────────────────────────────────────────────────

/**
 * Fits the per-machine rates.
 *
 * @param rows  from buildRows
 * @param now   the date recency is measured from (the cutoff, when scoring)
 * @returns {null | {
 *   plant: { mu, sigma, variance },
 *   machines: Map<id, { mu, variance, sigma, shifts, weightedShifts, ownMu }>,
 *   sigma, tau, shifts, trainedThrough
 * }}
 */
function fit(rows, { now = new Date(), halfLifeDays = HALF_LIFE_DAYS } = {}) {
  if (rows.length < MIN_TRAINING_SHIFTS) return null;
  const t = now.getTime();

  // Recency weights, grouped by machine.
  const groups = new Map();
  for (const r of rows) {
    const age = Math.max(0, (t - r.date.getTime()) / DAY_MS);
    const w = 0.5 ** (age / halfLifeDays);
    if (!groups.has(r.machine)) groups.set(r.machine, []);
    groups.get(r.machine).push({ lr: r.lr, w });
  }

  // Each machine's own weighted mean and scatter.
  const own = [];
  let pooledSS = 0;
  let pooledDf = 0;
  for (const [id, g] of groups) {
    const W = sum(g.map((x) => x.w));
    const W2 = sum(g.map((x) => x.w * x.w));
    const mean = sum(g.map((x) => x.w * x.lr)) / W;
    // Effective number of shifts once old ones count for less.
    const nEff = (W * W) / W2;
    const ss = g.length > 1 ? sum(g.map((x) => x.w * (x.lr - mean) ** 2)) / W : 0;
    own.push({ id, mean, nEff, n: g.length, ss });
    // Weighted variance scaled back to (nEff − 1) degrees of freedom.
    const df = Math.max(nEff - 1, 0);
    if (df > 0) {
      pooledSS += ss * nEff;
      pooledDf += df;
    }
  }
  // Shift-to-shift scatter on one machine, pooled across machines. With
  // no repeat shifts anywhere, fall back to the scatter of all rows.
  let sigma2 = pooledDf > 0 ? pooledSS / pooledDf : variance(rows.map((r) => r.lr));
  sigma2 = Math.max(sigma2, 1e-4);

  // How much machines really differ (method of moments), and the plant's
  // typical rate weighted by how well each machine's mean is known.
  // A few passes: the weights need tau, and tau needs the plant mean.
  let tau2 = 0.01;
  let mu = 0;
  let muVar = 0;
  for (let pass = 0; pass < 3; pass++) {
    const wts = own.map((m) => 1 / (tau2 + sigma2 / m.nEff));
    const W = sum(wts);
    mu = sum(own.map((m, i) => wts[i] * m.mean)) / W;
    muVar = 1 / W;
    if (own.length > 1) {
      const spread = sum(own.map((m) => (m.mean - mu) ** 2)) / (own.length - 1);
      const noise = sum(own.map((m) => sigma2 / m.nEff)) / own.length;
      tau2 = Math.max(spread - noise, 1e-4);
    }
  }

  const machines = new Map();
  for (const m of own) {
    // Pulled toward the plant in proportion to how little is known.
    const precisionOwn = m.nEff / sigma2;
    const precisionPlant = 1 / tau2;
    const shrunk = (precisionOwn * m.mean + precisionPlant * mu) / (precisionOwn + precisionPlant);
    const varMu = 1 / (precisionOwn + precisionPlant);
    // This machine's own scatter, blended with the plant's: a machine
    // with a handful of shifts can't claim to be steadier than the rest.
    const ownDf = Math.max(m.nEff - 1, 0);
    const ownS2 = ownDf > 0 ? (m.ss * m.nEff) / ownDf : 0;
    const s2 = (ownDf * ownS2 + SCATTER_PRIOR_SHIFTS * sigma2) / (ownDf + SCATTER_PRIOR_SHIFTS);
    machines.set(m.id, {
      mu: shrunk,
      variance: varMu,
      sigma: Math.sqrt(Math.max(s2, 1e-4)),
      shifts: m.n,
      weightedShifts: m.nEff,
      ownMu: m.mean,
    });
  }

  return {
    plant: { mu, variance: muVar + tau2, sigma: Math.sqrt(sigma2) },
    machines,
    sigma: Math.sqrt(sigma2),
    tau: Math.sqrt(tau2),
    shifts: rows.length,
    trainedThrough: new Date(rows.reduce((t, r) => Math.max(t, r.date.getTime()), 0)),
  };
}

function variance(xs) {
  if (xs.length < 2) return 0;
  const m = sum(xs) / xs.length;
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
}

// ── Prediction ───────────────────────────────────────────────────

/**
 * Metres per head and for the machine, with the likely range and the
 * wider "check this" band.
 *
 * @returns {null | { perHead, low, high, checkLow, checkHigh, total, totalLow, totalHigh,
 *                    basis: 'machine' | 'plant', shifts, minutes, pick, heads }}
 */
function predict(model, { machine, minutes, pick, heads = 1 }) {
  if (!model) return null;
  const mins = Number(minutes);
  const p = Number(pick);
  if (!(mins > 0) || !(p > 0)) return null;
  const known = machine != null ? model.machines.get(String(machine)) : null;
  const mu = known ? known.mu : model.plant.mu;
  // A new machine: the plant's rate, plus how much machines differ.
  const spread = known
    ? Math.sqrt(known.sigma ** 2 + known.variance)
    : Math.sqrt(model.sigma ** 2 + model.plant.variance);
  const base = mins / p;
  const at = (z) => Math.exp(mu + z * spread) * base;
  const h = Number(heads) > 0 ? Number(heads) : 1;
  const perHead = Math.exp(mu) * base;
  return {
    perHead: round(perHead),
    low: round(at(-Z_LIKELY)),
    high: round(at(Z_LIKELY)),
    checkLow: round(at(-Z_CHECK)),
    checkHigh: round(at(Z_CHECK)),
    total: round(perHead * h),
    totalLow: round(at(-Z_LIKELY) * h),
    totalHigh: round(at(Z_LIKELY) * h),
    basis: known ? 'machine' : 'plant',
    shifts: known ? known.shifts : 0,
    minutes: round(mins, 2),
    pick: round(p, 2),
    heads: h,
  };
}

const round = (x, dp = 1) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

/**
 * How fast a machine runs against the plant's typical machine, and what
 * that comes to in plain terms: metres per head in an hour at a pick.
 */
function machineSummary(model, machineId, { pick } = {}) {
  if (!model) return null;
  const m = model.machines.get(String(machineId));
  const mu = m ? m.mu : model.plant.mu;
  const p = Number(pick) > 0 ? Number(pick) : null;
  return {
    basis: m ? 'machine' : 'plant',
    shifts: m ? m.shifts : 0,
    // 1.06 → 6% faster than the plant's typical machine.
    speedIndex: round(Math.exp(mu - model.plant.mu), 3),
    // On the log scale, as a ± percentage: how much its shifts scatter.
    scatterPct: round((Math.exp((m ? m.sigma : model.sigma)) - 1) * 100, 0),
    metresPerHeadHour: p ? round(Math.exp(mu) * 60 / p, 2) : null,
    pick: p,
  };
}

// ── Scoring against simpler guesses ──────────────────────────────

/**
 * Trains on all but the most recent HOLDOUT_SHARE of shifts and scores
 * every method on the rest. Returns null when there isn't enough of
 * either to say anything.
 */
function evaluate(rows) {
  const sorted = [...rows].sort((a, b) => a.date - b.date);
  const nTest = Math.floor(sorted.length * HOLDOUT_SHARE);
  if (nTest < MIN_HOLDOUT_SHIFTS) return null;
  const train = sorted.slice(0, sorted.length - nTest);
  const test = sorted.slice(sorted.length - nTest);
  const cutoff = train[train.length - 1].date;
  const model = fit(train, { now: cutoff });
  if (!model) return null;

  // Baselines, from the same training shifts.
  const byMachine = new Map();
  for (const r of train) {
    if (!byMachine.has(r.machine)) byMachine.set(r.machine, { metres: 0, minutes: 0, n: 0 });
    const b = byMachine.get(r.machine);
    b.metres += r.perHead; b.minutes += r.minutes; b.n++;
  }
  const plantPerShift = sum(train.map((r) => r.perHead)) / train.length;
  const plantPerMinute = sum(train.map((r) => r.perHead)) / sum(train.map((r) => r.minutes));

  const methods = {
    model: (r) => predict(model, { machine: r.machine, minutes: r.minutes, pick: r.pick }).perHead,
    machineAverage: (r) => {
      const b = byMachine.get(r.machine);
      return b ? b.metres / b.n : plantPerShift;
    },
    machinePerHour: (r) => {
      const b = byMachine.get(r.machine);
      return (b ? b.metres / b.minutes : plantPerMinute) * r.minutes;
    },
    plantPhysics: (r) => Math.exp(model.plant.mu) * r.minutes / r.pick,
  };

  const scores = {};
  for (const [name, f] of Object.entries(methods)) {
    const errs = test.map((r) => {
      const guess = f(r);
      return { abs: Math.abs(guess - r.perHead), pct: Math.abs(guess - r.perHead) / r.perHead };
    });
    scores[name] = {
      mae: round(sum(errs.map((e) => e.abs)) / errs.length),
      medianErrorPct: round(median(errs.map((e) => e.pct)) * 100),
      within10Pct: round((errs.filter((e) => e.pct <= 0.1).length / errs.length) * 100, 0),
    };
  }

  // Did 8 in 10 really land inside the likely range?
  const inside = test.filter((r) => {
    const p = predict(model, { machine: r.machine, minutes: r.minutes, pick: r.pick });
    return r.perHead >= p.low && r.perHead <= p.high;
  }).length;
  scores.model.rangeCoveragePct = round((inside / test.length) * 100, 0);

  return {
    trainedOn: train.length,
    testedOn: test.length,
    testFrom: test[0].date,
    testTo: test[test.length - 1].date,
    methods: scores,
  };
}

// ── Loading and caching ──────────────────────────────────────────

async function loadRows({ now = new Date() } = {}) {
  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const shifts = await ShiftDetail.find({ status: 'closed', date: { $gte: since } })
    .select('date timer productionMeters machine elastics')
    .lean();
  const machineIds = [...new Set(shifts.map((s) => String(s.machine)))];
  const elasticIds = [...new Set(shifts.flatMap((s) => (s.elastics || []).map((e) => String(e.elastic))))];
  const [machines, elastics] = await Promise.all([
    Machine.find({ _id: { $in: machineIds } }).select('NoOfHead').lean(),
    Elastic.find({ _id: { $in: elasticIds } }).select('pick').lean(),
  ]);
  const heads = new Map(machines.map((m) => [String(m._id), m.NoOfHead]));
  const picks = new Map(elastics.map((e) => [String(e._id), e.pick]));
  return { ...buildRows(shifts, heads, picks), read: shifts.length };
}

/** Trains on the latest verified shifts. Cached; see CACHE_MS. */
async function train() {
  const now = new Date();
  const { rows, skipped, read } = await loadRows({ now });
  const model = fit(rows, { now });
  return {
    available: !!model,
    trainedAt: now,
    model,
    evaluation: model ? evaluate(rows) : null,
    data: { read, used: rows.length, skipped },
  };
}

const getModel = memoizeAsync(train, CACHE_MS);

const NOT_ENOUGH =
  `Not enough verified shifts yet to learn from: it needs ${MIN_TRAINING_SHIFTS} with a run time, metres and a pick for every elastic.`;

/** Minutes from typed text, else from what the shift already holds. */
function minutesFor(shift, runTime) {
  if (runTime != null && String(runTime).trim() !== '') {
    const typed = runMinutes(runTime);
    return { minutes: typed || null, from: typed ? 'entered' : null };
  }
  for (const t of [shift?.submittedTimer, shift?.timer]) {
    const m = runMinutes(t);
    if (m) return { minutes: m, from: 'shift' };
  }
  return { minutes: null, from: null };
}

/**
 * What a machine with these elastics should make: the prediction for a
 * run time when there is one, and the hourly rate either way.
 */
async function expectFor({ machineId, elasticIds, minutes, pickOverride }) {
  const trained = await getModel();
  const machine = await Machine.findById(machineId).select('ID NoOfHead').lean();
  if (!machine) return null;
  const ids = (elasticIds || []).filter(Boolean).map(String);
  const docs = ids.length ? await Elastic.find({ _id: { $in: ids } }).select('name pick').lean() : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  const pickFromHeads = effectivePick(ids.map((id) => byId.get(id)?.pick));
  const pick = Number(pickOverride) > 0 ? Number(pickOverride) : pickFromHeads;
  // One row per elastic, with how many heads carry it.
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const elastics = [...counts].map(([id, heads]) => ({
    id, name: byId.get(id)?.name ?? null, pick: byId.get(id)?.pick ?? null, heads,
  }));

  const base = {
    available: trained.available,
    reason: trained.available ? null : NOT_ENOUGH,
    trainedAt: trained.trainedAt,
    machine: { id: String(machine._id), code: machine.ID, heads: machine.NoOfHead },
    elastics,
    pick: pick != null ? round(pick, 2) : null,
    pickFrom: Number(pickOverride) > 0 ? 'entered' : pickFromHeads != null ? 'heads' : null,
  };
  if (!trained.available) return { ...base, summary: null, prediction: null };
  return {
    ...base,
    summary: machineSummary(trained.model, machine._id, { pick }),
    prediction: minutes && pick
      ? predict(trained.model, { machine: machine._id, minutes, pick, heads: machine.NoOfHead })
      : null,
  };
}

/** For a planned shift: its machine, the elastics it was planned with. */
async function expectForShift(shift, { runTime } = {}) {
  const { minutes, from } = minutesFor(shift, runTime);
  const out = await expectFor({
    machineId: shift.machine,
    elasticIds: (shift.elastics || []).map((e) => e.elastic),
    minutes,
  });
  return out && { ...out, runTimeFrom: from };
}

/** The model as JSON: everything except the per-machine map. */
function describe(trained) {
  const { model } = trained;
  return {
    available: trained.available,
    trainedAt: trained.trainedAt,
    data: trained.data,
    evaluation: trained.evaluation,
    plant: model
      ? { machines: model.machines.size, scatterPct: round((Math.exp(model.sigma) - 1) * 100, 0),
          machineSpreadPct: round((Math.exp(model.tau) - 1) * 100, 0) }
      : null,
    settings: {
      historyDays: HISTORY_DAYS, halfLifeDays: HALF_LIFE_DAYS, outlierFactor: OUTLIER_FACTOR,
      minTrainingShifts: MIN_TRAINING_SHIFTS, holdoutShare: HOLDOUT_SHARE, minRunMinutes: MIN_RUN_MINUTES,
      likelyRange: '10th–90th percentile', checkRange: '1st–99th percentile',
    },
  };
}

module.exports = {
  getModel,
  expectFor,
  expectForShift,
  minutesFor,
  describe,
  predict,
  machineSummary,
  runMinutes,
  effectivePick,
  SHIFT_MINUTES,
  _internals: { buildRows, fit, evaluate, loadRows, train, median },
};
