#!/usr/bin/env node
'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE EVAL RUNNER
//
//  Replays a folder of hand-checked cases through the real AI surface
//  and reports how close it got. This is the thing that turns "the OCR
//  seems fine" into a number, and the number into a regression gate.
//
//  ── Why this cannot ship with sample data ────────────────────────
//  A golden set is a set of REAL inputs with answers a person checked
//  by eye. Inventing plausible-looking scans and calling the result an
//  eval would produce a number that measures nothing and reads exactly
//  like one that measures something — which is worse than having no
//  eval, because somebody would trust it. So `evals/cases/` ships
//  empty, and the runner says so rather than pretending.
//
//  See evals/README.md for how to add a case. Twenty sheets is enough
//  to be useful; the first ten will already tell you something.
//
//  ── Usage ────────────────────────────────────────────────────────
//    node scripts/run-evals.js                     # every surface
//    node scripts/run-evals.js --surface qc-vision
//    node scripts/run-evals.js --save-baseline     # pin today's result
//    node scripts/run-evals.js --tolerance 3       # allowed drop, in points
//
//  Exit codes: 0 pass, 1 regression against the baseline, 2 could not
//  run (no key, no cases). A CI job can gate on this directly.
// ══════════════════════════════════════════════════════════════════

require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', '.env') });

const fs   = require('fs');
const path = require('path');
const S    = require('../evals/score');

const CASES_DIR   = path.join(__dirname, '..', 'evals', 'cases');
const BASELINE    = path.join(__dirname, '..', 'evals', 'baseline.json');
const SURFACES    = ['shift-sheet-ocr', 'qc-vision'];

// ── argv, kept deliberately dumb ─────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : fallback;
};
const only        = flag('surface');
const saveBaseline= Boolean(flag('save-baseline'));
const tolerance   = Number(flag('tolerance', 2)) || 2;

const log = (...a) => console.log(...a);
const bar = (n = 66) => log('─'.repeat(n));

/**
 * Load the cases for a surface.
 *
 * A case is a pair: an input file and a sibling `<name>.expected.json`.
 * Pairing by name rather than by a manifest means adding a case is
 * dropping in two files, which is the difference between a golden set
 * that grows and one that was built once.
 */
function loadCases(surface, root = CASES_DIR) {
  const dir = path.join(root, surface);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.expected.json') && !f.startsWith('EXAMPLE'))
    .map((f) => {
      const base = f.replace('.expected.json', '');
      const input = fs.readdirSync(dir).find(
        (x) => x.startsWith(`${base}.`) && !x.endsWith('.expected.json')
      );
      if (!input) return null;
      return {
        name: base,
        inputPath: path.join(dir, input),
        expected: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
      };
    })
    .filter(Boolean);
}

// ══════════════════════════════════════════════════════════════════
//  SURFACE RUNNERS
// ══════════════════════════════════════════════════════════════════
async function runShiftSheet(cases) {
  const { extractShiftRows } = require('../utils/shiftSheetOcr');
  const scored = [];

  for (const c of cases) {
    const startedAt = Date.now();
    const out = await extractShiftRows(fs.readFileSync(c.inputPath));
    const score = S.scoreShiftSheet(c.expected, out.rows);
    score._name = c.name;
    score._ms = Date.now() - startedAt;
    scored.push(score);

    log(`  ${c.name.padEnd(28)} ${String(score.rows.found).padStart(3)}/${String(score.rows.expected).padEnd(3)} rows` +
        `  prod ${String(score.fields.production.accuracyPct ?? '—').padStart(5)}%` +
        `  timer ${String(score.fields.timer.accuracyPct ?? '—').padStart(5)}%` +
        `  ${(score._ms / 1000).toFixed(1)}s`);

    // The mistakes are the point of running this at all — a bare
    // percentage tells you something moved, not what to fix.
    for (const m of score.mistakes.slice(0, 5)) {
      log(`      ${m.code} ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`);
    }
    if (score.mistakes.length > 5) log(`      … and ${score.mistakes.length - 5} more`);
  }

  return S.aggregateShiftSheet(scored);
}

