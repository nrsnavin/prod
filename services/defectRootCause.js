'use strict';
// ══════════════════════════════════════════════════════════════════
//  POINTING THE LOT TRAIL THE OTHER WAY
//
//  YarnLot → WarpingBatch → beam → job → elastic was built to answer
//  "where did this lot go". Run backwards from the QC records it
//  answers "what is causing this defect" — which is what it was worth
//  building for, and the direction nothing has ever read it in.
//
//  ── This is a group-by and a chi-square, not a model ──────────────
//  Claude writes the sentence at the end and touches none of the
//  arithmetic. Every figure here is reproducible by hand from the same
//  four collections, which matters because the output of this service
//  is an accusation: it names a lot, a machine, a shift or a person.
//
//  ── Three ways a report like this lies, and what is done about it ─
//
//  1. MULTIPLE COMPARISONS. Test forty lots against a 5% threshold and
//     two will look guilty by chance alone. A naive "significant at
//     p<0.05" report would therefore name an innocent lot most weeks —
//     and be believed, because it came with a number. Every p-value
//     here goes through a Benjamini–Hochberg correction across ALL
//     candidates tested in the run, and `significant` means survived
//     that, not survived a raw threshold.
//
//  2. THIN SAMPLES. One check on a lot that failed is a 100% defect
//     rate. MIN_SAMPLES keeps those out of the findings entirely rather
//     than reporting them with a caveat nobody reads.
//
//  3. CONFOUNDING. A bad lot and a weak operator usually appear
//     together, because the same job carried both — so both light up
//     and one of them is innocent. The pair is detected and reported
//     alongside the finding. It cannot be resolved from observational
//     data, and pretending otherwise would be the most damaging thing
//     this service could do to somebody's job.
// ══════════════════════════════════════════════════════════════════

const QcRecord     = require('../models/QcRecord');
const WarpingBatch = require('../models/WarpingBatch');
const ShiftDetail  = require('../models/ShiftDetail');

const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion, systemPrompt } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

/** Below this many checks, a factor value is not reported as a finding. */
const MIN_SAMPLES = 8;
/** False-discovery rate for the Benjamini–Hochberg correction. */
const FDR = 0.10;
/** Above this share of shared checks, two findings are confounded. */
const CONFOUND_OVERLAP = 0.6;

// ── Statistics ───────────────────────────────────────────────────
//
// The tests, the correction and the reasoning behind choosing them live
// in utils/stats.js, which the machine-health report shares. They were
// written here first and moved once there were two callers: duplicating
// them was how the multiple-comparison correction would eventually end
// up applied in one report and quietly forgotten in the other.
const { erfc, chiSquare2x2, benjaminiHochberg } = require('../utils/stats');

// ── Assembling the observations ──────────────────────────────────

/**
 * Every QC check in the window, with the factors that touched it.
 *
 * One check maps to SEVERAL values of each factor: a job runs on more
 * than one machine, over more than one shift, from more than one lot.
 * That is the honest shape and it is what makes the confounding real —
 * an attribution that pretended each check had exactly one cause would
 * be tidier and wrong.
 */
