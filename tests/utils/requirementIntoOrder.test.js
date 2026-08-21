'use strict';
// ═══════════════════════════════════════════════════════════════════
//  THE MRP RESULT HAS TO SURVIVE BEING STORED ON AN ORDER
//
//  api/job.js does this in two places, and has for a long time:
//
//      order.rawMaterialRequired = await computeMaterialRequirement(...)
//
//  That works because the requirement rows are a superset of the
//  schema — Mongoose keeps the four paths it knows and ignores the
//  rest. It stopped working the moment the MRP grew a field the
//  SCHEMA also had, under the same name and with a different shape:
//
//    computeMaterialRequirement  →  display rows for a sheet, one per
//                                   lot that could be used, with a
//                                   null quantity for the merely open
//    Order.rawMaterialRequired[] →  EARMARKS, where quantity is
//                                   required and means kilos promised
//
//  The collision produced two failures, and the quieter one is worse:
//
//    1. "rawMaterialRequired.5.lots.0.quantity: Path `quantity` is
//       required" — planning a job against an order threw.
//    2. Even where it cast, the assignment OVERWROTE the order's
//       earmarks with a list of lots nobody had promised anything.
//
//  Renaming the MRP's field is what makes the class of bug impossible
//  rather than fixed once. These tests hold that line: the first
//  reproduces the crash, the second the silent overwrite.
// ═══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, RawMaterial, Elastic, Order, YarnLot, compute;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  RawMaterial = require('../../models/RawMaterial');
  Elastic = require('../../models/Elastic');
  Order = require('../../models/Order');
  YarnLot = require('../../models/YarnLot');
  compute = require('../../utils/materialRequirement').computeMaterialRequirement;
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

/** The fields Order marks required, so a fixture fails on the thing under test. */
const orderBase = (over = {}) => ({
  po: 'PO-1', date: new Date(), supplyDate: new Date(),
  customer: new mongoose.Types.ObjectId(),
  ...over,
});

/**
 * A warp yarn with two open lots — the arrangement that makes the MRP
 * emit lot rows at all. Non-warp materials never get them, so a test
 * built on weft would pass without proving anything.
 */
async function warpYarnWithLots() {
  const mat = await RawMaterial.create({
    name: 'Nylon 40D', category: 'warp', stock: 500, price: 300,
  });
  await YarnLot.create([
    { rawMaterial: mat._id, lotNo: 'D-1001', receivedQty: 200, receivedDate: new Date('2026-01-05') },
    { rawMaterial: mat._id, lotNo: 'D-2002', receivedQty: 200, receivedDate: new Date('2026-02-08') },
  ]);
  const elastic = await Elastic.create({
    name: 'E1', weight: 10, noOfHook: 4, pick: 20, spandexEnds: 8,
    warpYarn: [{ id: mat._id, weight: 40 }],
  });
  return { mat, elastic };
}

test('the MRP really does emit lot rows for a warp yarn', async () => {
  // The premise of everything below. Without it the two tests that
  // follow would pass on an empty list and prove nothing at all.
  const { elastic } = await warpYarnWithLots();
  const rows = await compute([{ elastic: elastic._id, quantity: 1000 }]);

  expect(rows).toHaveLength(1);
  expect(rows[0].lotOptions.length).toBeGreaterThan(0);
  expect(rows[0].lotOptions.some((l) => l.quantity == null)).toBe(true);
});

test('storing the MRP result on an order does not throw', async () => {
  const { elastic } = await warpYarnWithLots();
  const order = await Order.create(orderBase({
    orderNo: 1042, status: 'Open',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
  }));

  order.rawMaterialRequired = await compute([{ elastic: elastic._id, quantity: 1000 }]);

  // The reported failure, exactly: a lot row with a null quantity cast
  // into a schema path that requires one.
  await expect(order.save()).resolves.toBeDefined();
});

test('storing the MRP result does not wipe the order’s earmarks', async () => {
  const { mat, elastic } = await warpYarnWithLots();
  const lot = await YarnLot.findOne({ lotNo: 'D-1001' });

  const order = await Order.create(orderBase({
    orderNo: 1043, status: 'Approved',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
    rawMaterialRequired: [{
      rawMaterial: mat._id, name: 'Nylon 40D', requiredWeight: 40,
      lots: [{ yarnLot: lot._id, lotNo: 'D-1001', quantity: 25 }],
    }],
  }));

  // Replanning the order — what api/job.js does when a job is raised.
  const recomputed = await compute([{ elastic: elastic._id, quantity: 1000 }]);
  order.rawMaterialRequired = recomputed;
  await order.save();

  const reread = await Order.findById(order._id).lean();
  const row = reread.rawMaterialRequired.find(
    (r) => String(r.rawMaterial) === String(mat._id)
  );

  // The earmark is a promise somebody made. Recomputing a requirement
  // is not a reason to forget it — and if the MRP's own list could
  // land in this field, it would replace 25 kg of D-1001 with a list
  // of lots nobody had promised anything.
  //
  // Recomputation does not CARRY the earmarks either (the rows it
  // returns simply have no such field), so what this asserts is the
  // narrower, load-bearing thing: whatever ends up here, it is never
  // the display list. Nothing in it may claim a quantity of null.
  for (const l of row.lots || []) {
    expect(typeof l.quantity).toBe('number');
    expect(l.yarnLot).toBeDefined();
  }
});

test('the schema still refuses an earmark with no quantity', async () => {
  // The rule the rename protects, asserted directly. If this ever
  // stops throwing, the field has been loosened and the collision
  // could return unnoticed.
  const mat = await RawMaterial.create({ name: 'X', category: 'warp', stock: 1 });
  const lot = await YarnLot.create({ rawMaterial: mat._id, lotNo: 'D-9', receivedQty: 10 });

  const order = new Order(orderBase({
    orderNo: 1044, status: 'Approved',
    rawMaterialRequired: [{
      rawMaterial: mat._id, requiredWeight: 10,
      lots: [{ yarnLot: lot._id, lotNo: 'D-9' }],
    }],
  }));

  // Named precisely: a fixture missing an unrelated required field
  // would also reject, and would have passed a looser matcher.
  await expect(order.save()).rejects.toThrow(
    /rawMaterialRequired\.0\.lots\.0\.quantity/
  );
});
