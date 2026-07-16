"use strict";
// Integration test for the Order book & fulfillment report.
//
// Seeds raw orders + delivery challans and asserts intake/pending
// roll-ups, open/overdue counts, on-time-delivery %, the group-bys,
// the daily intake series, and the period comparison — plus exclusion
// of soft-deleted and out-of-window orders.

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

require("../../../models/Order.js");
require("../../../models/DeliveryChallan.js");
const { orderBookReport } = require("../../../services/reports/orderBookReport.js");

const oid = () => new mongoose.Types.ObjectId();
const c1 = oid(), c2 = oid();
const o1 = oid(), o2 = oid(), o3 = oid();

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO   = new Date("2026-07-08T00:00:00.000Z");
// Overdue is measured as of this clock (after the window).
const NOW  = new Date("2026-07-15T00:00:00.000Z");

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const db = mongoose.connection;

  const line = (q) => [{ elastic: oid(), quantity: q }];
  await db.collection("orders").insertMany([
    { _id: o1, orderNo: 7001, date: new Date("2026-07-02T06:00:00Z"), customer: c1, status: "Approved",   supplyDate: new Date("2026-07-20"), elasticOrdered: line(1000), pendingElastic: line(400) },
    { _id: o2, orderNo: 7002, date: new Date("2026-07-02T06:00:00Z"), customer: c1, status: "InProgress", supplyDate: new Date("2026-07-10"), elasticOrdered: line(500),  pendingElastic: line(500) },
    { _id: o3, orderNo: 7003, date: new Date("2026-07-03T06:00:00Z"), customer: c2, status: "Completed",  supplyDate: new Date("2026-07-05"), elasticOrdered: line(800),  pendingElastic: line(0) },
    // Excluded: soft-deleted.
    { _id: oid(), orderNo: 7004, date: new Date("2026-07-04T06:00:00Z"), customer: c2, status: "Deleted", supplyDate: new Date("2026-07-30"), elasticOrdered: line(9999), pendingElastic: line(9999) },
    // Previous window.
    { _id: oid(), orderNo: 7005, date: new Date("2026-06-28T06:00:00Z"), customer: c1, status: "Approved", supplyDate: new Date("2026-07-25"), elasticOrdered: line(300), pendingElastic: line(300) },
  ]);
  await db.collection("customers").insertMany([{ _id: c1, name: "Acme" }, { _id: c2, name: "Beta" }]);

  // Distinct dcNumber avoids a null collision on the model's unique index.
  await db.collection("deliverychallans").insertMany([
    { dcNumber: 5001, order: o3, status: "delivered",  dispatchDate: new Date("2026-07-07T09:00:00Z") }, // due 07-05 → LATE
    { dcNumber: 5002, order: o2, status: "dispatched", dispatchDate: new Date("2026-07-06T09:00:00Z") }, // due 07-10 → on time
    { dcNumber: 5003, order: o1, status: "dispatched", dispatchDate: new Date("2026-07-06T09:00:00Z") }, // due 07-20 → on time
    { dcNumber: 5004, order: o1, status: "cancelled",  dispatchDate: new Date("2026-07-06T09:00:00Z") }, // excluded
    { dcNumber: 5005, order: null, status: "dispatched", dispatchDate: new Date("2026-07-06T09:00:00Z") }, // excluded (no order)
  ]);
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("orderBookReport summary", () => {
  test("intake, pending, open/overdue counts and OTD", async () => {
    const r = await orderBookReport({ from: FROM, to: TO, now: NOW });
    expect(r.summary.orders).toBe(3);
    expect(r.summary.orderedQty).toBe(2300);   // 1000+500+800
    expect(r.summary.pendingQty).toBe(900);     // 400+500+0
    expect(r.summary.openOrders).toBe(2);       // Approved + InProgress
    expect(r.summary.completedOrders).toBe(1);
    expect(r.summary.overdueOrders).toBe(1);    // o2 (due 07-10, still open, now 07-15)
    expect(r.summary.otdConsidered).toBe(3);
    expect(r.summary.onTimePct).toBe(67);       // 2 of 3 on time
  });
});

describe("orderBookReport group-by", () => {
  test("by customer", async () => {
    const r = await orderBookReport({ from: FROM, to: TO, groupBy: "customer", now: NOW });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel.Acme).toMatchObject({ orders: 2, orderedQty: 1500, pendingQty: 900 });
    expect(byLabel.Beta).toMatchObject({ orders: 1, orderedQty: 800, pendingQty: 0 });
  });

  test("by status", async () => {
    const r = await orderBookReport({ from: FROM, to: TO, groupBy: "status", now: NOW });
    const byLabel = Object.fromEntries(r.rows.map((x) => [x.label, x]));
    expect(byLabel.Approved).toMatchObject({ orders: 1, orderedQty: 1000, pendingQty: 400 });
    expect(byLabel.InProgress).toMatchObject({ orders: 1, pendingQty: 500 });
    expect(byLabel.Completed).toMatchObject({ orders: 1, pendingQty: 0 });
  });

  test("by supply month", async () => {
    const r = await orderBookReport({ from: FROM, to: TO, groupBy: "supplyMonth", now: NOW });
    expect(r.rows).toEqual([{ key: "2026-07", label: "2026-07", orders: 3, pendingQty: 900 }]);
  });
});

describe("orderBookReport series + comparison", () => {
  test("daily intake series (ordered qty)", async () => {
    const r = await orderBookReport({ from: FROM, to: TO, now: NOW });
    expect(r.series).toEqual([
      { date: "2026-07-02", quantity: 1500 },
      { date: "2026-07-03", quantity: 800 },
    ]);
  });

  test("comparison against the prior window", async () => {
    const r = await orderBookReport({ from: FROM, to: TO, compare: true, now: NOW });
    expect(r.comparison.summary.orders).toBe(1);       // the 28-Jun order
    expect(r.comparison.delta.orders).toBe(2);
    expect(r.comparison.delta.orderedQty).toBe(2000);  // 2300 - 300
  });
});