async function loadChecks({ since, elasticId } = {}) {
  const filter = {};
  if (since) filter.createdAt = { $gte: since };
  if (elasticId) filter.elastic = elasticId;

  const checks = await QcRecord.find(filter)
    .select('job elastic overallResult defectCode rejectedMeters createdAt')
    .lean();
  if (checks.length === 0) return [];

  const jobIds = [...new Set(checks.map((c) => String(c.job)))];

  // ── The lot trail, per job ──
  const batches = await WarpingBatch.find({
    job: { $in: jobIds },
    // A planned batch drew no yarn, and a cancelled one gave it back.
    // Neither put anything into the cloth, so neither can have caused a
    // defect in it.
    status: { $in: ['issued', 'completed'] },
  }).select('job elastics allocations').lean();

  const lotsByJob = new Map();
  for (const b of batches) {
    const key = String(b.job);
    if (!lotsByJob.has(key)) lotsByJob.set(key, []);
    for (const a of b.allocations || []) {
      if (!a.yarnLot) continue;
      lotsByJob.get(key).push({
        id: String(a.yarnLot),
        label: a.lotNo || String(a.yarnLot).slice(-6),
        // Empty means the batch was job-wide — the operator did not say
        // which elastic it warped and the job had several. Recorded as
        // such rather than guessed.
        elastics: (b.elastics || []).map(String),
      });
    }
  }

  // ── Machine, operator and shift, per job ──
  const details = await ShiftDetail.find({ job: { $in: jobIds } })
    .select('job machine employee shift')
    .populate('machine', 'ID')
    .populate('employee', 'name')
    .lean();

  const runsByJob = new Map();
  for (const d of details) {
    const key = String(d.job);
    if (!runsByJob.has(key)) runsByJob.set(key, []);
    runsByJob.get(key).push({
      machineId:    d.machine ? String(d.machine._id) : null,
      machineLabel: d.machine?.ID || null,
      operatorId:   d.employee ? String(d.employee._id) : null,
      operatorLabel: d.employee?.name || null,
      shift:        d.shift || null,
    });
  }

  return checks.map((c) => {
    const jobKey = String(c.job);
    const elasticKey = String(c.elastic);
    const allLots = lotsByJob.get(jobKey) || [];

    // Prefer lots the batch attributed to THIS elastic. A job-wide
    // batch is included too — it genuinely may have gone into this
    // cloth, and dropping it would hide a real cause.
    const lots = allLots.filter((l) => l.elastics.length === 0 || l.elastics.includes(elasticKey));
    const runs = runsByJob.get(jobKey) || [];

    return {
      id: String(c._id),
      failed: c.overallResult === 'fail',
      defectCode: c.defectCode || '',
      rejectedMeters: c.rejectedMeters || 0,
      at: c.createdAt,
      lots:      dedupe(lots.map((l) => ({ key: l.id, label: l.label }))),
      machines:  dedupe(runs.filter((r) => r.machineId).map((r) => ({ key: r.machineId, label: r.machineLabel }))),
      operators: dedupe(runs.filter((r) => r.operatorId).map((r) => ({ key: r.operatorId, label: r.operatorLabel }))),
      shifts:    dedupe(runs.filter((r) => r.shift).map((r) => ({ key: r.shift, label: r.shift }))),
    };
  });
}

function dedupe(items) {
  const seen = new Map();
  for (const it of items) if (!seen.has(it.key)) seen.set(it.key, it);
  return [...seen.values()];
}

// ── The attribution ──────────────────────────────────────────────

const FACTORS = [
  { key: 'lot',      field: 'lots',      noun: 'yarn lot' },
  { key: 'machine',  field: 'machines',  noun: 'machine' },
  { key: 'operator', field: 'operators', noun: 'operator' },
  { key: 'shift',    field: 'shifts',    noun: 'shift' },
];

/**
 * Defect rate per value of one factor, against the rest.
 *
 * `lift` is the ratio of this value's fail rate to everyone else's — a
 * lift of 2.4 means this lot fails 2.4 times as often as the rest of
 * the plant. Ratio rather than difference on purpose: two points of
 * difference means something very different at a 1% base rate than at
 * a 30% one, and the person reading this is comparing across factors.
 */
