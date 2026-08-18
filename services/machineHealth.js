'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LOOM'S OUTPUT DECAYS BEFORE IT FAILS
//
//  The signal is already being computed and nothing reads it. Every
//  closed shift adds an observation to the Bayesian rate posterior per
//  (elastic, machine); a sustained fall against a machine's OWN recent
//  history is a leading indicator that a service is due.
//
//  ── Why the posterior is used, but not as the series ─────────────
//  EtaRatePosterior is CUMULATIVE — a Gamma over the whole life of the
//  pair. Its mean barely moves after a hundred observations, so
//  watching it for a changepoint would watch a number designed not to
//  have one. The per-shift series lives in ShiftDetail, and that is
//  what is tested.
//
//  What the posterior is for is the thing it is genuinely good at:
//  saying what THIS pair should produce. Every shift is divided by its
//  pair's posterior mean, so an observation becomes a ratio around 1.0
//  that is comparable across products.
//
//  ── The mistake this exists to avoid ─────────────────────────────
//  A machine put on a slower elastic produces fewer metres and is not
//  a sick machine. Any version of this that compares raw metres would
//  flag every product change on the floor and be switched off inside a
//  week. Normalising per pair is the whole design, not a refinement,
//  and there is a test that fails if it is removed.
//
//  ── What it will not do ──────────────────────────────────────────
//  It does not book maintenance, change a machine's status, or touch
//  the planner. It produces a list of machines to go and look at, in
//  the order somebody should look at them. Every threshold is named in
//  the response so a disagreement is about a number rather than about
//  whether the thing works.
// ══════════════════════════════════════════════════════════════════

const Machine          = require('../models/Machine');
const ShiftDetail      = require('../models/ShiftDetail');
const EtaRatePosterior = require('../models/EtaRatePosterior');
const MachineIssue     = require('../models/MachineIssue');

const { welchDropTest, benjaminiHochberg, summarise, median } = require('../utils/stats');

// ── The knobs, all reported in the response ──────────────────────

/** Shifts in the "how is it running now" window. */
const RECENT_SHIFTS = 20;
/** Shifts before that which form the machine's own baseline. */
const BASELINE_SHIFTS = 60;
/** Below this in either window there is nothing to compare. */
const MIN_PER_WINDOW = 8;
/**
 * A fall smaller than this is not worth a fitter's morning even when it
 * is statistically real. Significance says "this is not noise"; the
 * threshold says "this is worth acting on". Both have to hold.
 */
const MATERIAL_DROP_PCT = 10;
/** False-discovery rate across every machine tested in the run. */
const FDR = 0.10;
/** How far back issues are counted as corroboration. */
const ISSUE_WINDOW_DAYS = 90;

/** How the report works, in one paragraph, returned with every call. */
const METHOD =
  "Each shift's metres per head is divided by what the (elastic, machine) posterior " +
  'expects for that pair, so a product change is not read as a fault. The recent window ' +
  "is compared with the machine's own earlier shifts by a one-tailed Welch test, and " +
  `every machine's p-value is corrected together at a ${FDR * 100}% false-discovery rate.`;

// ── Building the normalised series ───────────────────────────────

/**
 * One observation per closed shift: metres per head, as a fraction of
 * what this (elastic, machine) pair normally produces.
 *
 * Shifts with no elastic attributable to them are dropped rather than
 * pooled. Without knowing the product there is no expectation to divide
 * by, and pooling them under a plant average would reintroduce exactly
 * the product-mix error this normalisation exists to remove.
 */
async function loadSeries({ machineIds, since }) {
  const filter = {
    machine: { $in: machineIds },
    status: 'closed',
    productionMeters: { $gt: 0 },
  };
  if (since) filter.date = { $gte: since };

  const shifts = await ShiftDetail.find(filter)
    .select('machine date productionMeters elastics job')
    .sort({ date: 1 })
    .lean();

  // The posterior, keyed by pair.
  const posteriors = await EtaRatePosterior.find({ machine: { $in: machineIds } })
    .select('elastic machine shape rate observations')
    .lean();

  const expected = new Map();
  for (const p of posteriors) {
    if (!(p.rate > 0)) continue;
    expected.set(`${p.machine}|${p.elastic}`, {
      mean: p.shape / p.rate,
      observations: p.observations || 0,
    });
  }

  const byMachine = new Map();
  for (const id of machineIds) byMachine.set(String(id), []);

  for (const s of shifts) {
    // A shift carries a head→elastic snapshot (ShiftDetail.elastics);
    // a single-elastic shift is the common case and the only one that
    // can be attributed to one pair cleanly.
    const heads = Array.isArray(s.elastics) ? s.elastics : [];
    const elasticIds = [...new Set(heads.map((h) => String(h.elastic)).filter(Boolean))];
    if (elasticIds.length !== 1) continue;

    const key = `${s.machine}|${elasticIds[0]}`;
    const exp = expected.get(key);
    // No posterior for this pair means nothing to normalise against.
    // Two observations is not an expectation either.
    if (!exp || exp.mean <= 0 || exp.observations < 3) continue;

    const headCount = heads.length || 1;
    const perHead = s.productionMeters / headCount;

    byMachine.get(String(s.machine))?.push({
      at: s.date,
      ratio: perHead / exp.mean,
      elastic: elasticIds[0],
      perHead,
    });
  }

  return byMachine;
}

