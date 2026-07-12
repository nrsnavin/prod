'use strict';
//
// Accounting invariants for the elastic stock ledger (Phase 5).
//
// utils/elasticStock.applyMovement is the single door to Elastic.stock.
// Property-style test: run a SEEDED pseudo-random sequence of movements
// (inward, outward, reversals, info-rows, clamped over-draws) and then
// assert the equations that must hold after ANY history:
//
//   1. stock is never negative (the zero-floor clamp)
//   2. stock_final == stock_initial + Σ movement.applied   (the ledger
//      exactly explains the stock — the debits==credits of this system)
//   3. every movement's recorded `balance` equals the running sum
//   4. |applied| ≤ |requested|, equal when no clamp occurred
//   5. info-only rows (reservation hold/release) never move stock
//
// Deterministic seed → a failure is reproducible, not a flake.

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Elastic       = require("../../models/Elastic");
const StockMovement = require("../../models/StockMovement");
const { applyMovement } = require("../../utils/elasticStock");

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// Small deterministic PRNG (mulberry32) — reproducible sequences.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STOCK_TYPES = [
  "PACKING_INWARD", "PACKING_REVERSE", "DC_OUT",
  "DC_CANCEL_RETURN", "WASTAGE_OUT", "WASTAGE_RETURN", "MANUAL_ADJUST",
];
const INFO_TYPES = ["RESERVATION_HOLD", "RESERVATION_RELEASE"];

describe("stock ledger invariants", () => {
  it("hold after 200 seeded pseudo-random movements", async () => {
    const rand = prng(20260712);
    const initialStock = 500;
    const elastic = await Elastic.create({
      name: `INV-${Date.now()}`, stock: initialStock,
      weight: 1, noOfHook: 1, pick: 1, spandexEnds: 1,
    });

    const applieds = [];
    for (let i = 0; i < 200; i += 1) {
      const info = rand() < 0.15;
      const type = info
        ? INFO_TYPES[Math.floor(rand() * INFO_TYPES.length)]
        : STOCK_TYPES[Math.floor(rand() * STOCK_TYPES.length)];
      // Mostly small deltas; occasionally a huge overdraw to force the
      // zero-floor clamp path.
      const magnitude = rand() < 0.1 ? 100000 : Math.ceil(rand() * 300);
      const sign = rand() < 0.5 ? -1 : 1;
      const requested = sign * magnitude;

      const before = Number((await Elastic.findById(elastic._id).lean()).stock);
      const { movement } = await applyMovement(null, {
        elasticId: elastic._id, type, quantity: requested,
        reason: `invariant seq #${i}`,
      });
      const after = Number((await Elastic.findById(elastic._id).lean()).stock);

      // (1) never negative
      expect(after).toBeGreaterThanOrEqual(0);

      if (INFO_TYPES.includes(type)) {
        // (5) info rows never move stock
        expect(after).toBe(before);
      } else {
        // (4) applied is the clamped delta, never exceeding the request
        expect(Math.abs(movement.applied)).toBeLessThanOrEqual(Math.abs(requested));
        expect(after - before).toBe(movement.applied);
        // (3) the recorded balance is the post-movement stock
        expect(movement.balance).toBe(after);
        applieds.push(movement.applied);
      }
    }

    // (2) the ledger exactly explains the stock
    const finalStock = Number((await Elastic.findById(elastic._id).lean()).stock);
    const ledgerSum = applieds.reduce((s, a) => s + a, 0);
    expect(finalStock).toBe(initialStock + ledgerSum);

    // Cross-check against what's persisted, not just in-memory values.
    const persisted = await StockMovement.aggregate([
      { $match: { elastic: elastic._id, type: { $in: STOCK_TYPES } } },
      { $group: { _id: null, sum: { $sum: "$applied" } } },
    ]);
    expect(finalStock).toBe(initialStock + (persisted[0]?.sum || 0));
  }, 120_000);

  it("a movement and its exact reversal restore the starting stock", async () => {
    const elastic = await Elastic.create({ name: `REV-${Date.now()}`, stock: 100, weight: 1, noOfHook: 1, pick: 1, spandexEnds: 1 });

    const out = await applyMovement(null, {
      elasticId: elastic._id, type: "DC_OUT", quantity: -60, reason: "dispatch",
    });
    // Reverse by APPLIED (the P0-1 rule), not by requested.
    await applyMovement(null, {
      elasticId: elastic._id, type: "DC_CANCEL_RETURN",
      quantity: -out.movement.applied, reason: "cancel",
    });

    const finalStock = Number((await Elastic.findById(elastic._id).lean()).stock);
    expect(finalStock).toBe(100);
  });

  it("reversing a CLAMPED movement refunds only what actually left", async () => {
    const elastic = await Elastic.create({ name: `CLAMP-${Date.now()}`, stock: 40, weight: 1, noOfHook: 1, pick: 1, spandexEnds: 1 });

    // Request −100 with only 40 on hand → applied is −40 (clamped).
    const out = await applyMovement(null, {
      elasticId: elastic._id, type: "DC_OUT", quantity: -100, reason: "overdraw",
    });
    expect(out.movement.applied).toBe(-40);

    // Refunding by |applied| restores exactly 40 — refunding by the
    // requested 100 would invent 60 units that never existed.
    await applyMovement(null, {
      elasticId: elastic._id, type: "DC_CANCEL_RETURN",
      quantity: -out.movement.applied, reason: "cancel overdraw",
    });
    const finalStock = Number((await Elastic.findById(elastic._id).lean()).stock);
    expect(finalStock).toBe(40);
  });
});
