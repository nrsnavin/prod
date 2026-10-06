'use strict';
// ══════════════════════════════════════════════════════════════════
//  SHIFT ALERTS GO OUT AFTER THE VERIFICATION COMMITS
//
//  The low-output and machine-anomaly WhatsApp alerts used to be sent
//  from inside the verify transaction: a retried transaction sent them
//  twice, and one that rolled back had already sent them. They are now
//  queued in the outbox with the verification and delivered after it.
//
//  And they compare per head with per head. The stored figure is per
//  head × the machine's heads; comparing it with the per-head entry made
//  an ordinary shift on a six-head loom look like 17% of normal.
// ══════════════════════════════════════════════════════════════════

jest.mock('../../utils/notify', () => ({ notify: jest.fn(async () => ({ sent: true })) }));

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, cascade, notify, processDueEvents, Machine, JobOrder, Order, ShiftPlan, ShiftDetail, Outbox;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Machine = require('../../models/Machine');
  JobOrder = require('../../models/JobOrder');
  Order = require('../../models/Order');
  ShiftPlan = require('../../models/ShiftPlan');
  ShiftDetail = require('../../models/ShiftDetail');
  Outbox = require('../../models/Outbox');
  cascade = require('../../services/shiftCascadeService').applyProductionCascade;
  ({ notify } = require('../../utils/notify'));
  ({ processDueEvents } = require('../../utils/outbox'));
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  notify.mockClear();
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

const DAY = 86_400_000;

/** A six-head loom with a running job, and a history of closed shifts at `perHead` each. */
async function seed({ heads = 6, historyPerHead = 400, history = 10 } = {}) {
  const elasticId = new mongoose.Types.ObjectId();
  const order = await Order.create({
    orderNo: 9001, status: 'InProgress', po: 'PO-1', date: new Date(), supplyDate: new Date(),
    customer: new mongoose.Types.ObjectId(),
    elasticOrdered: [{ elastic: elasticId, quantity: 1e6 }],
    producedElastic: [{ elastic: elasticId, quantity: 0 }],
    pendingElastic: [{ elastic: elasticId, quantity: 1e6 }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: order.customer, status: 'weaving',
    elastics: [{ elastic: elasticId, quantity: 1e6 }],
    producedElastic: [{ elastic: elasticId, quantity: 0 }],
  });
  const machine = await Machine.create({
    ID: 'LOOM-6', manufacturer: 'Comez', NoOfHead: heads, NoOfHooks: 8, status: 'running', orderRunning: job._id,
    elastics: Array.from({ length: heads }, (_, i) => ({ head: i + 1, elastic: elasticId })),
  });
  const sp = await ShiftPlan.create({ date: new Date(), shift: 'DAY', totalProduction: 0 });
  // History, stored as /verify-production stores it: per head × heads.
  for (let i = 0; i < history; i++) {
    await ShiftDetail.create({
      date: new Date(Date.now() - (i + 1) * DAY), shift: 'DAY', status: 'closed', timer: '8:00:00',
      productionMeters: historyPerHead * heads, employee: new mongoose.Types.ObjectId(),
      shiftPlan: sp._id, machine: machine._id,
    });
  }
  const shift = await ShiftDetail.create({
    date: new Date(), shift: 'DAY', status: 'open', employee: new mongoose.Types.ObjectId(),
    shiftPlan: sp._id, machine: machine._id,
  });
  return { machine, shift };
}

/** Verify a shift the way /verify-production does: close it and cascade, in one transaction. */
async function verify({ machine, shift }, perHead, { failAfter = false } = {}) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ShiftDetail.updateOne(
        { _id: shift._id },
        { $set: { status: 'closed', productionMeters: perHead * machine.NoOfHead } },
        { session }
      );
      await cascade(session, { shift, machine: await Machine.findById(machine._id).session(session), productionMeters: perHead });
      if (failAfter) throw new Error('verification failed after the cascade');
    });
  } finally {
    await session.endSession();
  }
}

const eventsSent = () => notify.mock.calls.map((c) => c[0]);

describe('when the alerts are sent', () => {
  it('not during the transaction: queued, then delivered once by the dispatcher', async () => {
    const s = await seed();
    await verify(s, 50); // far below 400 per head
    expect(notify).not.toHaveBeenCalled();
    expect(await Outbox.countDocuments({ kind: 'shift.outputChecks', status: 'pending' })).toBe(1);

    await processDueEvents();
    expect(eventsSent().sort()).toEqual(['anomalyDetected', 'shiftBelowThreshold']);
    const low = notify.mock.calls.find((c) => c[0] === 'shiftBelowThreshold')[1];
    expect(low).toMatchObject({ machineId: 'LOOM-6', produced: 50, baseline: 400 });

    await processDueEvents(); // nothing left to send twice
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('never, for a verification that rolled back', async () => {
    const s = await seed();
    await expect(verify(s, 50, { failAfter: true })).rejects.toThrow(/failed after the cascade/);
    expect(await Outbox.countDocuments({})).toBe(0);
    await processDueEvents();
    expect(notify).not.toHaveBeenCalled();
  });

  it('not for a shift no longer verified by the time it is delivered', async () => {
    const s = await seed();
    await verify(s, 50);
    await ShiftDetail.updateOne({ _id: s.shift._id }, { $set: { status: 'pending_verification' } });
    await processDueEvents();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('what counts as low', () => {
  it('compares per head with per head: an ordinary shift on a six-head loom is not an alert', async () => {
    const s = await seed({ heads: 6, historyPerHead: 400 });
    await verify(s, 390);
    await processDueEvents();
    expect(notify).not.toHaveBeenCalled();
  });
});
