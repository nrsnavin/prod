'use strict';
//
// CHARACTERIZATION test for api/shift.js applyProductionCascade — the
// core production cascade that /verify-production delegates to. Pins
// the CURRENT behaviour before the planned service-layer extraction
// (Phase B4). Transactional, so it uses MongoMemoryReplSet.
//
// The cascade is a pure-ish function over docs + a session; we call it
// directly (exported for this purpose) with a plain `shift` param
// object, exactly as the route constructs it.
//
// Subtle behaviours pinned here:
//   - job/order producedElastic accumulate the per-head value ONCE PER
//     HEAD running that elastic (not × NoOfHead),
//   - ShiftPlan.totalProduction accumulates prodValue × NoOfHead,
//   - produced is capped at the planned quantity,
//   - order.pendingElastic is recomputed as ordered − produced.

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, cascade, Machine, JobOrder, Order, ShiftPlan, Elastic;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Machine  = require('../../models/Machine');
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  ShiftPlan = require('../../models/ShiftPlan');
  Elastic  = require('../../models/Elastic');
  cascade  = require('../../api/shift.js').applyProductionCascade;
}, 90_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

async function runInTxn(fn) {
  const session = await mongoose.startSession();
  let out;
  try {
    await session.withTransaction(async () => { out = await fn(session); });
  } finally {
    await session.endSession();
  }
  return out;
}

// Seed a full running-machine scenario. `heads` = array of elastic ids
// (one entry per physical head running that elastic).
async function seedScenario({ noOfHead, heads, planned, alreadyProduced = 0, orderedQty }) {
  const elasticId = new mongoose.Types.ObjectId();
  const order = await Order.create({
    orderNo: 8001, status: 'InProgress', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    customer: new mongoose.Types.ObjectId(),
    elasticOrdered: [{ elastic: elasticId, quantity: orderedQty }],
    producedElastic: [{ elastic: elasticId, quantity: 0 }],
    pendingElastic:  [{ elastic: elasticId, quantity: orderedQty }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: order.customer,
    status: 'weaving',
    elastics:        [{ elastic: elasticId, quantity: planned }],
    producedElastic: [{ elastic: elasticId, quantity: alreadyProduced }],
  });
  const machine = await Machine.create({
    ID: 'M-1', manufacturer: 'Acme', NoOfHead: noOfHead, NoOfHooks: 8,
    status: 'running', orderRunning: job._id,
    elastics: heads.map((h) => ({ elastic: h ?? elasticId, head: 1 })),
  });
  const sp = await ShiftPlan.create({ date: new Date(), shift: 'DAY', totalProduction: 0 });
  const shift = { _id: new mongoose.Types.ObjectId(), machine: machine._id, shift: 'DAY', shiftPlan: sp._id };
  return { elasticId, order, job, machine, sp, shift };
}

describe('applyProductionCascade — guards', () => {
  test('throws on a negative productionMeters', async () => {
    const s = await seedScenario({ noOfHead: 4, heads: [null], planned: 1000, orderedQty: 1000 });
    await expect(runInTxn((session) =>
      cascade(session, { shift: s.shift, machine: s.machine, productionMeters: -5 })
    )).rejects.toThrow(/non-negative/);
  });

  test('throws when the machine has no running job', async () => {
    const machine = await Machine.create({
      ID: 'M-2', manufacturer: 'Acme', NoOfHead: 2, NoOfHooks: 4,
      status: 'free', orderRunning: null, elastics: [],
    });
    const sp = await ShiftPlan.create({ date: new Date(), shift: 'DAY', totalProduction: 0 });
    const shift = { _id: new mongoose.Types.ObjectId(), machine: machine._id, shift: 'DAY', shiftPlan: sp._id };
    await expect(runInTxn((session) =>
      cascade(session, { shift, machine, productionMeters: 10 })
    )).rejects.toThrow(/no running job/);
  });
});

describe('applyProductionCascade — accumulation + fan-out', () => {
  test('one head: job/order += per-head value; ShiftPlan += value × NoOfHead', async () => {
    const s = await seedScenario({ noOfHead: 4, heads: [null], planned: 1000, orderedQty: 1000 });
    await runInTxn((session) =>
      cascade(session, { shift: s.shift, machine: s.machine, productionMeters: 100 })
    );

    const job = await JobOrder.findById(s.job._id);
    // ONE head → +100 (per-head value), NOT ×NoOfHead.
    expect(job.producedElastic[0].quantity).toBe(100);
    // SHIFT_PRODUCTION_VERIFIED fingerprint records both figures.
    const fp = job.fingerprints.find(f => f.code === 'SHIFT_PRODUCTION_VERIFIED');
    expect(fp.meta.production).toBe(100);
    expect(fp.meta.productionMeters).toBe(400); // 100 × NoOfHead(4)

    const order = await Order.findById(s.order._id);
    expect(order.producedElastic[0].quantity).toBe(100);
    // Pending is ordered MINUS PLANNED — production does not move it.
    // The job plans the full 1000, so nothing still needs a job raised.
    expect(order.pendingElastic[0].quantity).toBe(0);

    const sp = await ShiftPlan.findById(s.sp._id);
    expect(sp.totalProduction).toBe(400); // 100 × NoOfHead(4)
  });

  test('multiple heads on the same elastic each contribute the per-head value', async () => {
    const s = await seedScenario({ noOfHead: 2, heads: [null, null], planned: 5000, orderedQty: 5000 });
    await runInTxn((session) =>
      cascade(session, { shift: s.shift, machine: s.machine, productionMeters: 100 })
    );
    const job = await JobOrder.findById(s.job._id);
    // 2 heads × 100 = 200 accumulated on the job.
    expect(job.producedElastic[0].quantity).toBe(200);
  });

  test('produced is capped at the planned quantity', async () => {
    const s = await seedScenario({ noOfHead: 1, heads: [null], planned: 1000, alreadyProduced: 950, orderedQty: 1000 });
    await runInTxn((session) =>
      cascade(session, { shift: s.shift, machine: s.machine, productionMeters: 100 })
    );
    const job = await JobOrder.findById(s.job._id);
    // 950 + 100 = 1050 → capped to planned 1000.
    expect(job.producedElastic[0].quantity).toBe(1000);
  });
});
