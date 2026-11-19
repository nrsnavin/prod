"use strict";
// ══════════════════════════════════════════════════════════════════
//  THE ORDER BOOK: "PENDING" SAID ONE THING AND COUNTED ANOTHER
//
//  Found reading api/orderProgress.js, then following the same figure
//  into the order book report and the morning digest.
//
//  The report's "Pending (m)" and the digest's "12 open · 45,000 m
//  pending" are both the orders' pendingElastic added up — and that is
//  what no job has been raised for yet (services/orderPending.js), not
//  what is still to be delivered. A book planned onto jobs in full, with
//  nothing made, read "0 m pending".
//
//  The figure is kept, under its own name ("not yet planned"), and what
//  is still owed — ordered less packed, line by line, on orders that are
//  still open — is reported beside it. The same rule as the delivery-risk
//  list (services/deliveryRisk.js), so the three cannot disagree.
//
//  Also: the digest counted an order as overdue from 05:30 on the day it
//  was due (a date compared with a moment). The report was put right
//  earlier; the digest "mirrors the numbers the reports show" and did not.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

require("../../../models/Order.js");
require("../../../models/DeliveryChallan.js");
const { orderBookReport } = require("../../../services/reports/orderBookReport.js");
const { stillOwed, STILL_OWED_EXPR } = require("../../../services/deliveryRisk.js");

