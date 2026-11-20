"use strict";
// Integration test for the Stock & purchases report.
//
// Asserts the stock-valuation snapshot (window-independent) + low-stock
// count, the windowed PO purchase/pending value (excluding cancelled and
// out-of-window POs), each group-by, the daily purchase series, and the
// period comparison.

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

require("../../../models/RawMaterial.js");
require("../../../models/PurchaseOrder.js");
const { stockPurchasesReport } = require("../../../services/reports/stockPurchasesReport.js");

const oid = () => new mongoose.Types.ObjectId();
const rm1 = oid(), rm2 = oid(), rm3 = oid();
const s1 = oid(), s2 = oid();

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO   = new Date("2026-07-08T00:00:00.000Z");

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const db = mongoose.connection;

  await db.collection("rawmaterials").insertMany([
    { _id: rm1, name: "Yarn A",  category: "Yarn",    stock: 100, price: 50,  minStock: 20 }, // value 5000
    { _id: rm2, name: "Spandex", category: "Spandex", stock: 10,  price: 200, minStock: 15 }, // value 2000, LOW
    { _id: rm3, name: "Yarn B",  category: "Yarn",    stock: 0,   price: 30,  minStock: 0 },  // value 0, not low
  ]);
  await db.collection("suppliers").insertMany([
    { _id: s1, name: "SupplierX" }, { _id: s2, name: "SupplierY" },
  ]);

  await db.collection("purchaseorders").insertMany([
    { poNo: 1001, date: new Date("2026-07-02T06:00:00Z"), supplier: s1, status: "Partial",
      items: [{ rawMaterial: rm1, price: 50, quantity: 100, receivedQuantity: 40 }] }, // ordered 5000, pending 3000
    { poNo: 1002, date: new Date("2026-07-03T06:00:00Z"), supplier: s2, status: "Open",
      items: [
        { rawMaterial: rm2, price: 200, quantity: 20, receivedQuantity: 0 },
        { rawMaterial: rm1, price: 50, quantity: 10, receivedQuantity: 10 },
      ] }, // ordered 4500, pending 4000
    // Excluded: cancelled.
    { poNo: 1003, date: new Date("2026-07-04T06:00:00Z"), supplier: s1, status: "Cancelled",
      items: [{ rawMaterial: rm1, price: 999, quantity: 999, receivedQuantity: 0 }] },
    // Previous window.
    { poNo: 1004, date: new Date("2026-06-28T06:00:00Z"), supplier: s1, status: "Open",
      items: [{ rawMaterial: rm1, price: 50, quantity: 40, receivedQuantity: 0 }] }, // ordered 2000
    // Excluded: well before any window.
    { poNo: 1005, date: new Date("2026-06-01T06:00:00Z"), supplier: s2, status: "Open",
      items: [{ rawMaterial: rm1, price: 1, quantity: 8888, receivedQuantity: 0 }] },
  ]);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("stockPurchasesReport summary", () => {
  test("stock snapshot + low-stock + windowed purchases", async () => {
    const r = await stockPurchasesReport({ from: FROM, to: TO });
    expect(r.summary.materials).toBe(3);
    expect(r.summary.stockValue).toBe(7000);     // 5000+2000+0
    expect(r.summary.lowStock).toBe(1);          // Spandex only
    expect(r.summary.pos).toBe(2);               // po1, po2 (cancelled + out-of-window excluded)
    expect(r.summary.purchaseValue).toBe(9500);  // 5000+4500
    expect(r.summary.pendingValue).toBe(7000);   // 3000+4000
  });
});