// ── The verdict for one machine ──────────────────────────────────

function assess(series) {
  if (series.length < MIN_PER_WINDOW * 2) {
    return {
      verdict: 'insufficient-data',
      // Not "healthy". A machine nobody has enough shifts for is a
      // machine nobody knows about, and reporting it as fine is the
      // quiet way this kind of report loses its usefulness.
      shifts: series.length,
      recent: null, baseline: null, dropPct: null, p: 1,
    };
  }

  const recent   = series.slice(-RECENT_SHIFTS);
  const baseline = series.slice(-(RECENT_SHIFTS + BASELINE_SHIFTS), -RECENT_SHIFTS);

  if (recent.length < MIN_PER_WINDOW || baseline.length < MIN_PER_WINDOW) {
    return { verdict: 'insufficient-data', shifts: series.length, recent: null, baseline: null, dropPct: null, p: 1 };
  }

  const r = summarise(recent.map((x) => x.ratio));
  const b = summarise(baseline.map((x) => x.ratio));
  const { z, p, dropPct } = welchDropTest(r, b);

  return {
    verdict: null,        // decided after the multiple-comparison pass
    shifts: series.length,
    recent:   { shifts: r.n, meanRatio: round(r.mean), from: recent[0].at, to: recent[recent.length - 1].at },
    baseline: { shifts: b.n, meanRatio: round(b.mean), from: baseline[0].at, to: baseline[baseline.length - 1].at },
    dropPct: dropPct != null ? Math.round(dropPct * 10) / 10 : null,
    z: Math.round(z * 100) / 100,
    p,
    // How much of the recent window is below the old baseline. A drop
    // carried by one catastrophic shift is a different problem from one
    // spread across a fortnight, and only the second is wear.
    shiftsBelowBaseline: recent.filter((x) => x.ratio < b.mean).length,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

// ── The report ───────────────────────────────────────────────────

/**
 * Which machines are running below their own recent history.
 *
 * Always returns every machine, with a verdict on each — including
 * "insufficient-data", which is a real answer and the honest one for a
 * loom that has run eleven shifts.
 */
async function analyse({ sinceDays = 240, includeHealthy = true } = {}) {
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const machines = await Machine.find({})
    .select('ID status NoOfHead NoOfHooks manufacturer')
    .lean();
  if (machines.length === 0) {
    return {
      machines: [], watch: [],
      thresholds: describeThresholds(), method: METHOD,
      note: 'No machines on file.',
    };
  }

  const ids = machines.map((m) => m._id);
  const series = await loadSeries({ machineIds: ids, since });

  // ── Issues, as corroboration only ──
  //
  // Deliberately not part of the test. A loom with three reported
  // faults and steady output is being looked after; a loom with none
  // and a falling rate is the one nobody has noticed yet. Issues change
  // how a finding READS, never whether it is a finding.
  const issueSince = new Date(Date.now() - ISSUE_WINDOW_DAYS * 86_400_000);
  const issues = await MachineIssue.find({
    machine: { $in: ids },
    createdAt: { $gte: issueSince },
  }).select('machine severity status createdAt').lean();

  const issuesByMachine = new Map();
  for (const i of issues) {
    const k = String(i.machine);
    if (!issuesByMachine.has(k)) issuesByMachine.set(k, { total: 0, severe: 0, open: 0 });
    const agg = issuesByMachine.get(k);
    agg.total += 1;
    if (i.severity === 'high' || i.severity === 'critical') agg.severe += 1;
    if (!['resolved', 'rejected'].includes(i.status)) agg.open += 1;
  }

  // ── Assess every machine, then correct across all of them ──
  const assessed = machines.map((m) => ({
    machineId: String(m._id),
    machineID: m.ID,
    status: m.status,
    heads: m.NoOfHead,
    issues: issuesByMachine.get(String(m._id)) || { total: 0, severe: 0, open: 0 },
    ...assess(series.get(String(m._id)) || []),
  }));

  const testable = assessed.filter((a) => a.verdict !== 'insufficient-data');
  const pass = benjaminiHochberg(testable.map((a) => a.p), FDR);
  testable.forEach((a, i) => { a.significant = pass[i]; });

  for (const a of assessed) {
    if (a.verdict === 'insufficient-data') continue;

    const material = a.dropPct != null && a.dropPct >= MATERIAL_DROP_PCT;
    // Both have to hold. Significance alone flags a 3% fall on a very
    // steady machine, which is true and not worth anybody's morning;
    // the threshold alone flags noise on an erratic one.
    a.verdict = a.significant && material ? 'watch' : 'ok';

    a.reasons = [];
    if (a.verdict === 'watch') {
      a.reasons.push(
        `Running ${a.dropPct}% below its own ${a.baseline.shifts}-shift baseline ` +
        `over the last ${a.recent.shifts} shifts.`
      );
      if (a.shiftsBelowBaseline >= a.recent.shifts * 0.7) {
        a.reasons.push(
          `${a.shiftsBelowBaseline} of ${a.recent.shifts} recent shifts are below it — ` +
          'a sustained fall rather than one bad day.'
        );
      }
      if (a.issues.severe > 0) {
        a.reasons.push(
          `${a.issues.severe} high-severity issue${a.issues.severe === 1 ? '' : 's'} ` +
          `reported in the last ${ISSUE_WINDOW_DAYS} days.`
        );
      }
      if (a.status === 'maintenance') {
        // Saying "service this" about a machine already stripped is how
        // a report teaches people to ignore it.
        a.reasons.push('Already in maintenance — this may be the fault being worked on.');
      }
    }
  }

  const watch = assessed
    .filter((a) => a.verdict === 'watch')
    .sort((a, b) => b.dropPct - a.dropPct);

  return {
    machines: includeHealthy ? assessed : assessed.filter((a) => a.verdict !== 'ok'),
    watch,
    thresholds: describeThresholds(),
    method: METHOD,
    note: watch.length === 0
      ? `No machine is running materially below its own baseline. ${
          assessed.filter((a) => a.verdict === 'insufficient-data').length
        } have too few attributable shifts to judge.`
      : null,
  };
}

function describeThresholds() {
  return {
    recentShifts: RECENT_SHIFTS,
    baselineShifts: BASELINE_SHIFTS,
    minPerWindow: MIN_PER_WINDOW,
    materialDropPct: MATERIAL_DROP_PCT,
    fdr: FDR,
    issueWindowDays: ISSUE_WINDOW_DAYS,
  };
}

/**
 * Normalised drift over two DATE windows, per machine.
 *
 * The other consumer of this series. GET /machine/predictive-health
 * asks a different question — "what changed in the last week" rather
 * than "is this below its own long-run baseline" — and needs its own
 * windows, but it must not ask it of raw metres.
 *
 * It did, until this existed: it summed productionMeters over 7 days
 * against the 21 before, so a loom moved from a 1000 m/shift product to
 * a 500 m/shift one showed a 50% "output drop" and lost 35 points of
 * health score for doing exactly what it was told to.
 *
 * Returns percent-of-expected for each window, which is the honest
 * thing to compare and reads better on screen than a metre figure whose
 * meaning changed halfway through the period.
 */
async function driftByMachine({ recentDays = 7, baselineDays = 21, now = new Date() } = {}) {
  const recentFrom   = new Date(now.getTime() - recentDays * 86_400_000);
  const baselineFrom = new Date(now.getTime() - (recentDays + baselineDays) * 86_400_000);

  const machines = await Machine.find({}).select('_id').lean();
  const series = await loadSeries({ machineIds: machines.map((m) => m._id), since: baselineFrom });

  const out = new Map();
  for (const [machineId, points] of series.entries()) {
    const recent   = points.filter((p) => p.at >= recentFrom);
    const baseline = points.filter((p) => p.at < recentFrom);

    // No comparison is possible, which is not the same as no drop.
    // Reported as zero drift so the caller applies no penalty, and the
    // counts are returned so it can tell the two apart if it cares.
    if (recent.length === 0 || baseline.length === 0) {
      out.set(machineId, {
        dropPct: 0, recentPctOfExpected: null, baselinePctOfExpected: null,
        recentShifts: recent.length, baselineShifts: baseline.length,
      });
      continue;
    }

    const r = summarise(recent.map((p) => p.ratio));
    const b = summarise(baseline.map((p) => p.ratio));
    const drop = b.mean > 0 ? ((b.mean - r.mean) / b.mean) * 100 : 0;

    out.set(machineId, {
      // Only falls are reported. A machine running ABOVE its baseline is
      // not a maintenance concern, and a negative "drop" would read as
      // one on a screen that only ever subtracts points.
      dropPct: Math.max(0, Math.round(drop)),
      recentPctOfExpected: Math.round(r.mean * 100),
      baselinePctOfExpected: Math.round(b.mean * 100),
      recentShifts: r.n,
      baselineShifts: b.n,
    });
  }
  return out;
}

module.exports = {
  analyse, driftByMachine,
  _internals: {
    loadSeries, assess, describeThresholds,
    RECENT_SHIFTS, BASELINE_SHIFTS, MIN_PER_WINDOW, MATERIAL_DROP_PCT, FDR,
  },
};
