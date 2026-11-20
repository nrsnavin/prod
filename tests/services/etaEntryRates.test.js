'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE RATE BEHIND "ESTIMATED COMPLETION" ON A NEW ORDER
//
//  services/etaService.buildEntryTimeAggregates works out, for each
//  elastic on the order, the metres a loom makes of it in a day. It
//  unwound a shift's heads and added the shift's metres once for every
//  head: a four-head loom that made 1,800 m of one elastic in a day was
//  taken to make 7,200 m of it — and the date promised to the customer
//  was worked out at four times the loom's real pace.
//
//    • a loom's day counts once for an elastic, however many heads ran it
//    • a loom shared by two elastics gives each the loom's pace, not double
//    • the plant rate and the elastic rate agree where one elastic ran alone
//    • a shift kept at the older IST midnight is the same day as its pair
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, eta;
const oid = () => new mongoose.Types.ObjectId();
const [A, B, m1, m2] = [oid(), oid(), oid(), oid()];
const NOW = new Date('2026-11-20T06:00:00Z');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  eta = require('../../services/etaService');
  const db = mongoose.connection;
  await db.collection('machines').insertMany([{ _id: m1, ID: 'L-01', NoOfHead: 4, status: 'running' }, { _id: m2, ID: 'L-02', NoOfHead: 4, status: 'free' }]);
  const heads = (...els) => els.map((elastic, i) => ({ head: i + 1, elastic }));
  await db.collection('shiftdetails').insertMany([
    // Loom 1, 17 Nov: all four heads on A, day and night. 1,000 + 800 = 1,800 m that day.
    { status: 'closed', date: new Date('2026-11-17T00:00:00Z'), shift: 'DAY', machine: m1, productionMeters: 1000, elastics: heads(A, A, A, A) },
    // The night shift kept the older way, at 00:00 IST: still the 17th.
    { status: 'closed', date: new Date('2026-11-16T18:30:00Z'), shift: 'NIGHT', machine: m1, productionMeters: 800, elastics: heads(A, A, A, A) },
    // Loom 2, 18 Nov: two heads on A, two on B. 1,200 m off the loom.
    { status: 'closed', date: new Date('2026-11-18T00:00:00Z'), shift: 'DAY', machine: m2, productionMeters: 1200, elastics: heads(A, A, B, B) },
    // Not verified: not counted.
    { status: 'pending_verification', date: new Date('2026-11-18T00:00:00Z'), shift: 'NIGHT', machine: m2, productionMeters: 9999, elastics: heads(A, A, A, A) },
  ]);
}, 60_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('metres a loom makes of an elastic in a day', () => {
  it('counts a loom-day once, whatever the number of heads', async () => {
    const { aggregates, summary } = await eta.buildEntryTimeAggregates([{ elastic: String(A) }, { elastic: String(B) }], NOW);
    // Plant: (1,800 + 1,200) m over two loom-days.
    expect(summary.machineDaysSampled).toBe(2);
    expect(aggregates.plantRate).toBe(1500);
    // A ran on loom 1 on the 17th (1,800 m) and on loom 2 on the 18th (1,200 m): 1,500 a loom-day.
    expect(aggregates.elasticRate[String(A)]).toBe(1500);
    // B ran on loom 2 on the 18th: the loom made 1,200 m that day.
    expect(aggregates.elasticRate[String(B)]).toBe(1200);
    // No elastic is ever faster than the fastest loom-day there was.
    for (const r of Object.values(aggregates.elasticRate)) expect(r).toBeLessThanOrEqual(1800);
  });
});
