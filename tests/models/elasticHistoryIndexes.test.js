'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE INDEXES BEHIND THE NEW LISTS
//
//  Order.js already carries the note: this collection once had no
//  indexes, so every list was a full scan followed by an in-memory
//  sort — and the sort is what bites, because Mongo caps it at 32 MB
//  and then ERRORS ("Sort exceeded memory limit") rather than getting
//  slower. The screen simply stops working once the collection
//  outgrows the ceiling.
//
//  The elastic history lists reintroduced exactly that shape: filter
//  on an un-indexed array field, sort by date. They are also the
//  screens built for a product with hundreds of orders behind it, so
//  they would meet the ceiling first.
//
//  Asserted with explain() against a real planner rather than by
//  reading the schema, because "an index exists" and "the query uses
//  it" are different claims — and for a MULTIKEY index serving a sort,
//  the second one is genuinely not obvious.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Order, JobOrder, WarpingPlan, Elastic;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongo.getUri());
  Order       = require('../../models/Order');
  JobOrder    = require('../../models/JobOrder');
  WarpingPlan = require('../../models/WarpingPlan');
  Elastic     = require('../../models/Elastic');
  // Indexes are declared on the schema; building them is what makes
  // them real, and nothing else in this file would trigger it.
  await Promise.all([
    Order.init(), JobOrder.init(), WarpingPlan.init(), Elastic.init(),
  ]);
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

/** Every stage name in a winning plan, outermost first. */
const stages = (plan) => {
  const names = [];
  for (let s = plan; s; s = s.inputStage) names.push(s.stage);
  return names;
};

describe('the orders-for-an-elastic list', () => {
  it('is served by an index, not a collection scan', async () => {
    const elastic = new mongoose.Types.ObjectId();
    const explain = await Order.find({
      'elasticOrdered.elastic': elastic,
      status: { $ne: 'Deleted' },
    })
      .sort({ date: -1, _id: -1 })
      .limit(10)
      .explain('queryPlanner');

    const winning = stages(explain.queryPlanner.winningPlan);
    expect(winning).toContain('IXSCAN');
    expect(winning).not.toContain('COLLSCAN');
  });

  it('does not sort the matches in memory', async () => {
    // The whole point. A SORT stage here is the 32 MB ceiling waiting
    // to be reached, and it errors rather than degrading.
    const explain = await Order.find({ 'elasticOrdered.elastic': new mongoose.Types.ObjectId() })
      .sort({ date: -1 })
      .limit(10)
      .explain('queryPlanner');

    expect(stages(explain.queryPlanner.winningPlan)).not.toContain('SORT');
  });

  it('indexes an order once per product on it', async () => {
    // Multikey: one order carrying three elastics has to be findable
    // by all three, not just the first.
    const [a, b, c] = [1, 2, 3].map(() => new mongoose.Types.ObjectId());
    await Order.create({
      orderNo: 90001, customer: new mongoose.Types.ObjectId(), status: 'Approved',
      po: 'PO-1', date: new Date(), supplyDate: new Date(),
      elasticOrdered: [
        { elastic: a, quantity: 10 }, { elastic: b, quantity: 20 }, { elastic: c, quantity: 30 },
      ],
    });

    for (const id of [a, b, c]) {
      const found = await Order.find({ 'elasticOrdered.elastic': id }).lean();
      expect({ id: String(id), n: found.length }).toEqual({ id: String(id), n: 1 });
    }
  });
});

describe('the jobs-for-an-elastic list', () => {
  it('is served by an index, not a collection scan', async () => {
    const explain = await JobOrder.find({
      'elastics.elastic': new mongoose.Types.ObjectId(),
      status: { $ne: 'cancelled' },
    })
      .sort({ date: -1, _id: -1 })
      .limit(10)
      .explain('queryPlanner');

    const winning = stages(explain.queryPlanner.winningPlan);
    expect(winning).toContain('IXSCAN');
    expect(winning).not.toContain('COLLSCAN');
  });

  it('does not sort the matches in memory', async () => {
    const explain = await JobOrder.find({ 'elastics.elastic': new mongoose.Types.ObjectId() })
      .sort({ date: -1 })
      .limit(10)
      .explain('queryPlanner');

    expect(stages(explain.queryPlanner.winningPlan)).not.toContain('SORT');
  });
});

describe('the lot trail reading plans by job', () => {
  it('is served by an index', async () => {
    // services/yarnLotTrail.js runs this on the job detail, on every
    // job of an order, and on the warping screen. `warping` was indexed
    // because it is unique; `job` was not indexed at all.
    const explain = await WarpingPlan.find({
      job: { $in: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()] },
    }).explain('queryPlanner');

    const winning = stages(explain.queryPlanner.winningPlan);
    expect(winning).toContain('IXSCAN');
    expect(winning).not.toContain('COLLSCAN');
  });
});
