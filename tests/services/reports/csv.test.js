"use strict";
// Unit tests for the reports CSV serializer.

const { toCsv } = require("../../../services/reports/csv.js");

const cols = [
  { key: "label", header: "Machine" },
  { key: "meters", header: "Meters" },
];

describe("toCsv", () => {
  test("emits a header row then one row per record", () => {
    const csv = toCsv(cols, [
      { label: "Machine A", meters: 1200 },
      { label: "Machine B", meters: 800 },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "Machine,Meters",
      "Machine A,1200",
      "Machine B,800",
    ]);
  });

  test("quotes fields containing comma, quote or newline (RFC 4180)", () => {
    const csv = toCsv(cols, [{ label: 'Line "1", top', meters: 5 }]);
    expect(csv).toBe('Machine,Meters\r\n"Line ""1"", top",5');
  });

  test("neutralises formula-injection leads (= + - @)", () => {
    for (const lead of ["=", "+", "-", "@"]) {
      const csv = toCsv(cols, [{ label: `${lead}cmd|calc`, meters: 1 }]);
      // The value is prefixed with an apostrophe so Excel treats it as text.
      expect(csv).toContain(`'${lead}cmd`);
    }
  });

  test("blank for null/undefined/non-finite numbers", () => {
    const csv = toCsv(cols, [{ label: null, meters: Infinity }]);
    expect(csv).toBe("Machine,Meters\r\n,");
  });
});
