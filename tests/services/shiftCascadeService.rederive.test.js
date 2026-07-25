'use strict';
//
// CHARACTERIZATION test for _rederiveShiftProduction — the DELTA
// correction path that PUT /production-entry (edit) and DELETE
// (zero-out) delegate to, extracted from api/shift.js into
// services/shiftCascadeService.js in the Phase 4 god-file split.
//
// Where applyProductionCascade ADDS a freshly-verified shift, this
// re-derives job/order/plan rollups from the per-head delta between a
// shift's OLD and NEW totals — so an edit doesn't double count and a
// delete backs the contribution out. Behaviours pinned here:
//   - delta is fanned per head (heads = shift.elastics.length),
//   - job.producedElastic moves by deltaPerHead × heads, floored at 0,
//   - produced is capped at the planned quantity,
//   - order.producedElastic is recomputed from the SUM of its jobs and
//     pending from ordered − produced,
//   - ShiftPlan.totalProduction moves by deltaPerHead × heads, floored at 0,
//   - a shift with no linked job throws instead of corrupting state.
//
// Transactional → MongoMemoryReplSet.

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { ACTION_CODES } = require('../../utils/fingerprint');

let mongo, rederive, JobOrder, Order, ShiftPlan;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  ShiftPlan = require('../../models/ShiftPlan');
  rederive = require('../../services/shiftCascadeService.js')._rederiveShiftProduction;
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

// Seed an order + job + shift-plan and a plain `shift` param object,
// exactly as the correct/delete routes construct it. `heads` = number
// of physical heads running the single elastic; `oldTotal` is the
// shift's currently-recorded meters.
async function seed({ planned, alreadyProduced, orderedQty, heads, oldTotal }) {
  const elasticId = new mongoose.Types.ObjectId();
  const order = await Order.create({
    orderNo: 9101, status: 'InProgress', po: 'PO-9',
    date: new Date(), supplyDate: new Date(),
    customer: new mongoose.Types.ObjectId(),
    elasticOrdered: [{ elastic: elasticId, quantity: orderedQty }],
    producedElastic: [{ elastic: elasticId, quantity: alreadyProduced }],
    pendingElastic:  [{ elastic: elasticId, quantity: Math.max(0, orderedQty - alreadyProduced) }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: order.customer,
    status: 'weaving',
    elastics:        [{ elastic: elasticId, quantity: planned }],
    producedElastic: [{ elastic: elasticId, quantity: alreadyProduced }],
  });
  const sp = await ShiftPlan.create({ date: new Date(), shift: 'DAY', totalProduction: oldTotal });
  const shift = {
    _id: new mongoose.Types.ObjectId(),
    job: job._id,
    shiftPlan: sp._id,
    productionMeters: oldTotal,
    elastics: Array.from({ length: heads }, () => ({ elastic: elasticId, head: 1 })),
  };
  return { elasticId, order, job, sp, shift };
}

describe('_rederiveShiftProduction — correction (edit up/down)', () => {
  test('correcting UP fans +delta per head into job/order/plan', async () => {
    // 4 heads, old 400 (per-head 100), new 800 (per-head 200) → +100/head ×4 = +400.
    const s = await seed({ planned: 5000, alreadyProduced: 400, orderedQty: 5000, heads: 4, oldTotal: 400 });
    await runInTxn((session) => rederive(session, {
      shift: s.shift, newTotalMeters: 800, req: null,
      auditReason: 'miscount', code: ACTION_CODES.SHIFT_PRODUCTION_EDITED,
    }));

    const job = await JobOrder.findById(s.job._id);
    expect(job.producedElastic[0].quantity).toBe(800); // 400 + 400
    const fp = job.fingerprints.find(f => f.code === ACTION_CODES.SHIFT_PRODUCTION_EDITED);
    expect(fp).toBeTruthy();
    expect(fp.meta.before.productionMeters).toBe(400);
    expect(fp.meta.after.productionMeters).toBe(800);

    const order = await Order.findById(s.order._id);
    expect(order.producedElastic[0].quantity).toBe(800);
    // Pending is ordered MINUS PLANNED, not minus produced: the job plans
    // the whole 5000, so nothing is left needing a job raised for it.
    // Production only moves producedElastic.
    expect(order.pendingElastic[0].quantity).toBe(0);

    const sp = await ShiftPlan.findById(s.sp._id);
    expect(sp.totalProduction).toBe(800); // 400 + deltaPerHead(100) × heads(4)
  });

  test('correcting DOWN backs the delta out, flooring job produced at 0', async () => {
    // 4 heads, old 800 (per-head 200), new 0 → −200/head ×4 = −800 → floored at 0.
    const s = await seed({ planned: 5000, alreadyProduced: 800, orderedQty: 5000, heads: 4, oldTotal: 800 });
    await runInTxn((session) => rederive(session, {
      shift: s.shift, newTotalMeters: 0, req: null,
      auditReason: 'entered in error', code: ACTION_CODES.SHIFT_PRODUCTION_EDITED,
    }));

    const job = await JobOrder.findById(s.job._id);
    expect(job.producedElastic[0].quantity).toBe(0);

    const order = await Order.findById(s.order._id);
    expect(order.producedElastic[0].quantity).toBe(0);
    // Unchanged by the correction — the job still holds the planned 5000.
    expect(order.pendingElastic[0].quantity).toBe(0);

    const sp = await ShiftPlan.findById(s.sp._id);
    expect(sp.totalProduction).toBe(0); // 800 + (−200 × 4), floored at 0
  });

  test('produced stays capped at the planned quantity', async () => {
    // Planned 1000, already 900; new total pushes +400 → 1300, clamp to 1000.
    const s = await seed({ planned: 1000, alreadyProduced: 900, orderedQty: 1000, heads: 4, oldTotal: 400 });
    await runInTxn((session) => rederive(session, {
      shift: s.shift, newTotalMeters: 800, req: null,
      auditReason: 'correction', code: ACTION_CODES.SHIFT_PRODUCTION_EDITED,
    }));
    const job = await JobOrder.findById(s.job._id);
    expect(job.producedElastic[0].quantity).toBe(1000);
  });
});

describe('_rederiveShiftProduction — guards', () => {
  test('throws when the shift is not linked to a job', async () => {
    const sp = await ShiftPlan.create({ date: new Date(), shift: 'DAY', totalProduction: 0 });
    const shift = {
      _id: new mongoose.Types.ObjectId(), job: null, shiftPlan: sp._id,
      productionMeters: 100, elastics: [{ elastic: new mongoose.Types.ObjectId(), head: 1 }],
    };
    await expect(runInTxn((session) => rederive(session, {
      shift, newTotalMeters: 200, req: null,
      auditReason: 'x', code: ACTION_CODES.SHIFT_PRODUCTION_EDITED,
    }))).rejects.toThrow(/job order/i);
  });
});
