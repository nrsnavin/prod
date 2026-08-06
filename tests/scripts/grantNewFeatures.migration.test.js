'use strict';
// ══════════════════════════════════════════════════════════════════
//  MIGRATION — granting features that shipped after the backfill
//
//  The gates honour an explicit feature list exactly, so a key that did
//  not exist when the list was saved is missing from it forever: adding
//  a feature ships it INVISIBLE to every existing account, the owner's
//  included. This migration closes that, and the thing it must not do
//  while closing it is widen anybody beyond their department's default
//  or quietly undo a narrowing an admin made on purpose.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const migration = require('../../migrations/20260806000001-grant-features-added-after-backfill');

let mongo, db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await db.collection('users').deleteMany({});
});

const featuresOf = async (email) =>
  (await db.collection('users').findOne({ email })).features;

const seed = (docs) => db.collection('users').insertMany(docs);

describe('granting the new keys', () => {
  it('gives an admin both, since the admin default is everything', async () => {
    await seed([{ email: 'owner@t.co', role: 'admin', department: 'admin', features: ['/orders', '/jobs'] }]);
    await migration.up(db);
    const f = await featuresOf('owner@t.co');
    expect(f).toContain('/order-pnl');
    expect(f).toContain('/samples');
    // And keeps what it had.
    expect(f).toEqual(expect.arrayContaining(['/orders', '/jobs']));
  });

  it('gives finance both, and production only the one its department has', async () => {
    await seed([
      { email: 'fin@t.co', role: 'accounts', department: 'finance', features: ['/orders'] },
      { email: 'prod@t.co', role: 'production', department: 'production', features: ['/jobs'] },
    ]);
    await migration.up(db);

    expect(await featuresOf('fin@t.co')).toEqual(
      expect.arrayContaining(['/orders', '/order-pnl', '/samples'])
    );
    // /order-pnl is admin + finance only — production must not gain it.
    const prod = await featuresOf('prod@t.co');
    expect(prod).toContain('/samples');
    expect(prod).not.toContain('/order-pnl');
  });

  it('gives packing neither — its department default has no claim on either', async () => {
    await seed([{ email: 'pack@t.co', role: 'production', department: 'packing', features: ['/packing'] }]);
    await migration.up(db);
    expect(await featuresOf('pack@t.co')).toEqual(['/packing']);
  });

  // "Never configured" defers to the role gate. Writing a list to such an
  // account would TIGHTEN it — the opposite of the point.
  it('leaves an account with no feature list alone', async () => {
    await seed([{ email: 'legacy@t.co', role: 'admin', department: 'admin' }]);
    await migration.up(db);
    const u = await db.collection('users').findOne({ email: 'legacy@t.co' });
    expect(u.features).toBeUndefined();
  });

  it('leaves an explicitly-empty list empty — that is a deliberate "nothing"', async () => {
    await seed([{ email: 'none@t.co', role: 'accounts', department: 'finance', features: [] }]);
    await migration.up(db);
    expect(await featuresOf('none@t.co')).toEqual([]);
  });

  it('falls back to the role when the account predates departments', async () => {
    await seed([{ email: 'old@t.co', role: 'accounts', features: ['/orders'] }]);
    await migration.up(db);
    expect(await featuresOf('old@t.co')).toEqual(
      expect.arrayContaining(['/order-pnl', '/samples'])
    );
  });

  it('is safe to run twice — no duplicate keys', async () => {
    await seed([{ email: 'owner@t.co', role: 'admin', department: 'admin', features: ['/orders'] }]);
    await migration.up(db);
    await migration.up(db);
    const f = await featuresOf('owner@t.co');
    expect(f.filter((k) => k === '/samples')).toHaveLength(1);
  });

  it('rolls back by removing only the two keys', async () => {
    await seed([{ email: 'fin@t.co', role: 'accounts', department: 'finance', features: ['/orders'] }]);
    await migration.up(db);
    await migration.down(db);
    expect(await featuresOf('fin@t.co')).toEqual(['/orders']);
  });
});
