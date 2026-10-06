'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE JOB, ONE NUMBER; ONE STOCK COUNT, ONE NUMBER
//
//  The numbers come from an atomic counter, so duplicates should never be
//  minted. The unique indexes are the backstop that makes the database
//  refuse one if anything ever does (a data import, a hand edit, a bug).
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, JobOrder, StockCount;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  JobOrder = require('../../models/JobOrder');
  StockCount = require('../../models/StockCount');
  await Promise.all([JobOrder.init(), StockCount.init()]);
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

it('refuses a second job with the same number', async () => {
  const doc = { date: new Date(), order: new mongoose.Types.ObjectId(), customer: new mongoose.Types.ObjectId(), status: 'preparatory', elastics: [] };
  const a = await JobOrder.create(doc);
  await expect(JobOrder.collection.insertOne({ ...doc, jobOrderNo: a.jobOrderNo })).rejects.toMatchObject({ code: 11000 });
  // Distinct numbers from the counter, as ever.
  const b = await JobOrder.create(doc);
  expect(b.jobOrderNo).not.toBe(a.jobOrderNo);
});

it('refuses a second stock count with the same number', async () => {
  const a = await StockCount.collection.insertOne({ countNo: 9001, status: 'open' });
  expect(a.acknowledged).toBe(true);
  await expect(StockCount.collection.insertOne({ countNo: 9001, status: 'open' })).rejects.toMatchObject({ code: 11000 });
});
