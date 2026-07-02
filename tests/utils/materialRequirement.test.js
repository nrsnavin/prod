'use strict';
//
// Unit test for the BOM roll-up against an in-memory Mongo, mirroring
// the pattern used by the inventory-alert tests. Verifies the same
// weight math the order-approval flow uses, plus shortfall.

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Elastic, RawMaterial, computeMaterialRequirement;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Elastic     = require('../../models/Elastic.js');
  RawMaterial = require('../../models/RawMaterial.js');
  ({ computeMaterialRequirement } = require('../../utils/materialRequirement.js'));
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

async function mat(name, over = {}) {
  return RawMaterial.create({
    name, category: 'Yarn',
    supplier: new mongoose.Types.ObjectId(),
    stock: 0, minStock: 0, price: 0, ...over,
  });
}

describe('computeMaterialRequirement', () => {
  test('rolls up grams/metre × metres ÷ 1000 into kg, per material', async () => {
    const spandex = await mat('Spandex 40D', { stock: 100 });
    const nylon   = await mat('Nylon 70D',   { stock: 10 });

    const elastic = await Elastic.create({
      name: '20mm knit', weaveType: '8',
      spandexEnds: 40, pick: 20, noOfHook: 4, weight: 5,
      testingParameters: { elongation: 120, recovery: 90 },
      warpSpandex:    { id: spandex._id, ends: 40, weight: 2 }, // 2 g/m
      weftYarn:       { id: nylon._id,   weight: 5 },           // 5 g/m
    });

    const out = await computeMaterialRequirement([
      { elastic: elastic._id, quantity: 12000 }, // 12,000 m
    ]);

    const byName = Object.fromEntries(out.map((m) => [m.name, m]));
    // Spandex: 2 g/m × 12000 / 1000 = 24 kg; stock 100 → no shortfall
    expect(byName['Spandex 40D'].requiredWeight).toBeCloseTo(24, 3);
    expect(byName['Spandex 40D'].shortfall).toBe(0);
    // Nylon: 5 g/m × 12000 / 1000 = 60 kg; stock 10 → 50 kg short
    expect(byName['Nylon 70D'].requiredWeight).toBeCloseTo(60, 3);
    expect(byName['Nylon 70D'].shortfall).toBeCloseTo(50, 3);
  });

  test('sums the same material used across multiple elastics', async () => {
    const shared = await mat('Shared Yarn', { stock: 5 });
    const e1 = await Elastic.create({
      name: 'A', weaveType: '8', spandexEnds: 1, pick: 1, noOfHook: 1, weight: 1,
      testingParameters: { elongation: 120, recovery: 90 },
      weftYarn: { id: shared._id, weight: 1 },
    });
    const e2 = await Elastic.create({
      name: 'B', weaveType: '8', spandexEnds: 1, pick: 1, noOfHook: 1, weight: 1,
      testingParameters: { elongation: 120, recovery: 90 },
      weftYarn: { id: shared._id, weight: 3 },
    });
    const out = await computeMaterialRequirement([
      { elastic: e1._id, quantity: 1000 }, // 1 kg
      { elastic: e2._id, quantity: 1000 }, // 3 kg
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].requiredWeight).toBeCloseTo(4, 3);
  });

  test('warpYarn array entries each contribute', async () => {
    const y1 = await mat('Warp A');
    const y2 = await mat('Warp B');
    const e = await Elastic.create({
      name: 'multi-warp', weaveType: '8', spandexEnds: 1, pick: 1, noOfHook: 1, weight: 1,
      testingParameters: { elongation: 120, recovery: 90 },
      warpYarn: [{ id: y1._id, weight: 2 }, { id: y2._id, weight: 4 }],
    });
    const out = await computeMaterialRequirement([{ elastic: e._id, quantity: 1000 }]);
    const byName = Object.fromEntries(out.map((m) => [m.name, m.requiredWeight]));
    expect(byName['Warp A']).toBeCloseTo(2, 3);
    expect(byName['Warp B']).toBeCloseTo(4, 3);
  });

  test('empty / zero-qty lines yield no requirement', async () => {
    expect(await computeMaterialRequirement([])).toEqual([]);
    const e = await Elastic.create({
      name: 'z', weaveType: '8', spandexEnds: 1, pick: 1, noOfHook: 1, weight: 1,
      testingParameters: { elongation: 120, recovery: 90 },
      weftYarn: { id: (await mat('Y'))._id, weight: 5 },
    });
    expect(await computeMaterialRequirement([{ elastic: e._id, quantity: 0 }])).toEqual([]);
  });
});
