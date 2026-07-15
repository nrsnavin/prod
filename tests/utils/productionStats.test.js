"use strict";
//
// Lock test for utils/productionStats.js — the pure stat + gamification
// helpers extracted from api/production.js in the Phase 4 god-file split.
// They shipped with zero coverage; this pins the scoring math so a future
// tweak to the XP curve or consistency formula can't silently change what
// operators see on the leaderboard.

const {
  timerToSeconds, toISODate, getDayIndex, parseDateParam,
  stdDev, consistencyScore, trendSlope, trailingStreak,
  calcLevel, calcXP, calcAchievements,
} = require("../../utils/productionStats.js");

describe("time / date helpers", () => {
  test("timerToSeconds parses HH:MM:SS and rejects garbage", () => {
    expect(timerToSeconds("01:02:03")).toBe(3723);
    expect(timerToSeconds("00:00:00")).toBe(0);
    expect(timerToSeconds("1:2")).toBe(0);       // wrong arity
    expect(timerToSeconds("aa:bb:cc")).toBe(0);  // NaN parts
    expect(timerToSeconds(null)).toBe(0);
  });

  test("toISODate strips the time component", () => {
    expect(toISODate("2026-07-15T09:30:00Z")).toBe("2026-07-15");
  });

  test("getDayIndex returns 0=Sunday..6=Saturday", () => {
    expect(getDayIndex("2026-07-12")).toBe(0); // a Sunday
    expect(getDayIndex("2026-07-15")).toBe(3); // a Wednesday
  });

  test("parseDateParam throws on an invalid date", () => {
    expect(() => parseDateParam("not-a-date", 0, 0, 0, 0)).toThrow(/Invalid date/);
    const d = parseDateParam("2026-07-15", 23, 59, 59, 0);
    expect(d.getHours()).toBe(23);
  });
});

describe("dispersion stats", () => {
  test("stdDev is 0 for <2 samples and matches the sample formula", () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([5])).toBe(0);
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });

  test("consistencyScore: identical values → 100, high spread → low", () => {
    expect(consistencyScore([100, 100, 100])).toBe(100);
    expect(consistencyScore([100])).toBe(100);       // too few
    expect(consistencyScore([0, 0])).toBe(0);        // mean 0
    const noisy = consistencyScore([10, 200, 5, 300]);
    expect(noisy).toBeGreaterThanOrEqual(0);
    expect(noisy).toBeLessThan(50);
  });

  test("trendSlope: rising series positive, falling negative, flat/short zero", () => {
    expect(trendSlope([1, 2, 3, 4])).toBeGreaterThan(0);
    expect(trendSlope([4, 3, 2, 1])).toBeLessThan(0);
    expect(trendSlope([5, 5])).toBe(0); // fewer than 3
  });

  test("trailingStreak counts consecutive above-avg from the newest date", () => {
    const entries = [
      { date: "2026-07-01", production: 100 },
      { date: "2026-07-02", production: 40 },  // breaks the streak
      { date: "2026-07-03", production: 90 },
      { date: "2026-07-04", production: 95 },
    ];
    expect(trailingStreak(entries, 80)).toBe(2); // 07-03 and 07-04
    expect(trailingStreak([], 80)).toBe(0);
    expect(trailingStreak(entries, 0)).toBe(0);
  });
});

describe("XP / level engine", () => {
  test("calcLevel maps XP to the right band and progress", () => {
    expect(calcLevel(0)).toMatchObject({ level: 1, label: "Rookie", progress: 0 });
    expect(calcLevel(50)).toMatchObject({ level: 2, label: "Operator" });
    const mid = calcLevel(100); // between Operator(50) and Craftsman(150)
    expect(mid.label).toBe("Operator");
    expect(mid.progress).toBe(50); // (100-50)/(150-50)
    const top = calcLevel(5000);
    expect(top).toMatchObject({ label: "Legend", nextXp: null, progress: 100 });
  });

  test("calcXP sums the documented bonuses deterministically", () => {
    const emp = {
      shiftCount: 5,
      entries: [
        { production: 120 }, { production: 130 }, { production: 90 },
        { production: 140 }, { production: 110 },
      ],
      avgPerShift: 118,
      streak: 3,
      consistencyScore: 80,
      improvement: 0,
      anomalyCount: 0,
    };
    // Base 50 + above-avg(3×5=15) + streak(3×3=9) + consistency(round(80*.3)=24)
    // + zero-anomaly 15 + above-factory-avg (118>100*1.1=110 → +10) + rank#1 100
    const { xp, xpBreakdown } = calcXP(emp, 100, 1);
    expect(xp).toBe(50 + 15 + 9 + 24 + 15 + 10 + 100);
    expect(Array.isArray(xpBreakdown)).toBe(true);
    expect(xpBreakdown.length).toBeGreaterThan(0);
    // rank 4 earns no rank bonus
    expect(calcXP(emp, 100, 4).xp).toBe(50 + 15 + 9 + 24 + 15 + 10);
  });

  test("calcAchievements unlocks by threshold", () => {
    const all = [{ employeeId: "e1" }, { employeeId: "e2" }];
    const emp = {
      employeeId: "e1", shiftCount: 12, streak: 7,
      consistencyScore: 92, improvement: 25, avgPerShift: 250,
      anomalyCount: 0,
    };
    const ids = calcAchievements(emp, 100, all).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([
      "first_shift", "veteran", "on_a_roll", "unstoppable",
      "steady_hands", "clockwork", "rising_star", "high_flyer",
      "elite", "no_bad_days", "top_gun",
    ]));
    // 12 shifts hasn't reached the 30-shift Iron Worker badge
    expect(ids).not.toContain("iron_worker");
  });
});
