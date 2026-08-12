'use strict';
// ══════════════════════════════════════════════════════════════════
//  MOVING OLD QUOTATIONS ONTO lines[]
//
//  A quote left in the single-product shape reads as a quote with NO
//  products once the code expects lines: empty table, no PDF rows, zero
//  totals. A document that silently loses its contents is worse than one
//  that fails loudly, so this is checked rather than assumed.
//
//  The costing is MOVED, not recomputed. These prices were sent to
//  customers at the yarn costs of the day.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const migration = require('../../migrations/20260812000002-quote-lines');

let mongo, db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await db.collection('quotes').deleteMany({}); });

const oldShape = (over = {}) => ({
  quoteNo: 'QT-25/26-0001', financialYear: '25/26', sequence: 1,
  date: new Date(), validTill: new Date(), customerName: 'Ravi Textiles',
  productName: '20mm Woven Elastic', productSpec: 'Width 20mm',
  materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240, cost: 1.008 }],
  conversionCost: 1.25, marginPercent: 20, quantityMetres: 5000,
  totalWeightGrams: 4.2, materialCost: 1.008, totalCost: 2.258,
  marginAmount: 0.45, rateBeforeTax: 2.71, gstPercent: 5,
  gstAmount: 0.14, rateInclTax: 2.85,
  valueBeforeTax: 13550, valueInclTax: 14250,
  ...over,
});

const one = () => db.collection('quotes').findOne({});

describe('an old single-product quotation', () => {
  it('becomes a quote with one line', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    const q = await one();
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0].productName).toBe('20mm Woven Elastic');
  });

  it('keeps the price the customer was actually given', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    const q = await one();
    expect(q.lines[0].rateBeforeTax).toBe(2.71);
    expect(q.lines[0].materials[0].cost).toBe(1.008);
  });

  it('carries its value up to the document totals', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    const q = await one();
    expect(q.subTotal).toBe(13550);
    expect(q.grandTotal).toBe(14250);
    expect(q.gstAmount).toBe(700);
    expect(q.totalQuantityMetres).toBe(5000);
  });

  it('leaves the totals agreeing with each other', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    const q = await one();
    expect(q.grandTotal).toBe(q.subTotal + q.gstAmount);
  });

  it('clears the old top-level fields', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    const q = await one();
    expect(q.productName).toBeUndefined();
    expect(q.materials).toBeUndefined();
    expect(q.rateBeforeTax).toBeUndefined();
  });

  it('leaves the quote number, customer and status alone', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    const q = await one();
    expect(q.quoteNo).toBe('QT-25/26-0001');
    expect(q.customerName).toBe('Ravi Textiles');
  });
});

describe('what it must not touch', () => {
  it('skips a quote already on the new shape', async () => {
    await db.collection('quotes').insertOne({
      quoteNo: 'QT-25/26-0002', financialYear: '25/26', sequence: 2,
      date: new Date(), validTill: new Date(), customerName: 'X',
      lines: [{ productName: 'Already migrated', rateBeforeTax: 9.99 }],
      subTotal: 100, grandTotal: 105,
    });
    await migration.up(db);
    const q = await one();
    expect(q.lines).toHaveLength(1);
    expect(q.lines[0].rateBeforeTax).toBe(9.99);
    expect(q.subTotal).toBe(100);
  });

  it('adds nothing on a second run', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    await migration.up(db);
    expect((await one()).lines).toHaveLength(1);
  });
});

describe('rolling back', () => {
  it('folds the line back to the top level', async () => {
    await db.collection('quotes').insertOne(oldShape());
    await migration.up(db);
    await migration.down(db);
    const q = await one();
    expect(q.productName).toBe('20mm Woven Elastic');
    expect(q.rateBeforeTax).toBe(2.71);
    expect(q.lines).toBeUndefined();
  });
});
