'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SCORER, TESTED WITHOUT SPENDING A TOKEN
//
//  The eval runner uploads real scans to a vision model and waits. The
//  scorer is arithmetic over two objects. Splitting them means the half
//  that decides whether the OCR got better or worse can be tested
//  exhaustively, for free — and a bug in the SCORER, which would
//  otherwise surface as a mystery accuracy cliff nobody could reproduce,
//  gets caught here instead.
//
//  The properties that matter are all about what a single number can
//  hide:
//
//    • a model that reads two rows perfectly and skips the other 198
//      must not be able to report 100%
//    • a model that has learned to answer "pass" to every QC photo must
//      not be able to hide behind an average
//    • a regression gate must fire on a DROP and stay quiet on a rise,
//      or everyone learns to re-baseline reflexively
// ══════════════════════════════════════════════════════════════════

const S = require('../../evals/score');

const sheet = (rows) => ({ rows });
const ocrRow = (code, production, timer, remarks = '') =>
  ({ code, production, timer, remarks, confidence: 0.9 });

// ══════════════════════════════════════════════════════════════════
//  1. RECALL AND ACCURACY ARE NOT THE SAME NUMBER
// ══════════════════════════════════════════════════════════════════
describe('scoreShiftSheet', () => {
  test('a perfect reading scores 100 across the board', () => {
    const s = S.scoreShiftSheet(
      sheet({ 'SD-AAA111': { production: 1240, timer: '7:45:00', remarks: 'warp break' } }),
      [ocrRow('SD-AAA111', 1240, '7:45:00', 'warp break')]
    );
    expect(s.recallPct).toBe(100);
    expect(s.perfectPct).toBe(100);
    expect(s.fields.production.accuracyPct).toBe(100);
    expect(s.mistakes).toEqual([]);
  });

  test('rows the model never returned cannot be scored as correct', () => {
    // The failure this guards against: grading only what came back, so a
    // model that reads 2 of 200 rows flawlessly reports 100% accuracy.
    const want = {};
    for (let i = 0; i < 10; i++) want[`SD-00000${i}`] = { production: 100 + i };

    const s = S.scoreShiftSheet(sheet(want), [
      ocrRow('SD-000000', 100, null),
      ocrRow('SD-000001', 101, null),
    ]);

    expect(s.rows).toMatchObject({ expected: 10, found: 2, missed: 8, spurious: 0 });
    expect(s.recallPct).toBe(20);
    // Field accuracy over what was found is a real 100 — and useless on
    // its own, which is exactly why perfectPct is measured against the
    // sheet rather than against the reading.
    expect(s.fields.production.accuracyPct).toBe(100);
    expect(s.perfectPct).toBe(20);
  });

  test('invented rows are counted, not silently dropped', () => {
    // A code the model made up either matches nothing (harmless but
    // dishonest to ignore) or collides with a real row on another plan.
    const s = S.scoreShiftSheet(
      sheet({ 'SD-AAA111': { production: 100 } }),
      [ocrRow('SD-AAA111', 100, null), ocrRow('SD-ZZZ999', 4321, null)]
    );
    expect(s.rows.spurious).toBe(1);
    expect(s.recallPct).toBe(100);
  });

  test('a field the answer key omits is not graded', () => {
    // A golden set is allowed to be partial. Forcing somebody to
    // transcribe remarks they do not care about is how a golden set
    // stops being extended.
    const s = S.scoreShiftSheet(
      sheet({ 'SD-AAA111': { production: 100 } }),
      [ocrRow('SD-AAA111', 100, '9:99:99', 'anything at all')]
    );
    expect(s.fields.production.graded).toBe(1);
    expect(s.fields.timer.graded).toBe(0);
    expect(s.fields.timer.accuracyPct).toBeNull();
    expect(s.perfectPct).toBe(100);
  });

  test('a blank cell the model fills in is an error', () => {
    // The dangerous direction: nothing was written, and a number
    // appears. It reaches payroll looking exactly like a real reading.
    const s = S.scoreShiftSheet(
      sheet({ 'SD-AAA111': { production: null } }),
      [ocrRow('SD-AAA111', 1200, null)]
    );
    expect(s.fields.production.accuracyPct).toBe(0);
    expect(s.mistakes[0]).toMatchObject({ field: 'production', expected: null, got: 1200 });
  });

  test('the comparison is loose, matching the ledger', () => {
    // "1240" and 1240 are the same reading. Counting the type as an
    // error would bury the real mistakes.
    const s = S.scoreShiftSheet(
      sheet({ 'SD-AAA111': { production: '1240', timer: ' 7:45:00 ' } }),
      [ocrRow('SD-AAA111', 1240, '7:45:00')]
    );
    expect(s.mistakes).toEqual([]);
  });

  test('codes match case-insensitively', () => {
    const s = S.scoreShiftSheet(
      sheet({ 'sd-aaa111': { production: 100 } }),
      [ocrRow('SD-AAA111', 100, null)]
    );
    expect(s.recallPct).toBe(100);
  });

  test('the aggregate weights by rows, not by sheet', () => {
    // Otherwise a 4-row sheet read perfectly cancels out a 200-row sheet
    // read badly, and the summary says "50%".
    const big = S.scoreShiftSheet(
      sheet(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`SD-B${i}`, { production: i }]))),
      Array.from({ length: 100 }, (_, i) => ocrRow(`SD-B${i}`, i === 0 ? 999 : i, null))
    );
    const small = S.scoreShiftSheet(
      sheet({ 'SD-S0': { production: 1 } }),
      [ocrRow('SD-S0', 2, null)]
    );

    const agg = S.aggregateShiftSheet([big, small]);
    expect(agg.rows.expected).toBe(101);
    expect(agg.fields.production.graded).toBe(101);
    expect(agg.fields.production.correct).toBe(99);
    expect(agg.fields.production.accuracyPct).toBe(98);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. THE TWO QC ERRORS ARE NOT INTERCHANGEABLE
// ══════════════════════════════════════════════════════════════════
describe('scoreQcVision', () => {
  test('a missed defect and a false alarm are told apart', () => {
    const missed = S.scoreQcVision({ overallResult: 'fail', defectCode: 'weave-fault' },
                                   { overallResult: 'pass' });
    expect(missed).toMatchObject({ verdictCorrect: false, missedDefect: true, falseAlarm: false });

    const alarm = S.scoreQcVision({ overallResult: 'pass' },
                                  { overallResult: 'fail', defectCode: 'contamination' });
    expect(alarm).toMatchObject({ verdictCorrect: false, missedDefect: false, falseAlarm: true });
  });

  test('the defect class is only scored when both agree there is one', () => {
    // Grading the class on a photo the model called a pass would count
    // the same error twice.
    const s = S.scoreQcVision({ overallResult: 'fail', defectCode: 'weave-fault' },
                              { overallResult: 'pass', defectCode: '' });
    expect(s.defectClassCorrect).toBeNull();

    const both = S.scoreQcVision({ overallResult: 'fail', defectCode: 'weave-fault' },
                                 { overallResult: 'fail', defectCode: 'contamination' });
    expect(both).toMatchObject({ verdictCorrect: true, defectClassCorrect: false });
  });

  test('a model that answers "pass" to everything cannot hide behind the average', () => {
    // 10 photos, 3 genuinely defective. Always-pass scores 70% verdict
    // accuracy — which looks respectable until the missed-defect count
    // is read next to it, which is why it is reported separately.
    const cases = [
      ...Array.from({ length: 7 }, () => S.scoreQcVision({ overallResult: 'pass' }, { overallResult: 'pass' })),
      ...Array.from({ length: 3 }, () => S.scoreQcVision({ overallResult: 'fail', defectCode: 'weave-fault' }, { overallResult: 'pass' })),
    ];
    const agg = S.aggregateQcVision(cases);
    expect(agg.verdictAccuracyPct).toBe(70);
    expect(agg.missedDefects).toBe(3);
    expect(agg.falseAlarms).toBe(0);
    // Nothing was classified, so there is no class accuracy to quote.
    expect(agg.defectClassAccuracyPct).toBeNull();
  });

  test('an unavailable model is scored as a miss, not skipped', () => {
    const s = S.scoreQcVision({ overallResult: 'fail' }, null);
    expect(s.verdictCorrect).toBe(false);
    expect(s.missedDefect).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. THE REGRESSION GATE
// ══════════════════════════════════════════════════════════════════
describe('compareToBaseline', () => {
  const base = { 'shift-sheet-ocr': { recallPct: 98, fields: { production: { accuracyPct: 96 } } } };

  test('a drop beyond the tolerance is a regression, named by path', () => {
    const cur = { 'shift-sheet-ocr': { recallPct: 98, fields: { production: { accuracyPct: 88 } } } };
    const out = S.compareToBaseline(cur, base, 2);
    expect(out.status).toBe('regressed');
    expect(out.regressions).toEqual([
      { metric: 'shift-sheet-ocr.fields.production.accuracyPct', baseline: 96, current: 88, dropPts: 8 },
    ]);
  });

  test('a small wobble inside the tolerance is not', () => {
    const cur = { 'shift-sheet-ocr': { recallPct: 97, fields: { production: { accuracyPct: 95 } } } };
    expect(S.compareToBaseline(cur, base, 2).status).toBe('ok');
  });

  test('an improvement never fails the gate', () => {
    // Failing on "changed" rather than "dropped" trains everybody to
    // re-baseline reflexively, which is the same as having no baseline.
    const cur = { 'shift-sheet-ocr': { recallPct: 100, fields: { production: { accuracyPct: 99 } } } };
    expect(S.compareToBaseline(cur, base, 2).status).toBe('ok');
  });

  test('only percentage metrics are gated', () => {
    // Row counts move with the size of the golden set. Gating on them
    // would fire every time somebody adds a case.
    const cur = { 'shift-sheet-ocr': { recallPct: 98, rows: { found: 4 }, fields: { production: { accuracyPct: 96 } } } };
    const withCounts = { ...base, 'shift-sheet-ocr': { ...base['shift-sheet-ocr'], rows: { found: 900 } } };
    expect(S.compareToBaseline(cur, withCounts, 2).status).toBe('ok');
  });

  test('no baseline is reported as such, not as a pass', () => {
    expect(S.compareToBaseline({ a: { xPct: 1 } }, null).status).toBe('no-baseline');
  });

  test('a metric absent from the baseline is not treated as a fall from zero', () => {
    // A newly added surface has nothing to compare against. Reporting it
    // as a regression on its first run would be noise.
    const cur = { 'qc-vision': { verdictAccuracyPct: 80 } };
    expect(S.compareToBaseline(cur, base, 2).status).toBe('ok');
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. CASE PAIRING — the quiet way a golden set loses a case
// ══════════════════════════════════════════════════════════════════
//
//  A case is two files sharing a name. Get the pairing wrong and a case
//  is silently skipped: the run still prints a clean-looking number,
//  over fewer sheets than the person thought they were testing. That is
//  the worst failure this harness can have, so it is tested against a
//  real directory rather than reasoned about.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { loadCases } = require('../../scripts/run-evals');

describe('loadCases', () => {
  let root;
  const write = (surface, name, body = '{}') => {
    fs.mkdirSync(path.join(root, surface), { recursive: true });
    fs.writeFileSync(path.join(root, surface, name), body);
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcases-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('pairs an input with the answer key that shares its name', () => {
    write('shift-sheet-ocr', '2026-08-14-day.pdf', '%PDF');
    write('shift-sheet-ocr', '2026-08-14-day.expected.json', '{"rows":{"SD-A":{"production":1}}}');

    const cases = loadCases('shift-sheet-ocr', root);
    expect(cases).toHaveLength(1);
    expect(cases[0].name).toBe('2026-08-14-day');
    expect(cases[0].inputPath).toMatch(/2026-08-14-day\.pdf$/);
    expect(cases[0].expected.rows['SD-A'].production).toBe(1);
  });

  test('an answer key with no input is skipped rather than crashing the run', () => {
    write('qc-vision', 'orphan.expected.json', '{"overallResult":"fail"}');
    expect(loadCases('qc-vision', root)).toEqual([]);
  });

  test('an input with no answer key is not a case', () => {
    // Nobody has said what the right answer is, so there is nothing to
    // score it against.
    write('qc-vision', 'unlabelled.jpg', 'notreallyanimage');
    expect(loadCases('qc-vision', root)).toEqual([]);
  });

  test('the EXAMPLE shape reference is never run', () => {
    write('qc-vision', 'EXAMPLE.expected.json', '{"overallResult":"fail"}');
    write('qc-vision', 'EXAMPLE.jpg', 'x');
    expect(loadCases('qc-vision', root)).toEqual([]);
  });

  test('a missing surface folder is empty, not an error', () => {
    expect(loadCases('shift-sheet-ocr', root)).toEqual([]);
  });

  test('any image extension pairs — the runner decides what it supports', () => {
    write('qc-vision', 'roll-17.webp', 'x');
    write('qc-vision', 'roll-17.expected.json', '{"overallResult":"pass"}');
    expect(loadCases('qc-vision', root)[0].inputPath).toMatch(/roll-17\.webp$/);
  });
});