function tabulate(checks, factor) {
  const totalFails = checks.filter((c) => c.failed).length;
  const rows = new Map();

  for (const c of checks) {
    for (const v of c[factor.field]) {
      if (!rows.has(v.key)) rows.set(v.key, { key: v.key, label: v.label, checks: 0, fails: 0, checkIds: new Set() });
      const r = rows.get(v.key);
      r.checks += 1;
      r.checkIds.add(c.id);
      if (c.failed) r.fails += 1;
    }
  }

  const out = [];
  for (const r of rows.values()) {
    const otherChecks = checks.length - r.checks;
    const otherFails  = totalFails - r.fails;
    const rate  = r.checks > 0 ? r.fails / r.checks : 0;
    const other = otherChecks > 0 ? otherFails / otherChecks : 0;

    const { chi2, p } = chiSquare2x2(
      r.fails, r.checks - r.fails,
      otherFails, otherChecks - otherFails
    );

    out.push({
      factor: factor.key,
      noun: factor.noun,
      key: r.key,
      label: r.label,
      checks: r.checks,
      fails: r.fails,
      failRatePct: Math.round(rate * 1000) / 10,
      restFailRatePct: Math.round(other * 1000) / 10,
      // Undefined rather than Infinity when nothing else ever failed —
      // "infinitely worse than a perfect record" is not a usable number.
      lift: other > 0 ? Math.round((rate / other) * 100) / 100 : null,
      chi2: Math.round(chi2 * 100) / 100,
      p,
      _checkIds: r.checkIds,
    });
  }
  return out;
}

/**
 * Which findings ride on the same checks.
 *
 * The report's own warning: a bad lot and a weak operator often
 * coincide. If two findings share most of their evidence, the data
 * cannot separate them, and saying which one is at fault would be an
 * invention. Both are reported, paired, with the overlap stated.
 */
function findConfounders(findings) {
  const pairs = [];
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const a = findings[i], b = findings[j];
      if (a.factor === b.factor) continue;      // same factor: not a confound

      let shared = 0;
      for (const id of a._checkIds) if (b._checkIds.has(id)) shared += 1;
      const overlap = shared / Math.min(a._checkIds.size, b._checkIds.size);

      if (overlap >= CONFOUND_OVERLAP) {
        pairs.push({
          a: { factor: a.factor, label: a.label },
          b: { factor: b.factor, label: b.label },
          sharedChecks: shared,
          overlapPct: Math.round(overlap * 100),
          note: `${a.noun} ${a.label} and ${b.noun} ${b.label} appear on the same ${shared} checks. ` +
                'The data cannot tell which of the two is responsible.',
        });
      }
    }
  }
  return pairs;
}

/**
 * The whole picture.
 *
 * Always returns a shape, never throws on thin data — a quiet month is
 * a real answer and should read like one.
 */
async function analyse({ days = 90, elasticId, minSamples = MIN_SAMPLES } = {}) {
  const since = new Date(Date.now() - days * 86_400_000);
  const checks = await loadChecks({ since, elasticId });

  const fails = checks.filter((c) => c.failed).length;
  const totals = {
    checks: checks.length,
    fails,
    failRatePct: checks.length > 0 ? Math.round((fails / checks.length) * 1000) / 10 : null,
    rejectedMeters: checks.reduce((s, c) => s + c.rejectedMeters, 0),
  };

  const base = { windowDays: days, since: since.toISOString().slice(0, 10), totals };

  if (checks.length === 0) {
    return { ...base, factors: {}, findings: [], confounders: [], note: 'No QC checks in this window.' };
  }
  if (fails === 0) {
    return {
      ...base, factors: {}, findings: [], confounders: [],
      note: `${checks.length} checks and no failures in this window — nothing to attribute.`,
    };
  }

  // ── Tabulate every factor ──
  const factors = {};
  const candidates = [];
  for (const f of FACTORS) {
    const rows = tabulate(checks, f);
    factors[f.key] = rows
      .map(({ _checkIds, p, ...rest }) => ({ ...rest, p: Math.round(p * 10000) / 10000 }))
      .sort((a, b) => b.failRatePct - a.failRatePct);
    // Only rows with enough evidence enter the significance testing.
    // Including the thin ones would inflate the correction's denominator
    // and bury the real findings under rows that could never qualify.
    candidates.push(...rows.filter((r) => r.checks >= minSamples && r.fails > 0));
  }

  // ── Correct for having asked many questions ──
  const pass = benjaminiHochberg(candidates.map((c) => c.p), FDR);
  const significant = candidates
    .map((c, i) => ({ ...c, significant: pass[i] }))
    .filter((c) => c.significant && c.lift != null && c.lift > 1)
    .sort((a, b) => b.lift - a.lift);

  const confounders = findConfounders(significant);

  const findings = significant.map(({ _checkIds, ...f }) => ({
    ...f,
    p: Math.round(f.p * 10000) / 10000,
    headline:
      `${f.noun} ${f.label} failed ${f.fails} of ${f.checks} checks ` +
      `(${f.failRatePct}%) against ${f.restFailRatePct}% elsewhere — ${f.lift}× the rate.`,
  }));

  return {
    ...base,
    factors,
    findings,
    confounders,
    method: {
      minSamples,
      test: "2×2 chi-square with Yates' correction",
      correction: `Benjamini–Hochberg at ${FDR * 100}% false-discovery rate over ${candidates.length} candidates`,
    },
    note: findings.length === 0
      ? `${fails} failures across ${checks.length} checks, but nothing stands out beyond chance once the number of comparisons is accounted for.`
      : null,
  };
}

