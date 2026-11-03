'use strict';
// Invoices and Accounts shipped without a grant migration and were
// invisible to every account with an explicit feature list, the owner's
// included. The repair adds them where the department default allows,
// and nowhere else.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const migration = require('../../migrations/20261103000001-grant-invoices-accounts-features');

let mongo, db;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await db.collection('users').deleteMany({}); });

const seed = (docs) => db.collection('users').insertMany(docs);
const featuresOf = async (email) => (await db.collection('users').findOne({ email }))?.features;

describe('granting Invoices and Accounts', () => {
  it('gives the owner (admin) both, and keeps everything else', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/', '/orders', '/customers'] }]);
    await migration.up(db);
    const f = await featuresOf('a@t.co');
    expect(f).toEqual(expect.arrayContaining(['/', '/orders', '/customers', '/invoices', '/accounts', '/claims']));
    expect(f).toHaveLength(6);
  });

  it('gives finance both, including a pre-departments "accounts" role', async () => {
    await seed([
      { email: 'f@t.co', department: 'finance', features: ['/orders'] },
      { email: 'r@t.co', role: 'accounts', features: ['/orders'] },
    ]);
    await migration.up(db);
    for (const e of ['f@t.co', 'r@t.co']) expect(await featuresOf(e)).toEqual(expect.arrayContaining(['/invoices', '/accounts']));
  });

  it('does not give the shop floor the books, only expense claims', async () => {
    await seed([{ email: 'p@t.co', department: 'production', features: ['/jobs'] }]);
    await migration.up(db);
    const f = await featuresOf('p@t.co');
    expect(f).not.toContain('/invoices');
    expect(f).not.toContain('/accounts');
    expect(f).toContain('/claims');
  });

  it('leaves an account with no list alone, and runs twice harmlessly', async () => {
    await seed([{ email: 'n@t.co', department: 'admin' }, { email: 'a@t.co', department: 'admin', features: ['/'] }]);
    await migration.up(db);
    await migration.up(db);
    expect(await featuresOf('n@t.co')).toBeUndefined();
    expect((await featuresOf('a@t.co')).filter((k) => k === '/accounts')).toHaveLength(1);
  });

  it('down takes the keys back out', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/', '/accounts', '/invoices'] }]);
    await migration.down(db);
    expect(await featuresOf('a@t.co')).toEqual(['/']);
  });
});
