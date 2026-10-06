'use strict';
//
// Transactional outbox (Phase 3).
//
// Properties under test:
//   1. Atomicity — an event enqueued inside an aborted transaction never
//      exists; inside a committed one it does. (The whole point.)
//   2. Delivery — processDueEvents runs the handler and marks sent.
//   3. Retry — a failing handler reschedules with backoff, then delivers
//      on a later pass once the handler recovers.
//   4. Permanent failure — after MAX_ATTEMPTS the event parks as failed.

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

// Stub the handler registry BEFORE requiring the dispatcher.
const mockCalls = [];
let mockFailTimes = { n: 0 };
jest.mock("../../utils/outboxHandlers.js", () => ({
  getHandler: (kind) =>
    kind === "test.event"
      ? async (payload) => {
          mockCalls.push(payload);
          if (mockFailTimes.n > 0) { mockFailTimes.n -= 1; throw new Error("transient boom"); }
        }
      : null,
}));

const Outbox = require("../../models/Outbox.js");
const { enqueue, processDueEvents, MAX_ATTEMPTS } = require("../../utils/outbox.js");

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Outbox.deleteMany({});
  mockCalls.length = 0;
  mockFailTimes.n = 0;
});

describe("transactional outbox", () => {
  it("an event enqueued in an ABORTED transaction never exists", async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await enqueue(session, "test.event", { n: 1 });
        throw new Error("business write failed — roll everything back");
      }).catch(() => {});
    } finally {
      session.endSession();
    }
    expect(await Outbox.countDocuments({})).toBe(0); // no orphan alert
  });

  it("delivers a committed event and marks it sent", async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await enqueue(session, "test.event", { n: 2 });
      });
    } finally {
      session.endSession();
    }

    const res = await processDueEvents();
    expect(res.sent).toBe(1);
    expect(mockCalls).toEqual([{ n: 2 }]);
    const doc = await Outbox.findOne({}).lean();
    expect(doc.status).toBe("sent");
    expect(doc.sentAt).toBeTruthy();
  });

  it("retries with backoff, then delivers when the handler recovers", async () => {
    mockFailTimes.n = 1; // first attempt throws, second succeeds
    await enqueue(null, "test.event", { n: 3 });

    const first = await processDueEvents();
    expect(first.retried).toBe(1);
    let doc = await Outbox.findOne({}).lean();
    expect(doc.status).toBe("pending");
    expect(doc.attempts).toBe(1);
    expect(doc.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backed off
    expect(doc.lastError).toMatch(/transient boom/);

    // Not due yet → a pass right now does nothing.
    expect((await processDueEvents()).sent).toBe(0);

    // Simulate the backoff elapsing by passing a future "now".
    const later = new Date(Date.now() + 10 * 60 * 1000);
    const second = await processDueEvents(later);
    expect(second.sent).toBe(1);
    doc = await Outbox.findOne({}).lean();
    expect(doc.status).toBe("sent");
  });

  it("parks the event as failed after MAX_ATTEMPTS", async () => {
    mockFailTimes.n = MAX_ATTEMPTS + 1; // never recovers
    await enqueue(null, "test.event", { n: 4 });

    let now = new Date();
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await processDueEvents(now);
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000); // leap past any backoff
    }

    const doc = await Outbox.findOne({}).lean();
    expect(doc.status).toBe("failed");
    expect(doc.attempts).toBe(MAX_ATTEMPTS);
  });

  it("reclaims an event abandoned mid-delivery once its lease runs out, and not before", async () => {
    // A process that died while delivering left the event "processing"
    // for good: never retried, never failed.
    const ev = await enqueue(null, "test.event", { id: "stuck" });
    const minutes = (n) => new Date(Date.now() - n * 60_000);
    // Claimed 2 minutes ago by a process still (perhaps) delivering it:
    // left alone, so it is not delivered twice.
    await Outbox.collection.updateOne({ _id: ev._id }, { $set: { status: "processing", updatedAt: minutes(2) } });
    await processDueEvents();
    expect(mockCalls.filter((c) => c.id === "stuck")).toHaveLength(0);
    // Claimed longer ago than the lease: taken to be abandoned.
    await Outbox.collection.updateOne({ _id: ev._id }, { $set: { updatedAt: minutes(11) } });
    await processDueEvents();
    expect(mockCalls.filter((c) => c.id === "stuck")).toHaveLength(1);
    expect((await Outbox.findById(ev._id).lean()).status).toBe("sent");
  });

  it("unknown kinds fail loudly instead of vanishing", async () => {
    await Outbox.create([{ kind: "no.such.handler", payload: {} }]);
    const res = await processDueEvents();
    expect(res.retried).toBe(1);
    const doc = await Outbox.findOne({}).lean();
    expect(doc.lastError).toMatch(/No handler registered/);
  });
});
