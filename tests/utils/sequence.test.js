'use strict';
//
// Concurrency test for the atomic document-number allocator.
// The property that matters: N parallel calls — including the very
// first ones that race to seed the counter — must yield N distinct,
// monotonically increasing numbers starting above the seed.

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Counter = require("../../models/Counter");
const { nextNumber } = require("../../utils/sequence");

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Counter.deleteMany({});
});

describe("nextNumber", () => {
  it("seeds from existing data and starts above it", async () => {
    const n = await nextNumber("poNo", async () => 1042);
    expect(n).toBe(1043);
  });

  it("starts at 1 when there is no existing data", async () => {
    const n = await nextNumber("fresh", async () => 0);
    expect(n).toBe(1);
  });

  it("hands out distinct numbers under parallel load (cold start)", async () => {
    // All 25 callers race the initial seed AND the increments.
    const results = await Promise.all(
      Array.from({ length: 25 }, () => nextNumber("poNo", async () => 1000))
    );
    const unique = new Set(results);
    expect(unique.size).toBe(25);            // no duplicates — the actual bug
    expect(Math.min(...results)).toBeGreaterThan(1000);
  });

  it("hands out distinct numbers under parallel load (warm counter)", async () => {
    await nextNumber("dc:elastic:25/26", async () => 7);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => nextNumber("dc:elastic:25/26", async () => 7))
    );
    expect(new Set(results).size).toBe(25);
    expect(Math.min(...results)).toBeGreaterThan(8 - 1);
  });

  it("keeps independent keys independent", async () => {
    const a = await nextNumber("k1", async () => 100);
    const b = await nextNumber("k2", async () => 500);
    expect(a).toBe(101);
    expect(b).toBe(501);
  });
});
