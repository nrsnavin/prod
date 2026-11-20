'use strict';
// ══════════════════════════════════════════════════════════════════
//  "IS THIS IN USE?" LOOKS WHERE THE RECORDS REALLY ARE
//
//  Before a material or an elastic is deleted, utils/masterUsage.js
//  counts every record that names it — from a table of model names and
//  field paths written by hand. Three entries had come adrift of the
//  models:
//
//    • a material in a warping batch was looked for at
//      `WarpingBatch.rawMaterial`; it is under `allocations.rawMaterial`
//    • an elastic on a shift was looked for at `ShiftDetail.elastic`;
//      it is under `elastics.elastic`
//    • a customer's complaints were looked for in a model called
//      "Complaints"; the model is "Complaint"
//
//  A path that is not there matches nothing, so each said "not used" —
//  and "not used" is what allows the delete.
//
//  This holds every entry to the models, so the next one cannot drift.
//  Found reading utils/masterUsage.js line by line.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const MODELS = path.join(__dirname, '../../models');
for (const f of fs.readdirSync(MODELS)) if (/\.(c?js)$/.test(f)) require(path.join(MODELS, f));
const { REFERENCES, countUsage } = require('../../utils/masterUsage');

describe('every place a master is looked for', () => {
  for (const [kind, refs] of Object.entries(REFERENCES)) {
    for (const ref of refs) {
      it(`${kind}: ${ref.model}.${ref.path} is a field of a model that exists`, () => {
        expect(mongoose.modelNames()).toContain(ref.model);
        expect(mongoose.model(ref.model).schema.path(ref.path)).toBeTruthy();
      });
    }
  }
});

describe('how the count is worded', () => {
  it('says "entries" and "batches", not "entrys" and "batchs"', () => {
    const { phrase } = require('../../utils/masterUsage');
    expect(phrase('packing entry', 3)).toBe('3 packing entries');
    expect(phrase('warping batch', 2)).toBe('2 warping batches');
    expect(phrase('order', 2)).toBe('2 orders');
    expect(phrase('QC record', 1)).toBe('1 QC record');
    // Every label in the table reads as a word in the plural.
    for (const refs of Object.values(REFERENCES)) for (const { label } of refs) expect(phrase(label, 2)).not.toMatch(/(ys|chs|shs)$/);
  });
});

describe('counting where it is used', () => {
  let mongo;
  beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 120_000);
  afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

  it('finds a material whose only use is a warping batch, or a supplier\'s quoted rate', async () => {
    const yarn = new mongoose.Types.ObjectId();
    const quoted = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('warpingbatches').insertOne({ batchNo: 1, allocations: [{ rawMaterial: yarn, yarnLot: new mongoose.Types.ObjectId(), quantity: 12 }] });
    await mongoose.connection.collection('supplierrates').insertOne({ supplier: new mongoose.Types.ObjectId(), rawMaterial: quoted, rate: 210, live: true });
    expect(await countUsage('RawMaterial', yarn)).toMatchObject({ used: true, summary: '1 warping batch' });
    expect(await countUsage('RawMaterial', quoted)).toMatchObject({ used: true, summary: '1 supplier rate' });
    expect(await countUsage('RawMaterial', new mongoose.Types.ObjectId())).toMatchObject({ used: false, total: 0 });
  });

  it('finds an elastic whose only use is a shift, and a customer whose only record is a complaint', async () => {
    const elastic = new mongoose.Types.ObjectId();
    const customer = new mongoose.Types.ObjectId();
    await mongoose.connection.collection('shiftdetails').insertOne({ date: new Date('2026-11-19T00:00:00Z'), shift: 'DAY', elastics: [{ head: 1, elastic }] });
    await mongoose.connection.collection('complaints').insertOne({ customer, description: 'Width varies' });
    expect(await countUsage('Elastic', elastic)).toMatchObject({ used: true, summary: '1 shift entry' });
    expect(await countUsage('Customer', customer)).toMatchObject({ used: true, summary: '1 complaint' });
  });
});