describe("stockPurchasesReport group-by", () => {
  test("by material — stock valuation snapshot with low flag", async () => {
    const r = await stockPurchasesReport({ from: FROM, to: TO, groupBy: "material" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel["Yarn A"]).toMatchObject({ stock: 100, price: 50, value: 5000, low: false });
    expect(byLabel["Spandex"]).toMatchObject({ value: 2000, low: true });
    // Sorted by value descending.
    expect(r.rows[0].label).toBe("Yarn A");
  });

  test("by category", async () => {
    const r = await stockPurchasesReport({ from: FROM, to: TO, groupBy: "category" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel.Yarn).toMatchObject({ items: 2, stock: 100, value: 5000 });
    expect(byLabel.Spandex).toMatchObject({ items: 1, stock: 10, value: 2000 });
  });

  test("by supplier — PO register for the window", async () => {
    const r = await stockPurchasesReport({ from: FROM, to: TO, groupBy: "supplier" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel.SupplierX).toMatchObject({ pos: 1, orderedValue: 5000, pendingValue: 3000 });
    expect(byLabel.SupplierY).toMatchObject({ pos: 1, orderedValue: 4500, pendingValue: 4000 });
  });
});

describe("stockPurchasesReport series + comparison", () => {
  test("daily purchase-value series", async () => {
    const r = await stockPurchasesReport({ from: FROM, to: TO });
    expect(r.series).toEqual([
      { date: "2026-07-02", value: 5000 },
      { date: "2026-07-03", value: 4500 },
    ]);
  });

  test("comparison of purchase value against the prior window", async () => {
    const r = await stockPurchasesReport({ from: FROM, to: TO, compare: true });
    expect(r.comparison.summary.purchaseValue).toBe(2000); // po4
    expect(r.comparison.delta.purchaseValue).toBe(7500);   // 9500 - 2000
    expect(r.comparison.delta.purchaseValuePct).toBe(375);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Found reading services/reports line by line.
//
//  The material rows were moved to average cost (the reason is written
//  beside them: valued at the newest quote, the shelf was re-priced every
//  time a supplier moved theirs). The headline above them and the
//  category rows were not — so "Stock value" was not the total of the
//  Value column under it, and the two groupings of one shelf disagreed.
//  And every retired material was still counted, listed, and — if it had
//  ever had a minimum — reported as low for good.
// ══════════════════════════════════════════════════════════════════
describe("one valuation, and the retired left out", () => {
  const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const total = (rows) => rows.reduce((s, r) => s + r.value, 0);

  beforeAll(async () => {
    await mongoose.connection.collection("rawmaterials").insertMany([
      // Bought at 60 on average; the supplier's newest quote is 80.
      { _id: ids[0], name: "Cotton Old", category: "Yarn", stock: 100, price: 80, avgCost: 60, minStock: 10 },
      // Retired at nothing. It had a minimum once.
      { _id: ids[1], name: "Retired Yarn", category: "Yarn", stock: 0, price: 40, minStock: 25, archived: true },
      // Retired with five kilos still on the shelf: they are worth something.
      { _id: ids[2], name: "Retired, some left", category: "Rubber", stock: 5, price: 120, avgCost: 100, minStock: 10, archived: true },
    ]);
  });
  afterAll(async () => { await mongoose.connection.collection("rawmaterials").deleteMany({ _id: { $in: ids } }); });

  test("the headline is the total of the rows under it, by material and by category", async () => {
    const byMaterial = await stockPurchasesReport({ from: FROM, to: TO, groupBy: "material" });
    const byCategory = await stockPurchasesReport({ from: FROM, to: TO, groupBy: "category" });
    expect(byMaterial.rows.find((r) => r.label === "Cotton Old")).toMatchObject({ price: 60, value: 6000, latestPrice: 80 });
    expect(byMaterial.summary.stockValue).toBe(13500);          // 5000 + 2000 + 6000 + 500
    expect(total(byMaterial.rows)).toBe(13500);
    expect(total(byCategory.rows)).toBe(13500);
    expect(byCategory.rows.find((r) => r.label === "Yarn")).toMatchObject({ value: 11000, stock: 200 });
  });

  test("a retired material is not counted, listed or low — unless it still holds stock, which is valued", async () => {
    const r = await stockPurchasesReport({ from: FROM, to: TO, groupBy: "material" });
    expect(r.summary.materials).toBe(4);                        // the three in use, and Cotton Old
    expect(r.summary.lowStock).toBe(1);                         // Spandex, as before
    const labels = r.rows.map((x) => x.label);
    expect(labels).not.toContain("Retired Yarn");
    expect(r.rows.find((x) => x.label === "Retired, some left")).toMatchObject({ stock: 5, value: 500, low: false });
    const byCategory = await stockPurchasesReport({ from: FROM, to: TO, groupBy: "category" });
    expect(byCategory.rows.find((x) => x.label === "Yarn").items).toBe(3);      // Yarn A, Yarn B, Cotton Old
    expect(byCategory.rows.find((x) => x.label === "Rubber")).toMatchObject({ items: 1, value: 500 });
  });
});
