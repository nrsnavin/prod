"use strict";
// Integration test for the Production report aggregation.
//
// Seeds raw shiftdetails / wastages / machines / employees / elastics
// into an in-memory Mongo (raw inserts → full control over the exact
// docs the pipelines see) and asserts the summary, every group-by, the
// daily series, and the period-over-period comparison. Reconciliation
// is the key invariant: each group-by's rows must sum to the window
// total (elastic grouping to the attributable total).

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

require("../../../models/ShiftDetail.js");
require("../../../models/Wastage.js");
const { productionReport } = require("../../../services/reports/productionReport.js");

const oid = () => new mongoose.Types.ObjectId();
const m1 = oid(), m2 = oid();
const e1 = oid(), e2 = oid();
const el1 = oid(), el2 = oid();

// Explicit UTC window so we don't depend on the runner's timezone.
const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO   = new Date("2026-07-08T00:00:00.000Z"); // 7-day window

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const db = mongoose.connection;
  await db.collection("machines").insertMany([
    { _id: m1, ID: "01" }, { _id: m2, ID: "02" },
  ]);
  await db.collection("employees").insertMany([
    { _id: e1, name: "Asha" }, { _id: e2, name: "Ravi" },
  ]);
  await db.collection("elastics").insertMany([
    { _id: el1, name: "20mm" }, { _id: el2, name: "30mm" },
  ]);

  const shift = (o) => ({ status: "closed", ...o });
  await db.collection("shiftdetails").insertMany([
    // In-window, closed.
    shift({ date: new Date("2026-07-02T06:00:00Z"), shift: "DAY",   machine: m1, employee: e1, productionMeters: 1000, elastics: [{ head: 1, elastic: el1 }, { head: 2, elastic: el2 }] }),
    shift({ date: new Date("2026-07-02T20:00:00Z"), shift: "NIGHT", machine: m1, employee: e2, productionMeters: 800,  elastics: [{ head: 1, elastic: el1 }] }),
    shift({ date: new Date("2026-07-03T06:00:00Z"), shift: "DAY",   machine: m2, employee: e1, productionMeters: 1200, elastics: [{ head: 1, elastic: el2 }, { head: 2, elastic: el2 }] }),
    shift({ date: new Date("2026-07-03T07:00:00Z"), shift: "DAY",   machine: m2, employee: null, productionMeters: 500, elastics: [] }),
    // Previous window (2026-06-24 .. 2026-07-01), closed.
    shift({ date: new Date("2026-06-28T06:00:00Z"), shift: "DAY",   machine: m1, employee: e1, productionMeters: 2000, elastics: [{ head: 1, elastic: el1 }] }),
    // Excluded: well before any window.
    shift({ date: new Date("2026-06-01T06:00:00Z"), shift: "DAY",   machine: m1, productionMeters: 9999, elastics: [] }),
    // Excluded: in-window but not verified (not closed).
    { status: "pending_verification", date: new Date("2026-07-02T06:00:00Z"), shift: "DAY", machine: m1, productionMeters: 7777, elastics: [] },
  ]);

  await db.collection("wastages").insertMany([
    { createdAt: new Date("2026-07-02T10:00:00Z"), quantity: 100, penalty: 10 },
    { createdAt: new Date("2026-07-03T10:00:00Z"), quantity: 40,  penalty: 5  },
    { createdAt: new Date("2026-06-28T10:00:00Z"), quantity: 60,  penalty: 0  }, // prev window
    { createdAt: new Date("2026-06-01T10:00:00Z"), quantity: 999, penalty: 0  }, // excluded
  ]);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("productionReport summary", () => {
  test("sums only in-window closed shifts and matching wastage", async () => {
    const r = await productionReport({ from: FROM, to: TO });
    expect(r.summary.meters).toBe(3500);        // 1000+800+1200+500
    expect(r.summary.shifts).toBe(4);
    expect(r.summary.activeMachines).toBe(2);
    expect(r.summary.machineDays).toBe(2);       // (m1,07-02) + (m2,07-03)
    expect(r.summary.avgPerShift).toBe(875);
    expect(r.summary.wastageMeters).toBe(140);
    expect(r.summary.wastagePct).toBe(4);        // 140/3500
    expect(r.summary.wastagePenalty).toBe(15);
  });
});

describe("productionReport group-by rows reconcile to the total", () => {
  const sum = (rows) => rows.reduce((s, x) => s + x.meters, 0);

  test("by machine", async () => {
    const r = await productionReport({ from: FROM, to: TO, groupBy: "machine" });
    expect(sum(r.rows)).toBe(3500);
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x.meters]));
    expect(byLabel["Machine 01"]).toBe(1800);
    expect(byLabel["Machine 02"]).toBe(1700);
  });

  test("by shift", async () => {
    const r = await productionReport({ from: FROM, to: TO, groupBy: "shift" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x.meters]));
    expect(byLabel.DAY).toBe(2700);   // 1000+1200+500
    expect(byLabel.NIGHT).toBe(800);
  });

  test("by operator, with an Unassigned bucket", async () => {
    const r = await productionReport({ from: FROM, to: TO, groupBy: "operator" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x.meters]));
    expect(byLabel.Asha).toBe(2200);
    expect(byLabel.Ravi).toBe(800);
    expect(byLabel.Unassigned).toBe(500);
  });

  test("by elastic, fanned across heads (reconciles to attributable total)", async () => {
    const r = await productionReport({ from: FROM, to: TO, groupBy: "elastic" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x.meters]));
    // el1: 1000/2 + 800 = 1300 ; el2: 1000/2 + 1200 = 1700
    expect(byLabel["20mm"]).toBe(1300);
    expect(byLabel["30mm"]).toBe(1700);
    // shift #4 (no elastic snapshot, 500m) is not attributable → excluded.
    expect(sum(r.rows)).toBe(3000);
  });
});

describe("productionReport series + comparison", () => {
  test("daily series has one point per active day", async () => {
    const r = await productionReport({ from: FROM, to: TO });
    expect(r.series).toEqual([
      { date: "2026-07-02", meters: 1800 },
      { date: "2026-07-03", meters: 1700 },
    ]);
  });

  test("compare pulls the preceding equal-length window", async () => {
    const r = await productionReport({ from: FROM, to: TO, compare: true });
    expect(r.comparison.summary.meters).toBe(2000); // only the 28-Jun shift
    expect(r.comparison.delta.meters).toBe(1500);   // 3500 - 2000
    expect(r.comparison.delta.metersPct).toBe(75);
    expect(r.comparison.delta.wastageMeters).toBe(80); // 140 - 60
  });
});
