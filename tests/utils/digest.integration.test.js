'use strict';
//
// Integration smoke for buildDigestData on an empty DB.
//
// formatDigest is pure and already heavily tested in digest.test.js,
// but the aggregators each touch a different model. If any of them
// references an un-imported model the unit tests can't catch it —
// that's exactly how the "ShiftDetail is not defined" prod bug
// shipped. This test runs the whole pipeline end-to-end against a
// real mongoose connection (in-memory) so any missing require()
// fails loudly at test time.

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo, buildDigestData;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // _predictedLate now imports the lightweight services/etaService.js
  // directly (no Express router pulled in), so the pipeline runs for
  // real against the empty DB — the aggregator returns [] with no
  // orders present.
  buildDigestData = require("../../utils/digest.js").buildDigestData;
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});

describe("digest.buildDigestData (integration smoke)", () => {
  test("runs end-to-end on an empty DB without throwing", async () => {
    const data = await buildDigestData(new Date("2026-06-21T03:00:00Z"));
    // Each aggregator returns its expected default shape.
    expect(data).toMatchObject({
      production:     { meters: 0, shifts: 0 },
      wastage:        { meters: 0, penalty: 0, entries: 0, topReason: null },
      stockouts:      expect.any(Array),
      maintenance:    expect.any(Array),
      predictedLate:  expect.any(Array),
      orderActivity: { edited: 0 },
      posteriorDrift: expect.any(Array),
      attendance:     expect.objectContaining({ totalEffective: 0 }),
      leave:         { pending: 0 },
      complaints:    { openCount: 0, newYesterday: 0 },
      commercial:    { dispatchDcs: 0, dispatchValue: 0, openOrders: 0, overdueOrders: 0, pendingMeters: 0, lowStock: 0 },
    });
    expect(typeof data.dateLabel).toBe("string");
  });
});

// Found reading services/reports: the digest's "at/below reorder" count, like the
// stock report's, still counted retired materials. One retired with a minimum set
// sits at nothing for good, so it was in the morning message every day.
describe("the digest's low-stock count", () => {
  test("leaves out retired materials", async () => {
    const db = mongoose.connection;
    await db.collection("rawmaterials").insertMany([
      { name: "In use, low", stock: 5, minStock: 20 },
      { name: "In use, fine", stock: 50, minStock: 20 },
      { name: "Retired, had a minimum", stock: 0, minStock: 25, archived: true },
    ]);
    try {
      const data = await buildDigestData(new Date("2026-06-21T03:00:00Z"));
      expect(data.commercial.lowStock).toBe(1);
    } finally {
      await db.collection("rawmaterials").deleteMany({});
    }
  });
});
