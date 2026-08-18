'use strict';
// ══════════════════════════════════════════════════════════════════
//  SCORING — kept apart from the runner on purpose
//
//  The runner spends money: it uploads real scans to a vision model and
//  waits. The scoring is pure arithmetic over two objects. Splitting
//  them means the half that decides whether the OCR got better can be
//  tested exhaustively, for free, with no API key and no golden files —
//  and a bug in the SCORER, which would otherwise show up as a mystery
//  accuracy cliff, gets caught by a unit test instead.
//
//  ── What is being measured, and why not just "accuracy" ───────────
//  A single percentage hides the two failures that matter and are not
//  interchangeable:
//
//    • a row the OCR never returned (recall) means an operator has to
//      find it and type it in — annoying, and obvious on screen.
//    • a row the OCR returned WRONG (field accuracy) means an operator
//      might not notice at all, and a wrong production figure flows
//      into payroll, order progress and every rate estimate downstream.
//
//  The second is much worse than the first, so they are reported apart
//  and never averaged together.
// ══════════════════════════════════════════════════════════════════

/** Round to one decimal — enough resolution, no false precision. */
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

/** The comparison rule shared with the ledger: loose, on purpose. */
const same = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a).trim() === String(b).trim();
};

/**
 * Score one shift-sheet OCR reading against its hand-checked answer.
 *
 * expected: { rows: { "SD-8F3A2C": { production, timer, remarks } } }
 * actual:   the `rows` array from utils/shiftSheetOcr.extractShiftRows
 *
 * Returns per-column accuracy over the rows that were FOUND, plus the
 * recall and spurious-row counts that say how much was missed and how
 * much was invented. A model that returns two rows perfectly and skips
 * the other 198 must not be able to report 100%.
 */
function scoreShiftSheet(expected, actualRows) {
  const want = expected.rows || {};
  const got = new Map((actualRows || []).map((r) => [String(r.code).toUpperCase(), r]));

  const codes = Object.keys(want);
  const found = codes.filter((c) => got.has(c.toUpperCase()));
  // Rows the model produced that the sheet does not contain. These are
  // the dangerous ones — an invented code either silently drops (no
  // match) or, worse, collides with a real row on another plan.
  const spurious = [...got.keys()].filter(
    (c) => !codes.some((k) => k.toUpperCase() === c)
  );

  const fields = ['production', 'timer', 'remarks'];
  const correct = Object.fromEntries(fields.map((f) => [f, 0]));
  const graded = Object.fromEntries(fields.map((f) => [f, 0]));
  const mistakes = [];

  for (const code of found) {
    const w = want[code];
    const g = got.get(code.toUpperCase());
    for (const f of fields) {
      // A field the answer key does not assert is not graded — a golden
      // set is allowed to be partial rather than forcing somebody to
      // transcribe remarks they do not care about.
      if (!(f in w)) continue;
      graded[f] += 1;
      if (same(w[f], g[f])) correct[f] += 1;
      else mistakes.push({ code, field: f, expected: w[f], got: g[f] });
    }
  }

  return {
    rows: { expected: codes.length, found: found.length, missed: codes.length - found.length, spurious: spurious.length },
    recallPct: pct(found.length, codes.length),
    fields: Object.fromEntries(fields.map((f) => [f, {
      graded: graded[f], correct: correct[f], accuracyPct: pct(correct[f], graded[f]),
    }])),
    // Every row right, in every graded column, and nothing invented.
    perfectPct: pct(
      found.filter((code) => fields.every((f) => !(f in want[code]) || same(want[code][f], got.get(code.toUpperCase())[f]))).length,
      codes.length
    ),
    mistakes,
  };
}

/**
 * Score one QC vision draft against the inspector's verdict.
 *
 * expected: { overallResult, defectCode? }
 * actual:   the object returned by utils/qcVision.classifyDefect
 *
 * pass/fail and the defect CLASS are scored separately because they
 * fail differently: calling a good roll bad wastes an inspection, while
 * calling a bad roll good ships it. Both directions are counted, so a
 * model that has learned to say "pass" cannot hide behind an average.
 */
function scoreQcVision(expected, actual) {
  const wantFail = expected.overallResult === 'fail';
  const gotFail = actual?.overallResult === 'fail';

  return {
    verdictCorrect: wantFail === gotFail,
    // The asymmetric one: a defect that was there and was not called.
    missedDefect: wantFail && !gotFail,
    falseAlarm: !wantFail && gotFail,
    // Only meaningful when both agree there IS a defect.
    defectClassCorrect:
      wantFail && gotFail && expected.defectCode
        ? same(expected.defectCode, actual.defectCode)
        : null,
    confidence: actual?.confidence ?? null,
  };
}

/** Fold per-case QC scores into the summary the runner prints. */
function aggregateQcVision(cases) {
  const n = cases.length;
  const missed = cases.filter((c) => c.missedDefect).length;
  const alarms = cases.filter((c) => c.falseAlarm).length;
  const classed = cases.filter((c) => c.defectClassCorrect !== null);

  return {
    cases: n,
    verdictAccuracyPct: pct(cases.filter((c) => c.verdictCorrect).length, n),
    // Reported as counts, not a rate: with a golden set of 30 photos a
    // percentage invites more confidence than 30 photos can support.
    missedDefects: missed,
    falseAlarms: alarms,
    defectClassAccuracyPct: pct(classed.filter((c) => c.defectClassCorrect).length, classed.length),
  };
}

/** Fold per-case shift-sheet scores into one summary. */
function aggregateShiftSheet(cases) {
  const sum = (f) => cases.reduce((a, c) => a + f(c), 0);
  const gradedFor = (f) => sum((c) => c.fields[f].graded);
  const correctFor = (f) => sum((c) => c.fields[f].correct);

  return {
    cases: cases.length,
    rows: {
      expected: sum((c) => c.rows.expected),
      found:    sum((c) => c.rows.found),
      missed:   sum((c) => c.rows.missed),
      spurious: sum((c) => c.rows.spurious),
    },
    recallPct: pct(sum((c) => c.rows.found), sum((c) => c.rows.expected)),
    fields: Object.fromEntries(['production', 'timer', 'remarks'].map((f) => [f, {
      graded: gradedFor(f), correct: correctFor(f), accuracyPct: pct(correctFor(f), gradedFor(f)),
    }])),
  };
}

/**
 * Compare a run against the stored baseline.
 *
 * A regression is a DROP beyond the tolerance, never a rise: models get
 * better as well as worse and blocking on "changed" would train
 * everybody to pass --save-baseline reflexively, which is the same as
 * having no baseline at all.
 */
function compareToBaseline(current, baseline, tolerancePts = 2) {
  if (!baseline) return { status: 'no-baseline', regressions: [] };

  const regressions = [];
  const walk = (cur, base, path = '') => {
    for (const [k, v] of Object.entries(cur || {})) {
      const p = path ? `${path}.${k}` : k;
      const b = base?.[k];
      if (v && typeof v === 'object') { walk(v, b, p); continue; }
      if (!/Pct$/.test(k)) continue;
      if (typeof v !== 'number' || typeof b !== 'number') continue;
      const drop = b - v;
      if (drop > tolerancePts) regressions.push({ metric: p, baseline: b, current: v, dropPts: Math.round(drop * 10) / 10 });
    }
  };
  walk(current, baseline);

  return { status: regressions.length ? 'regressed' : 'ok', regressions };
}

module.exports = {
  scoreShiftSheet, scoreQcVision,
  aggregateShiftSheet, aggregateQcVision,
  compareToBaseline, same, pct,
};