/**
 * The same attribution, with a sentence on top.
 *
 * Claude sees the FINISHED numbers and writes prose about them. It is
 * given no raw data and computes nothing — the same split as the
 * planner, for the same reason: every figure on this screen has to be
 * reproducible by hand, because it names a lot, a machine or a person.
 *
 * The narrative is strictly additive. If the model is unconfigured or
 * the call fails, the attribution is returned exactly as it would have
 * been, and the failure is recorded in the AI ledger rather than
 * swallowed.
 */
async function analyseWithNarrative(opts = {}) {
  const result = await analyse(opts);
  if (result.findings.length === 0) return { ...result, narrative: null, aiGenerated: false };

  const claude = anthropic();
  if (!claude) return { ...result, narrative: null, aiGenerated: false };

  const facts = [
    `Window: last ${result.windowDays} days. ${result.totals.checks} QC checks, ` +
      `${result.totals.fails} failures (${result.totals.failRatePct}%).`,
    'Findings, strongest first:',
    ...result.findings.slice(0, 6).map((f) => `- ${f.headline} (p=${f.p})`),
    ...(result.confounders.length
      ? ['Confounded pairs the data cannot separate:',
         ...result.confounders.slice(0, 4).map((c) => `- ${c.note}`)]
      : []),
  ].join('\n');

  const startedAt = Date.now();
  try {
    const msg = await claude.messages.create({
      model: TEXT_MODEL,
      max_tokens: 400,
      system: systemPrompt('defect-root-cause'),
      messages: [{ role: 'user', content: `${facts}\n\nWhat should the quality team look at first?` }],
    });
    const narrative = (msg.content || [])
      .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

    await ledger.record({
      surface: 'defect-root-cause',
      model: TEXT_MODEL,
      promptVersion: promptVersion('defect-root-cause'),
      proposed: { narrative, findings: result.findings.length },
      latencyMs: Date.now() - startedAt,
      usage: msg.usage,
    });

    return { ...result, narrative, aiGenerated: true };
  } catch (err) {
    console.warn('[defectRootCause] narrative failed:', err?.message);
    await ledger.record({
      surface: 'defect-root-cause',
      model: TEXT_MODEL,
      promptVersion: promptVersion('defect-root-cause'),
      latencyMs: Date.now() - startedAt,
      error: err?.message || String(err),
    });
    // The numbers are the product. A missing sentence is a smaller loss
    // than a 500 on the page that carries them.
    return { ...result, narrative: null, aiGenerated: false };
  }
}

module.exports = {
  analyse, analyseWithNarrative,
  _internals: {
    erfc, chiSquare2x2, benjaminiHochberg, tabulate, findConfounders,
    loadChecks, dedupe, FACTORS, MIN_SAMPLES, FDR, CONFOUND_OVERLAP,
  },
};
