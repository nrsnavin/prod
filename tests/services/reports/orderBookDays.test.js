"use strict";
// ══════════════════════════════════════════════════════════════════
//  THE ORDER BOOK REPORT, ON THE DAY SOMETHING IS DUE
//
//  Found reading services/reports/orderBookReport.js line by line.
//
//  An order's supply date is a calendar date. The report compared it
//  with MOMENTS:
//
//  1. ON-TIME DELIVERY. A challan cut at nine in the morning on the
//     promised date came out as ceil(0.15 of a day) = 1 day late. Every
//     despatch that hit its date exactly was counted as a miss. The
//     challan screen's own on-time figure (GET /dc/otd-stats) was put
//     right for exactly this; the report, which says it follows "the
//     same rule", kept the old sum.
//
//  2. OVERDUE. An open order was overdue once its date was "before now"
//     — and a date is the first moment of its day, so an order due today
//     was overdue from half past five that morning. Everywhere else in
//     the app an order is overdue once its day has passed.
//
//  3. PENDING. "m pending" added up what was still to plan on every
//     order in the window, the cancelled and the completed ones too. A
//     cancelled order for 5,000 m showed as 5,000 m of open book.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

require("../../../models/Order.js");
require("../../../models/DeliveryChallan.js");
const { orderBookReport } = require("../../../services/reports/orderBookReport.js");

const oid = () => new mongoose.Types.ObjectId();
const customer = oid();
const line = (q) => [{ elastic: oid(), quantity: q }];
const day = (ymd) => new Date(`${ymd}T00:00:00.000Z`);          // a calendar date, as orders keep it
const at = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+05:30`);  // a moment in India

const FROM = day("2026-11-01");
const TO = day("2026-12-01");
// Half past ten in the morning on the 19th, in India.
const NOW = at("2026-11-19", "10:30");

let mongo;
let n = 6000;
const db = () => mongoose.connection;
const order = (over) => ({ _id: oid(), orderNo: (n += 1), date: day("2026-11-05"), customer, status: "InProgress", elasticOrdered: line(1000), pendingElastic: line(0), ...over });
const challan = (o, dispatchDate, over = {}) => ({ dcNumber: (n += 1), order: o._id, status: "dispatched", dispatchDate, ...over });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await db().collection("customers").insertOne({ _id: customer, name: "Acme" });
}, 60_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  await db().collection("orders").deleteMany({});
  await db().collection("deliverychallans").deleteMany({});
});

const report = (over = {}) => orderBookReport({ from: FROM, to: TO, now: NOW, ...over });

describe("on-time delivery", () => {
  it("a despatch on the promised date is on time, whatever the hour", async () => {
    const o = order({ supplyDate: day("2026-11-12") });
    await db().collection("orders").insertOne(o);
    await db().collection("deliverychallans").insertMany([
      challan(o, at("2026-11-12", "09:00")),
      challan(o, at("2026-11-12", "23:40")),
    ]);
    const r = await report();
    expect(r.summary.otdConsidered).toBe(2);
    // Before: 0 — both counted a day late.
    expect(r.summary.onTimePct).toBe(100);
  });

  it("one the day after is late, one the day before is on time", async () => {
    const o = order({ supplyDate: day("2026-11-12") });
    await db().collection("orders").insertOne(o);
    await db().collection("deliverychallans").insertMany([
      challan(o, at("2026-11-13", "00:20")),   // twenty past midnight: the 13th
      challan(o, at("2026-11-11", "18:00")),
    ]);
    const r = await report();
    expect(r.summary.onTimePct).toBe(50);
  });
});

describe("overdue", () => {
  it("an order due today is not overdue; one due yesterday is", async () => {
    await db().collection("orders").insertMany([
      order({ supplyDate: day("2026-11-19") }),   // today
      order({ supplyDate: day("2026-11-18") }),   // yesterday
      order({ supplyDate: day("2026-11-25") }),
    ]);
    const r = await report();
    // Before: 2 — the one due today counted from 05:30 this morning.
    expect(r.summary.overdueOrders).toBe(1);
  });

  it("a finished order is never overdue", async () => {
    await db().collection("orders").insertMany([
      order({ supplyDate: day("2026-11-10"), status: "Completed" }),
      order({ supplyDate: day("2026-11-10"), status: "Cancelled" }),
    ]);
    expect((await report()).summary.overdueOrders).toBe(0);
  });
});

describe("pending", () => {
  beforeEach(async () => {
    await db().collection("orders").insertMany([
      order({ supplyDate: day("2026-11-25"), status: "Approved",   elasticOrdered: line(1000), pendingElastic: line(400) }),
      order({ supplyDate: day("2026-11-25"), status: "Cancelled",  elasticOrdered: line(5000), pendingElastic: line(5000) }),
      order({ supplyDate: day("2026-11-25"), status: "Completed",  elasticOrdered: line(800),  pendingElastic: line(300) }),
    ]);
  });

  it("is what is still to plan on orders that are still open", async () => {
    const r = await report();
    expect(r.summary.orders).toBe(3);
    expect(r.summary.orderedQty).toBe(6800);
    // Before: 5,700 — the cancelled order's 5,000 m and the closed one's 300 m with it.
    expect(r.summary.pendingQty).toBe(400);
  });

  it("the same by customer, by status and by supply month", async () => {
    const byCustomer = await report({ groupBy: "customer" });
    expect(byCustomer.rows[0]).toMatchObject({ label: "Acme", orders: 3, orderedQty: 6800, pendingQty: 400 });

    const byStatus = await report({ groupBy: "status" });
    const of = Object.fromEntries(byStatus.rows.map((x) => [x.label, x]));
    expect(of.Approved.pendingQty).toBe(400);
    expect(of.Cancelled).toMatchObject({ orders: 1, orderedQty: 5000, pendingQty: 0 });
    expect(of.Completed.pendingQty).toBe(0);

    const byMonth = await report({ groupBy: "supplyMonth" });
    expect(byMonth.rows).toEqual([{ key: "2026-11", label: "2026-11", orders: 3, pendingQty: 400 }]);
  });
});