const oid = () => new mongoose.Types.ObjectId();
const customer = oid();
const day = (ymd) => new Date(`${ymd}T00:00:00.000Z`);
const at = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00+05:30`);

const FROM = day("2026-11-01");
const TO = day("2026-12-01");
const NOW = at("2026-11-19", "10:30");

let mongo;
let n = 8000;
const db = () => mongoose.connection;
const a = oid(), b = oid();
/** An order of two lines: 1,000 m of A and 500 m of B. */
const order = (over = {}) => ({
  _id: oid(), orderNo: (n += 1), date: day("2026-11-05"), supplyDate: day("2026-11-25"), customer, status: "InProgress",
  elasticOrdered: [{ elastic: a, quantity: 1000 }, { elastic: b, quantity: 500 }],
  pendingElastic: [{ elastic: a, quantity: 0 }, { elastic: b, quantity: 0 }],
  packedElastic: [{ elastic: a, quantity: 0 }, { elastic: b, quantity: 0 }],
  ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await db().collection("customers").insertOne({ _id: customer, name: "Acme" });
}, 60_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of ["orders", "deliverychallans", "rawmaterials"]) await db().collection(c).deleteMany({});
});

const report = (over = {}) => orderBookReport({ from: FROM, to: TO, now: NOW, ...over });

describe("still to deliver", () => {
  it("is what was ordered less what is packed, though every metre has a job", async () => {
    await db().collection("orders").insertOne(order());
    const r = await report();
    // Nothing left to plan — and that was the whole of "pending".
    expect(r.summary.pendingQty).toBe(0);
    // Before: there was no such figure.
    expect(r.summary.toDeliverQty).toBe(1500);
  });

  it("is counted line by line: a line packed over does not pay for one behind", async () => {
    await db().collection("orders").insertOne(order({
      packedElastic: [{ elastic: a, quantity: 1200 }, { elastic: b, quantity: 100.5 }],
    }));
    expect((await report()).summary.toDeliverQty).toBe(399.5);
  });

  it("counts nothing on an order that is closed", async () => {
    await db().collection("orders").insertMany([
      order({ status: "Completed" }),
      order({ status: "Cancelled" }),
      order({ status: "Open", packedElastic: undefined }),
    ]);
    const r = await report();
    expect(r.summary.toDeliverQty).toBe(1500);
  });

  it("is on every breakdown", async () => {
    await db().collection("orders").insertMany([
      order({ status: "Approved", pendingElastic: [{ elastic: a, quantity: 400 }, { elastic: b, quantity: 0 }] }),
      order({ status: "InProgress", packedElastic: [{ elastic: a, quantity: 1000 }, { elastic: b, quantity: 200 }] }),
      order({ status: "Completed", packedElastic: [{ elastic: a, quantity: 1000 }, { elastic: b, quantity: 500 }] }),
    ]);
    const byCustomer = await report({ groupBy: "customer" });
    expect(byCustomer.rows[0]).toMatchObject({ label: "Acme", orders: 3, orderedQty: 4500, pendingQty: 400, toDeliverQty: 1800 });

    const of = Object.fromEntries((await report({ groupBy: "status" })).rows.map((x) => [x.label, x]));
    expect(of.Approved).toMatchObject({ pendingQty: 400, toDeliverQty: 1500 });
    expect(of.InProgress).toMatchObject({ pendingQty: 0, toDeliverQty: 300 });
    expect(of.Completed).toMatchObject({ pendingQty: 0, toDeliverQty: 0 });

    const byMonth = await report({ groupBy: "supplyMonth" });
    expect(byMonth.rows).toEqual([{ key: "2026-11", label: "2026-11", orders: 3, pendingQty: 400, toDeliverQty: 1800 }]);
  });

  it("the columns say which is which", async () => {
    const headers = (r) => Object.fromEntries(r.columns.map((c) => [c.key, c.header]));
    expect(headers(await report({ groupBy: "customer" }))).toMatchObject({ pendingQty: "Not yet planned", toDeliverQty: "Still to deliver" });
    expect(headers(await report({ groupBy: "supplyMonth" }))).toMatchObject({ pendingQty: "Not yet planned", toDeliverQty: "Still to deliver" });
  });

  it("is the delivery-risk list's own figure, worked out in the database", async () => {
    const cases = [
      order(),
      order({ packedElastic: [{ elastic: a, quantity: 1200 }, { elastic: b, quantity: 100.5 }] }),
      order({ packedElastic: [] }),
      order({ packedElastic: undefined }),
      // Two boxes' worth kept as two rows for one elastic.
      order({ packedElastic: [{ elastic: a, quantity: 300 }, { elastic: a, quantity: 300.3 }] }),
      order({ elasticOrdered: [], packedElastic: [] }),
    ];
    await db().collection("orders").insertMany(cases);
    const rows = await db().collection("orders").aggregate([{ $project: { owed: STILL_OWED_EXPR } }]).toArray();
    const inDb = new Map(rows.map((r) => [String(r._id), Math.round(r.owed * 1000) / 1000]));
    for (const o of cases) expect(inDb.get(String(o._id))).toBe(stillOwed(o));
  });
});

describe("the morning digest's order book line", () => {
  const { buildDigestData, formatDigest } = require("../../../utils/digest.js");

  it("an order due today is not overdue; one due yesterday is", async () => {
    await db().collection("orders").insertMany([
      order({ supplyDate: day("2026-11-19") }),   // today
      order({ supplyDate: day("2026-11-18") }),   // yesterday
      order({ supplyDate: day("2026-11-25") }),
    ]);
    const d = await buildDigestData(NOW);
    // Before: 2 — the one due today counted from 05:30 this morning.
    expect(d.commercial.overdueOrders).toBe(1);
    expect(d.commercial.openOrders).toBe(3);
  });

  it("says what is still to deliver, and what of it has no job", async () => {
    await db().collection("orders").insertMany([
      order({ pendingElastic: [{ elastic: a, quantity: 400 }, { elastic: b, quantity: 0 }] }),
      order({ packedElastic: [{ elastic: a, quantity: 1000 }, { elastic: b, quantity: 200 }] }),
      order({ status: "Completed" }),
    ]);
    const d = await buildDigestData(NOW);
    expect(d.commercial).toMatchObject({ openOrders: 2, pendingMeters: 400, toDeliverMeters: 1800 });

    const text = formatDigest(d);
    // Before: "2 open · 400 m pending" — as if 400 m were all that was owed.
    expect(text).toMatch(/Order book: 2 open · 1,800 m still to deliver \(400 m not yet planned\)/);
    expect(text).not.toMatch(/m pending/);
  });

  it("leaves the bracket out when everything is planned", async () => {
    await db().collection("orders").insertOne(order());
    const text = formatDigest(await buildDigestData(NOW));
    expect(text).toMatch(/Order book: 1 open · 1,500 m still to deliver(?! \()/);
  });

  it("reads an older digest record that has no such figure", () => {
    const text = formatDigest({
      dateLabel: "18 Nov", production: { meters: 0, shifts: 0 }, wastage: { meters: 0, penalty: 0, entries: 0 },
      stockouts: [], maintenance: [], predictedLate: [],
      commercial: { dispatchDcs: 0, dispatchValue: 0, openOrders: 5, overdueOrders: 0, pendingMeters: 700, lowStock: 0 },
    });
    expect(text).toMatch(/Order book: 5 open · 700 m not yet planned/);
  });
});
