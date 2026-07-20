"use strict";
// Integration test for the Dispatch & customer-sales report.
//
// Seeds raw delivery challans and asserts value/quantity roll-ups by
// customer / elastic / day, the daily value series, and the period
// comparison — plus that draft and cancelled DCs (and out-of-window
// ones) are excluded from the sales figures.

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

require("../../../models/DeliveryChallan.js");
const { dispatchReport } = require("../../../services/reports/dispatchReport.js");

const oid = () => new mongoose.Types.ObjectId();
const c1 = oid(), c2 = oid();
const el1 = oid(), el2 = oid();

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO   = new Date("2026-07-08T00:00:00.000Z");

let mongo;

// A fresh mongod can stall mid-seed when the whole suite runs serially
// on a loaded box (observed as a network timeout inside insertMany).
// Boot + seed retries once before declaring failure.
async function bootAndSeed() {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  await mongoose.connection.collection("deliverychallans").insertMany([
    // In-window, real dispatches.
    { dispatchDate: new Date("2026-07-02T09:00:00Z"), status: "dispatched", customer: c1, customerName: "Acme",
      totalQuantity: 100, totalAmount: 5000, items: [{ elastic: el1, elasticName: "20mm", quantity: 100, amount: 5000 }] },
    { dispatchDate: new Date("2026-07-02T11:00:00Z"), status: "delivered", customer: c1, customerName: "Acme",
      totalQuantity: 50, totalAmount: 3000, items: [{ elastic: el2, elasticName: "30mm", quantity: 50, amount: 3000 }] },
    { dispatchDate: new Date("2026-07-03T09:00:00Z"), status: "dispatched", customer: c2, customerName: "Beta",
      totalQuantity: 200, totalAmount: 12000, items: [
        { elastic: el1, elasticName: "20mm", quantity: 80, amount: 4000 },
        { elastic: el2, elasticName: "30mm", quantity: 120, amount: 8000 },
      ] },
    // Excluded: draft (not yet dispatched) and cancelled (reversed).
    { dispatchDate: new Date("2026-07-04T09:00:00Z"), status: "draft", customer: c1, customerName: "Acme", totalQuantity: 999, totalAmount: 99999, items: [] },
    { dispatchDate: new Date("2026-07-04T09:00:00Z"), status: "cancelled", customer: c2, customerName: "Beta", totalQuantity: 999, totalAmount: 99999, items: [] },
    // Previous window (2026-06-24 .. 2026-07-01).
    { dispatchDate: new Date("2026-06-28T09:00:00Z"), status: "delivered", customer: c1, customerName: "Acme",
      totalQuantity: 40, totalAmount: 2000, items: [{ elastic: el1, elasticName: "20mm", quantity: 40, amount: 2000 }] },
    // Excluded: well before any window.
    { dispatchDate: new Date("2026-06-01T09:00:00Z"), status: "delivered", customer: c1, customerName: "Acme", totalQuantity: 1, totalAmount: 88888, items: [] },
  ]);
}

beforeAll(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await bootAndSeed();
      break;
    } catch (e) {
      try { await mongoose.disconnect(); } catch (_) { /* noop */ }
      try { if (mongo) await mongo.stop(); } catch (_) { /* noop */ }
      if (attempt >= 2) throw e;
    }
  }
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("dispatchReport summary", () => {
  test("counts only dispatched/delivered DCs in the window", async () => {
    const r = await dispatchReport({ from: FROM, to: TO });
    expect(r.summary.dcs).toBe(3);
    expect(r.summary.quantity).toBe(350);   // 100+50+200
    expect(r.summary.amount).toBe(20000);   // 5000+3000+12000
    expect(r.summary.customers).toBe(2);
    expect(r.summary.avgRate).toBe(57.14);  // 20000/350
  });
});

describe("dispatchReport group-by reconciles to the total value", () => {
  const sum = (rows) => rows.reduce((s, x) => s + x.amount, 0);

  test("by customer", async () => {
    const r = await dispatchReport({ from: FROM, to: TO, groupBy: "customer" });
    expect(sum(r.rows)).toBe(20000);
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel.Acme).toMatchObject({ dcs: 2, quantity: 150, amount: 8000 });
    expect(byLabel.Beta).toMatchObject({ dcs: 1, quantity: 200, amount: 12000 });
  });

  test("by elastic (unwound line items)", async () => {
    const r = await dispatchReport({ from: FROM, to: TO, groupBy: "elastic" });
    expect(sum(r.rows)).toBe(20000);
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel["20mm"]).toMatchObject({ quantity: 180, amount: 9000, dcs: 2 });
    expect(byLabel["30mm"]).toMatchObject({ quantity: 170, amount: 11000, dcs: 2 });
  });

  test("by day", async () => {
    const r = await dispatchReport({ from: FROM, to: TO, groupBy: "day" });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x.amount]));
    expect(byLabel["2026-07-02"]).toBe(8000);
    expect(byLabel["2026-07-03"]).toBe(12000);
  });
});

describe("dispatchReport series + comparison + columns", () => {
  test("daily value series", async () => {
    const r = await dispatchReport({ from: FROM, to: TO });
    expect(r.series).toEqual([
      { date: "2026-07-02", amount: 8000 },
      { date: "2026-07-03", amount: 12000 },
    ]);
  });

  test("comparison against the prior window", async () => {
    const r = await dispatchReport({ from: FROM, to: TO, compare: true });
    expect(r.comparison.summary.amount).toBe(2000);
    expect(r.comparison.delta.amount).toBe(18000);
    expect(r.comparison.delta.amountPct).toBe(900);
  });

  test("columns carry a format hint for the shared table", async () => {
    const r = await dispatchReport({ from: FROM, to: TO, groupBy: "customer" });
    expect(r.columns.find((c) => c.key === "amount")).toMatchObject({ format: "currency" });
    expect(r.columns.find((c) => c.key === "label")).toMatchObject({ header: "Customer" });
  });
});
