'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DETERMINISTIC CORE, UNDER THE FACTORY'S CLOCK
//
//  Everything in the AI report rests on these numbers. A model given a
//  production history that is one day out of step with its own labels
//  does not "mostly work" — it learns the wrong thing confidently, and
//  the failure arrives as a plausible-looking forecast rather than an
//  error. So the arithmetic is fixed and pinned before any of it is
//  handed to a model.
//
//  Two faults, both invisible on a UTC CI box and both certain on the
//  factory's IST server:
//
//    • toISODate went through toISOString(), while every date reaching
//      it is written at LOCAL midnight. East of Greenwich that lands on
//      the previous calendar day — so one row carried date "2026-08-19"
//      beside dateLabel "20 Aug 2026" and dayOfWeek "Thu".
//
//    • consistencyScore returned 100 for a single shift, because a
//      one-element sample has a standard deviation of zero. A worker's
//      first day scored PERFECT consistency — out-scoring everyone who
//      had held steady for a month, and taking 30 XP and two badges
//      with it.
//
//  ── Why the first group runs in a child process ─────────────────
//  Node reads TZ once and caches it. Setting process.env.TZ inside a
//  jest file is too late: the environment has already touched Date, so
//  the assignment silently does nothing and the suite runs under UTC —
//  where the bug does not exist and every assertion passes against the
//  BROKEN implementation. That is exactly the failure mode this test is
//  meant to catch, so the timezone is set the only way that actually
//  works: before the process starts.
// ══════════════════════════════════════════════════════════════════

const { execFileSync } = require('child_process');
const path = require('path');

const {
  consistencyScore, calcXP, calcAchievements,
} = require('../../utils/productionStats');

/** Evaluate an expression against productionStats in a given timezone. */
function inTimezone(tz, expr) {
  const mod = path.resolve(__dirname, '../../utils/productionStats.js');
  const out = execFileSync(
    process.execPath,
    ['-e', `const S=require(${JSON.stringify(mod)});process.stdout.write(JSON.stringify(${expr}))`],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
  );
  return JSON.parse(out);
}

// ══════════════════════════════════════════════════════════════════
//  1. ONE DAY, DESCRIBED THREE WAYS, ALL THREE AGREEING
// ══════════════════════════════════════════════════════════════════
describe('toISODate under the factory timezone', () => {
  const IST = 'Asia/Kolkata';

  test('the timezone harness itself is real', () => {
    // If this ever fails, every assertion below is meaningless — the
    // child is running under UTC and the bug is out of reach.
    expect(inTimezone(IST, 'new Date(2026,7,20,0,0,0).toISOString()'))
      .toBe('2026-08-19T18:30:00.000Z');
  });

  test('local midnight formats as its own calendar day, not yesterday', () => {
    // 20 Aug 2026 at local midnight is 19 Aug 18:30 UTC. The old
    // implementation reported the 19th — a whole day of production
    // filed under the day before.
    expect(inTimezone(IST, 'S.toISODate(new Date(2026,7,20,0,0,0))')).toBe('2026-08-20');
  });

  test('the three date fields on a production row describe the SAME day', () => {
    // The bug was visible in exactly this comparison and nowhere else,
    // which is why it survived: each field looked right on its own.
    const [iso, label, dow] = inTimezone(IST,
      '[S.toISODate(new Date(2026,7,20)),S.toDateLabel(new Date(2026,7,20)),S.toDayOfWeek(new Date(2026,7,20))]');
    expect(iso).toBe('2026-08-20');
    expect(label).toMatch(/20 Aug 2026/);
    expect(dow).toBe('Thu');
  });

  test('late evening does not roll the date forward either', () => {
    // The mirror case: 23:30 local is still the same working day.
    expect(inTimezone(IST, 'S.toISODate(new Date(2026,7,20,23,30))')).toBe('2026-08-20');
  });

  test('west of Greenwich too — the fix is not an IST special case', () => {
    expect(inTimezone('America/Chicago', 'S.toISODate(new Date(2026,7,20,23,30))')).toBe('2026-08-20');
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. A FIRST SHIFT IS NOT PERFECT CONSISTENCY
// ══════════════════════════════════════════════════════════════════
describe('consistency with too little data', () => {
  // Built the way the route builds it: the score is DERIVED from the
  // shift history, not handed in. Passing null directly would test the
  // guard while leaving the thing that produces the wrong value — a
  // one-element sample scoring 100 — untouched.
  const worker = (productions) => {
    const entries = productions.map((p, i) => ({ date: `2026-08-${10 + i}`, production: p }));
    return {
      employeeId: 'e1',
      shiftCount: productions.length,
      avgPerShift: productions.reduce((a, b) => a + b, 0) / productions.length,
      streak: 0, improvement: 0, anomalyCount: 0,
      entries,
      consistencyScore: consistencyScore(productions),
    };
  };

  test('one shift has no consistency to score', () => {
    expect(worker([1200]).consistencyScore).toBeNull();
    expect(worker([1200, 1200]).consistencyScore).toBe(100);
  });

  test('a first-day worker does not out-earn a steady month on consistency XP', () => {
    const firstDay = calcXP(worker([1200]), 1200, 9);
    const steady   = calcXP(worker([1200, 1195, 1205, 1200]), 1200, 9);

    // Pre-fix, the single shift scored 100 and collected the full 30 XP
    // for it, on the strength of one number.
    expect(firstDay.xpBreakdown.join(' ')).not.toMatch(/Consistency/);
    expect(steady.xpBreakdown.join(' ')).toMatch(/Consistency/);
  });

  test('Steady Hands and Clockwork are not handed out for one data point', () => {
    const ids = (w) => calcAchievements(w, 1200, [w]).map((a) => a.id);

    expect(ids(worker([1200]))).not.toContain('steady_hands');
    expect(ids(worker([1200]))).not.toContain('clockwork');

    // Still earned when there IS a history behind them.
    expect(ids(worker([1200, 1195, 1205, 1200]))).toEqual(
      expect.arrayContaining(['steady_hands', 'clockwork'])
    );
  });

  test('a null score never becomes a NaN downstream', () => {
    // `null * 0.30` is 0, not NaN — which is precisely why the old
    // behaviour was survivable and therefore invisible. The guard is
    // explicit so a refactor cannot quietly reintroduce it.
    const { xp } = calcXP(worker([1200]), 1200, 9);
    expect(Number.isFinite(xp)).toBe(true);
  });
});
