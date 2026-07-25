'use strict';
// Document-number allocation must survive alongside mongoose-sequence.
//
// Regression: our counters used to share the "counters" collection with
// mongoose-sequence (Order.orderNo), whose UNIQUE index on
// { id, reference_value } rejected every row after the first — our rows
// have neither field, so they all indexed as (null, null). The duplicate
// error was swallowed and the follow-up $inc returned null, surfacing as
// "Cannot read properties of null (reading 'seq')" when creating a DC.

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Counter, nextNumber;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  require('../../models/Order.js');            // registers mongoose-sequence
  Counter    = require('../../models/Counter.js');
  nextNumber = require('../../utils/sequence.js').nextNumber;
  // Recreate the plugin's index exactly as it builds it.
  await mongoose.connection.db.collection('counters')
    .createIndex({ id: 1, reference_value: 1 }, { unique: true });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await Counter.deleteMany({}); });

test('our counters live outside the plugin-owned "counters" collection', () => {
  expect(Counter.collection.name).toBe('doc_counters');
});

test('several distinct counters can be allocated (the DC-after-PO case)', async () => {
  expect(await nextNumber('poNo', async () => 0)).toBe(1);
  expect(await nextNumber('dc:elastic:25/26', async () => 0)).toBe(1);
  expect(await nextNumber('dc:material:25/26', async () => 0)).toBe(1);
  expect(await nextNumber('poNo', async () => 0)).toBe(2);
});

test('seeds from existing data on first use', async () => {
  expect(await nextNumber('dc:elastic:26/27', async () => 41)).toBe(42);
});

test('hands out distinct numbers under concurrency', async () => {
  const got = await Promise.all(
    Array.from({ length: 8 }, () => nextNumber('race', async () => 0))
  );
  expect(new Set(got).size).toBe(8);
});

test('a missing counter row is recreated rather than throwing on null', async () => {
  await nextNumber('gap', async () => 5);
  await Counter.deleteMany({ _id: 'gap' });          // row vanishes
  await expect(nextNumber('gap', async () => 9)).resolves.toBe(10);
});
