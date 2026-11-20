"use strict";
// Unit tests for the reports date-range resolver.

const { resolveRange, previousWindow, DAY_MS } = require("../../../services/reports/range.js");

// Days are India's: 00:00 IST is 18:30 UTC the day before.
const at = (ymd) => new Date(`${ymd}T00:00:00+05:30`);
// A fixed clock: Wednesday 15 July 2026, 14:30 in India.
const NOW = new Date("2026-07-15T14:30:00+05:30");

describe("resolveRange presets", () => {
  test("today → [00:00 today, 00:00 tomorrow)", () => {
    const r = resolveRange({ preset: "today" }, NOW);
    expect(r.preset).toBe("today");
    expect(r.from).toEqual(at("2026-07-15"));
    expect(r.to).toEqual(at("2026-07-16"));
  });

  test("month → 1st of month .. tomorrow", () => {
    const r = resolveRange({ preset: "month" }, NOW);
    expect(r.from).toEqual(at("2026-07-01"));
    expect(r.to).toEqual(at("2026-07-16"));
  });

  test("week starts Monday", () => {
    const r = resolveRange({ preset: "week" }, NOW);
    // 15 Jul 2026 is a Wednesday → week starts Mon 13 Jul.
    expect(r.from).toEqual(at("2026-07-13"));
  });

  test("fy → 1 April of the current financial year", () => {
    const r = resolveRange({ preset: "fy" }, NOW);
    expect(r.from).toEqual(at("2026-04-01"));
    // A January date belongs to the FY that started the previous April.
    const jan = resolveRange({ preset: "fy" }, new Date("2026-01-10T10:00:00+05:30"));
    expect(jan.from).toEqual(at("2025-04-01"));
  });

  test("defaults to month when preset is unknown/absent", () => {
    expect(resolveRange({}, NOW).preset).toBe("month");
  });
});

describe("resolveRange custom window", () => {
  test("from/to become a day-aligned half-open window (to inclusive)", () => {
    const r = resolveRange({ from: "2026-07-01", to: "2026-07-10" }, NOW);
    expect(r.preset).toBe("custom");
    expect(r.from).toEqual(at("2026-07-01"));
    // to is inclusive of 10 Jul → advanced to 11 Jul midnight.
    expect(r.to).toEqual(at("2026-07-11"));
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

describe("India's day on a UTC server", () => {
  test("at 01:00 in India on the 1st it is already the new day and the new month", () => {
    const early = new Date("2026-08-01T01:00:00+05:30"); // 31 Jul 19:30 UTC
    expect(resolveRange({ preset: "today" }, early).from).toEqual(at("2026-08-01"));
    expect(resolveRange({ preset: "month" }, early).from).toEqual(at("2026-08-01"));
  });
  test("31 March late evening in India is still last financial year's", () => {
    expect(resolveRange({ preset: "fy" }, new Date("2026-03-31T23:00:00+05:30")).from).toEqual(at("2025-04-01"));
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

// ══════════════════════════════════════════════════════════════════
//  Found reading services/reportEngine line by line.
//
//  The report engine (the Reports page, the SQL box, Ask Jarvis) keeps a
//  second date-range resolver, and its "this week" asked the weekday of
//  00:00 IST as a UTC moment — which is the evening before. So the week
//  began on Tuesday: on a Monday it showed last Tuesday to today, and
//  every other day it left Monday out. Both resolvers also filed a date
//  that does not exist under another day (30 February as 2 March).
// ══════════════════════════════════════════════════════════════════
describe("the report engine's own range", () => {
  const { resolve } = require("../../../services/reportEngine/range.js");
  const on = (when) => resolve({ preset: "week" }, new Date(when));

  test("this week begins on Monday, on every day of it", () => {
    // 13 July 2026 is a Monday.
    expect(on("2026-07-13T10:00:00+05:30")).toMatchObject({ fromDay: "2026-07-13", toDay: "2026-07-13" });
    expect(on("2026-07-14T10:00:00+05:30")).toMatchObject({ fromDay: "2026-07-13", toDay: "2026-07-14" });
    expect(on("2026-07-15T14:30:00+05:30")).toMatchObject({ fromDay: "2026-07-13", toDay: "2026-07-15" });
    expect(on("2026-07-19T23:30:00+05:30")).toMatchObject({ fromDay: "2026-07-13", toDay: "2026-07-19" });
    // Just after midnight in India the server's own day is still Sunday.
    expect(on("2026-07-20T00:30:00+05:30")).toMatchObject({ fromDay: "2026-07-20", toDay: "2026-07-20" });
    // And it agrees with the other resolver, to the moment.
    expect(on("2026-07-15T14:30:00+05:30").from).toEqual(resolveRange({ preset: "week" }, NOW).from);
  });

  test("a date that does not exist is refused, not moved", () => {
    expect(() => resolve({ from: "2026-02-30", to: "2026-03-05" })).toThrow(/YYYY-MM-DD/);
    expect(() => resolve({ from: "2026-04-01", to: "2026-04-31" })).toThrow(/YYYY-MM-DD/);
    expect(() => resolve({ from: "2026-13-01" })).toThrow(/YYYY-MM-DD/);
    expect(resolve({ from: "2028-02-29", to: "2028-02-29" })).toMatchObject({ fromDay: "2028-02-29" });   // a leap day is a day
  });
});

describe("resolveRange with a date that does not exist", () => {
  test("is refused, not filed under another day", () => {
    expect(() => resolveRange({ from: "2026-02-30", to: "2026-03-05" }, NOW)).toThrow(/Invalid from\/to date/);
    expect(() => resolveRange({ from: "2026-04-01", to: "2026-04-31" }, NOW)).toThrow(/Invalid from\/to date/);
    expect(() => resolveRange({ from: "2026-13-01" }, NOW)).toThrow(/Invalid from\/to date/);
    expect(resolveRange({ from: "2028-02-29", to: "2028-02-29" }, NOW).from).toEqual(at("2028-02-29"));
  });
});
