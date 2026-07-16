"use strict";
// Integration test for the Stock movement ledger report.
//
// Seeds MaterialInward (receipts) and MaterialOutward (consumption)
// and asserts in/out/net roll-ups by material and day, the daily net
// series and the period comparison — plus that reversed and
// out-of-window rows are excluded.

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

require("../../../models/RawMaterial.js");
require("../../../models/MaterialInward.js");
require("../../../models/MaterialOut.cjs");
const { stockMovementsReport } = require("../../../services/reports/stockMovementsReport.js");

const oid = () => new mongoose.Types.ObjectId();
const rm1 = oid(), rm2 = oid();

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO   = new Date("2026-07-08T00:00:00.000Z");

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const db = mongoose.connection;

  await db.collection("rawmaterials").insertMany([
    { _id: rm1, name: "Yarn A", category: "Yarn" },
    { _id: rm2, name: "Spandex", category: "Spandex" },
  ]);
  await db.collection("materialinwards").insertMany([
    { rawMaterial: rm1, quantity: 100, inwardDate: new Date("2026-07-02T06:00:00Z") },
    { rawMaterial: rm2, quantity: 50,  inwardDate: new Date("2026-07-03T06:00:00Z") },
    { rawMaterial: rm1, quantity: 30,  inwardDate: new Date("2026-06-28T06:00:00Z") }, // prev window
  ]);
  await db.collection("materialoutwards").insertMany([
    { rawMaterial: rm1, quantity: 40, outwardDate: new Date("2026-07-02T09:00:00Z"), type: "ORDER_APPROVAL" },
    { rawMaterial: rm1, quantity: 10, outwardDate: new Date("2026-07-03T09:00:00Z"), type: "JOB_CONSUMPTION" },
    { rawMaterial: rm2, quantity: 999, outwardDate: new Date("2026-07-04T09:00:00Z"), type: "ORDER_APPROVAL", reversed: true }, // excluded
    { rawMaterial: rm2, quantity: 20, outwardDate: new Date("2026-06-28T09:00:00Z"), type: "ORDER_APPROVAL" }, // prev window
  ]);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("stockMovementsReport summary", () => {
  test("in/out/net over the window, reversed excluded", async () => {
    const r = await stockMovementsReport({ from: FROM, to: TO });
    expect(r.summary.inQty).toBe(150);  // 100+50
    expect(r.summary.outQty).toBe(50);  // 40+10 (reversed 999 excluded)
    expect(r.summary.net).toBe(100);
    expect(r.summary.inCount).toBe(2);
    expect(r.summary.outCount).toBe(2);
  });
});

describe("stockMovementsReport group-by", () => {
  const sum = (rows, k) => rows.reduce((s, x) => s + x[k], 0);

  test("by material reconciles to totals", async () => {
    const r = await stockMovementsReport({ from: FROM, to: TO, groupBy: "material" });
    expect(sum(r.rows, "inQty")).toBe(150);
    expect(sum(r.rows, "outQty")).toBe(50);
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel["Yarn A"]).toMatchObject({ inQty: 100, outQty: 50, net: 50 });
    expect(byLabel["Spandex"]).toMatchObject({ inQty: 50, outQty: 0, net: 50 });
  });

  test("by day", async () => {
    const r = await stockMovementsReport({ from: FROM, to: TO, groupBy: "day" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel["2026-07-02"]).toMatchObject({ inQty: 100, outQty: 40, net: 60 });
    expect(byLabel["2026-07-03"]).toMatchObject({ inQty: 50, outQty: 10, net: 40 });
  });
});

describe("stockMovementsReport series + comparison", () => {
  test("daily net series", async () => {
    const r = await stockMovementsReport({ from: FROM, to: TO });
    expect(r.series).toEqual([
      { date: "2026-07-02", net: 60 },
      { date: "2026-07-03", net: 40 },
    ]);
  });

  test("comparison against the prior window", async () => {
    const r = await stockMovementsReport({ from: FROM, to: TO, compare: true });
    expect(r.comparison.summary.inQty).toBe(30);
    expect(r.comparison.summary.outQty).toBe(20);
    expect(r.comparison.delta.net).toBe(90); // 100 - 10
  });
});