async function runQcVision(cases) {
  const { classifyDefect } = require('../utils/qcVision');
  const scored = [];

  const mime = (p) => ({
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  }[path.extname(p).toLowerCase()]);

  for (const c of cases) {
    const type = mime(c.inputPath);
    if (!type) { log(`  ${c.name}: skipped — unsupported image type`); continue; }

    const startedAt = Date.now();
    const out = await classifyDefect(fs.readFileSync(c.inputPath), type, c.expected.spec || {});
    const score = S.scoreQcVision(c.expected, out);
    scored.push(score);

    const mark = score.verdictCorrect ? '✓' : (score.missedDefect ? '✗ MISSED' : '✗ false alarm');
    log(`  ${c.name.padEnd(28)} ${mark.padEnd(14)} ` +
        `want ${c.expected.overallResult}/${c.expected.defectCode || '—'}  ` +
        `got ${out?.overallResult}/${out?.defectCode || '—'}  ` +
        `conf ${out?.confidence ?? '—'}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }

  return S.aggregateQcVision(scored);
}

const RUNNERS = { 'shift-sheet-ocr': runShiftSheet, 'qc-vision': runQcVision };

// ══════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('ANTHROPIC_API_KEY is not set — the eval calls a real model, so there is');
    log('nothing to run. Set it in config/.env.');
    process.exit(2);
  }

  const surfaces = only ? [only] : SURFACES;
  for (const s of surfaces) {
    if (!RUNNERS[s]) { log(`Unknown surface "${s}". Known: ${SURFACES.join(', ')}`); process.exit(2); }
  }

  const results = {};
  let ran = 0;

  for (const surface of surfaces) {
    const cases = loadCases(surface);
    bar();
    log(`${surface} — ${cases.length} case${cases.length === 1 ? '' : 's'}`);
    bar();

    if (cases.length === 0) {
      log(`  No cases in evals/cases/${surface}/.`);
      log('  This suite ships empty on purpose: a golden set is real inputs with');
      log('  answers a person checked. See evals/README.md to add one.');
      continue;
    }

    results[surface] = await RUNNERS[surface](cases);
    ran += cases.length;
    log('');
    log(`  ${JSON.stringify(results[surface], null, 2).split('\n').join('\n  ')}`);
  }

  if (ran === 0) {
    bar();
    log('Nothing was evaluated. Add cases before trusting any number from here.');
    process.exit(2);
  }

  // ── Baseline ────────────────────────────────────────────────────
  const baseline = fs.existsSync(BASELINE)
    ? JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
    : null;

  if (saveBaseline) {
    const { TEXT_MODEL, VISION_MODEL } = require('../utils/anthropicClient');
    const { PROMPTS } = require('../utils/aiPrompts');
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify({
      // Stamped so a later comparison can say WHAT changed, not just
      // that something did. A baseline with no model or prompt version
      // beside it cannot distinguish a bad prompt edit from a model
      // that moved underneath you.
      recordedAt: new Date().toISOString(),
      models: { text: TEXT_MODEL, vision: VISION_MODEL },
      prompts: Object.fromEntries(Object.entries(PROMPTS).map(([k, v]) => [k, v.version])),
      results,
    }, null, 2)}\n`);
    bar();
    log(`Baseline written to ${path.relative(process.cwd(), BASELINE)}`);
    process.exit(0);
  }

  bar();
  const cmp = S.compareToBaseline(results, baseline?.results, tolerance);

  if (cmp.status === 'no-baseline') {
    log('No baseline stored. Run with --save-baseline once you are happy with');
    log('the numbers above; from then on this exits 1 when they drop.');
    process.exit(0);
  }

  if (cmp.status === 'ok') {
    log(`No regression against the baseline of ${baseline.recordedAt} (tolerance ${tolerance} pts).`);
    if (baseline.models?.vision) log(`Baseline vision model: ${baseline.models.vision}`);
    process.exit(0);
  }

  log(`REGRESSION against the baseline of ${baseline.recordedAt}:`);
  for (const r of cmp.regressions) {
    log(`  ${r.metric}: ${r.baseline}% → ${r.current}%  (−${r.dropPts} pts)`);
  }
  // The two things that most often explain a drop, printed without
  // being asked, because the first question is always "what changed?"
  const { TEXT_MODEL, VISION_MODEL } = require('../utils/anthropicClient');
  const { PROMPTS } = require('../utils/aiPrompts');
  if (baseline.models && (baseline.models.vision !== VISION_MODEL || baseline.models.text !== TEXT_MODEL)) {
    log(`  ! the model changed since the baseline: ${JSON.stringify(baseline.models)} → ` +
        `${JSON.stringify({ text: TEXT_MODEL, vision: VISION_MODEL })}`);
  }
  for (const [k, v] of Object.entries(baseline.prompts || {})) {
    if (PROMPTS[k] && PROMPTS[k].version !== v) log(`  ! prompt "${k}" moved ${v} → ${PROMPTS[k].version}`);
  }
  process.exit(1);
}

// Exported so the case-pairing rule — the fiddly part, and the one that
// silently drops a case if it gets it wrong — can be tested without an
// API key. Running the file still runs the eval.
module.exports = { loadCases, CASES_DIR };

if (require.main === module) {
  main().catch((err) => {
    console.error('eval run failed:', err.message);
    process.exit(2);
  });
}
