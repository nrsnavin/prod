'use strict';
// ══════════════════════════════════════════════════════════════════
//  SHIPPING THE DISPATCH QUEUE
//
//  1. /dispatch is a new nav item, so a new permission key: without the
//     grant it is invisible to every configured account. Granted only
//     where the department default includes it; an account with no list
//     is left alone.
//  2. Jobs already in packing never made the move that adds them, so
//     they are put on the queue as they would have been — once.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');

const grant = require('../../migrations/20261021000001-grant-dispatch-feature');
const backfill = require('../../migrations/20261021000002-dispatch-queue-backfill');

let mongo, client, db;

beforeAll(async () => {
  mongo  = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db     = client.db('test');
}, 120_000);

afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => {
  for (const c of ['users', 'joborders', 'customers', 'orders', 'elastics', 'dispatchitems']) {
    await db.collection(c).deleteMany({});
  }
});

const featuresOf = async (email) => (await db.collection('users').findOne({ email })).features;

describe('granting /dispatch', () => {
  test('admin, finance and packing lists get it; production does not; no list stays no list', async () => {
    await db.collection('users').insertMany([
      { email: 'owner@t.co', role: 'admin', department: 'admin', features: ['/', '/orders'] },
      { email: 'fin@t.co', role: 'accounts', department: 'finance', features: ['/', '/delivery-challans'] },
      { email: 'pack@t.co', role: 'production', department: 'packing', features: ['/', '/packing'] },
      { email: 'prod@t.co', role: 'production', department: 'production', features: ['/', '/jobs'] },
      { email: 'legacy@t.co', role: 'admin' },
    ]);
    await grant.up(db);
    expect(await featuresOf('owner@t.co')).toContain('/dispatch');
    expect(await featuresOf('fin@t.co')).toContain('/dispatch');
    expect(await featuresOf('pack@t.co')).toContain('/dispatch');
    expect(await featuresOf('prod@t.co')).not.toContain('/dispatch');
    expect(await featuresOf('legacy@t.co')).toBeUndefined();

    await grant.down(db);
    expect(await featuresOf('owner@t.co')).not.toContain('/dispatch');
  });
});

describe('backfilling jobs already in packing', () => {
  test('each packing job joins once, waiting for an urgency; other stages do not', async () => {
    const customer = new ObjectId(), order = new ObjectId(), elastic = new ObjectId();
    await db.collection('customers').insertOne({ _id: customer, name: 'Fellows Fashion' });
    await db.collection('orders').insertOne({ _id: order, orderNo: 7 });
    await db.collection('elastics').insertOne({ _id: elastic, name: '20mm Knitted' });
    const packedAt = new Date('2026-10-20T06:00:00Z');
    const packing = new ObjectId();
    await db.collection('joborders').insertMany([
      { _id: packing, status: 'packing', jobOrderNo: 3, order, customer, elastics: [{ elastic, quantity: 2000 }], packingAt: packedAt },
      { status: 'weaving', jobOrderNo: 4, order, customer, elastics: [] },
    ]);

    await backfill.up(db);
    await backfill.up(db); // twice: still one

    const items = await db.collection('dispatchitems').find({}).toArray();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      job: packing, ref: 'J-3', customerName: 'Fellows Fashion', orderNo: 7, title: '20mm Knitted',
      quantity: 2000, status: 'awaiting_urgency', urgency: null, readyAt: packedAt,
    });

    await backfill.down(db);
    expect(await db.collection('dispatchitems').countDocuments()).toBe(0);
  });

  test('a job that already has an entry is left alone', async () => {
    const job = new ObjectId();
    await db.collection('joborders').insertOne({ _id: job, status: 'packing', jobOrderNo: 5, elastics: [] });
    await db.collection('dispatchitems').insertOne({ job, status: 'queued', urgency: 'today' });
    await backfill.up(db);
    expect(await db.collection('dispatchitems').findOne({ job })).toMatchObject({ status: 'queued', urgency: 'today' });
    await backfill.down(db); // removes only what it added
    expect(await db.collection('dispatchitems').countDocuments({ job })).toBe(1);
  });
});
