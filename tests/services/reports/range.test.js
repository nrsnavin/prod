"use strict";
// Unit tests for the reports date-range resolver.

const { resolveRange, previousWindow, DAY_MS } = require("../../../services/reports/range.js");

// A fixed clock: Wednesday 15 July 2026, 14:30 local.
const NOW = new Date(2026, 6, 15, 14, 30, 0, 0);

describe("resolveRange presets", () => {
  test("today → [00:00 today, 00:00 tomorrow)", () => {
    const r = resolveRange({ preset: "today" }, NOW);
    expect(r.preset).toBe("today");
    expect(r.from).toEqual(new Date(2026, 6, 15, 0, 0, 0, 0));
    expect(r.to).toEqual(new Date(2026, 6, 16, 0, 0, 0, 0));
  });

  test("month → 1st of month .. tomorrow", () => {
    const r = resolveRange({ preset: "month" }, NOW);
    expect(r.from).toEqual(new Date(2026, 6, 1, 0, 0, 0, 0));
    expect(r.to).toEqual(new Date(2026, 6, 16, 0, 0, 0, 0));
  });

  test("week starts Monday", () => {
    const r = resolveRange({ preset: "week" }, NOW);
    // 15 Jul 2026 is a Wednesday → week starts Mon 13 Jul.
    expect(r.from).toEqual(new Date(2026, 6, 13, 0, 0, 0, 0));
  });

  test("fy → 1 April of the current financial year", () => {
    const r = resolveRange({ preset: "fy" }, NOW);
    expect(r.from).toEqual(new Date(2026, 3, 1, 0, 0, 0, 0));
    // A January date belongs to the FY that started the previous April.
    const jan = resolveRange({ preset: "fy" }, new Date(2026, 0, 10));
    expect(jan.from).toEqual(new Date(2025, 3, 1, 0, 0, 0, 0));
  });

  test("defaults to month when preset is unknown/absent", () => {
    expect(resolveRange({}, NOW).preset).toBe("month");
  });
});

describe("resolveRange custom window", () => {
  test("from/to become a day-aligned half-open window (to inclusive)", () => {
    const r = resolveRange({ from: "2026-07-01", to: "2026-07-10" }, NOW);
    expect(r.preset).toBe("custom");
    expect(r.from).toEqual(new Date(2026, 6, 1, 0, 0, 0, 0));
    // to is inclusive of 10 Jul → advanced to 11 Jul midnight.
    expect(r.to).toEqual(new Date(2026, 6, 11, 0, 0, 0, 0));
  });

  test("custom wins over a preset if both are sent", () => {
    const r = resolveRange({ from: "2026-07-01", to: "2026-07-02", preset: "fy" }, NOW);
    expect(r.preset).toBe("custom");
  });

  test("rejects to < from and invalid dates", () => {
    expect(() => resolveRange({ from: "2026-07-10", to: "2026-07-01" }, NOW)).toThrow(/on or after/);
    expect(() => resolveRange({ from: "not-a-date" }, NOW)).toThrow(/Invalid/);
  });
});

describe("previousWindow", () => {
  test("returns the immediately-preceding window of equal length", () => {
    const cur = resolveRange({ from: "2026-07-08", to: "2026-07-14" }, NOW); // 7 days
    const prev = previousWindow(cur);
    expect(cur.to.getTime() - cur.from.getTime()).toBe(prev.to.getTime() - prev.from.getTime());
    expect(prev.to).toEqual(cur.from);
    expect(prev.from).toEqual(new Date(cur.from.getTime() - 7 * DAY_MS));
  });
});
