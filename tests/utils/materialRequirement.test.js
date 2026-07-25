'use strict';
// MRP material requirement: every referenced material produces a row with a
// numeric inStock, including when the material document has been deleted
// (previously the whole line vanished, silently under-reporting the need).

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, RawMaterial, Elastic, compute;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  RawMaterial = require('../../models/RawMaterial');
  Elastic     = require('../../models/Elastic');
  compute     = require('../../utils/materialRequirement').computeMaterialRequirement;
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

const makeElastic = (over) => Elastic.create({
  name: 'E1', weight: 10, noOfHook: 4, pick: 20, spandexEnds: 8, ...over,
});

test('a resolved material yields a numeric inStock', async () => {
  const rm = await RawMaterial.create({ name: 'Spandex', category: 'spandex', price: 5, stock: 123.5 });
  const el = await makeElastic({ warpSpandex: { id: rm._id, weight: 2 } });

  const [row] = await compute([{ elastic: el._id, quantity: 1000 }]);
  expect(row.inStock).toBe(123.5);
  expect(row.stockKnown).toBe(true);
  expect(row.requiredWeight).toBe(2);
});

test('zero stock is reported as 0, never as a missing field', async () => {
  const rm = await RawMaterial.create({ name: 'Empty', category: 'yarn', price: 1, stock: 0 });
  const el = await makeElastic({ warpSpandex: { id: rm._id, weight: 2 } });

  const [row] = await compute([{ elastic: el._id, quantity: 1000 }]);
  expect(row.inStock).toBe(0);
  expect(row.inStock).not.toBeNull();
  expect(row.stockKnown).toBe(true);
});

test('a DELETED material still produces a row, flagged as unknown', async () => {
  const rm = await RawMaterial.create({ name: 'Gone', category: 'yarn', price: 1, stock: 50 });
  const el = await makeElastic({ warpSpandex: { id: rm._id, weight: 2 } });
  await RawMaterial.deleteOne({ _id: rm._id });          // reference now dangles

  const rows = await compute([{ elastic: el._id, quantity: 1000 }]);
  expect(rows).toHaveLength(1);                          // was 0 — silently dropped
  expect(rows[0].stockKnown).toBe(false);
  expect(rows[0].inStock).toBe(0);
  expect(rows[0].requiredWeight).toBe(2);
});

test('every row always carries a numeric inStock', async () => {
  const a = await RawMaterial.create({ name: 'A', category: 'yarn', price: 1, stock: 10 });
  const b = await RawMaterial.create({ name: 'B', category: 'yarn', price: 1, stock: 20 });
  const el = await makeElastic({
    warpSpandex: { id: a._id, weight: 1 },
    weftYarn:    { id: b._id, weight: 3 },
  });

  const rows = await compute([{ elastic: el._id, quantity: 1000 }]);
  expect(rows).toHaveLength(2);
  for (const r of rows) expect(typeof r.inStock).toBe('number');
});
