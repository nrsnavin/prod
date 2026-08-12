'use strict';
// ══════════════════════════════════════════════════════════════════
//  GRANTING /quotes TO ACCOUNTS THAT ALREADY EXIST
//
//  The gates read User.features as the whole truth, and canAccess()
//  checks it BEFORE the admin shortcut. So a feature key that did not
//  exist when an account's list was saved is missing from it forever —
//  which means shipping a new screen ships it INVISIBLE, sidebar entry
//  and route both, with no error to explain why.
//
//  That happened to /order-pnl and /samples, was documented in
//  20260806000001, and then happened again to /quotes.
//
//  These pin what the repair may and may not do:
//    • an account whose department default includes it, gets it
//    • an account outside that department does NOT
//    • an account with no list at all is left alone — absent means
//      "defer to the role gate", and writing a list would TIGHTEN access
//    • other features are never disturbed
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const migration = require('../../migrations/20260812000001-grant-quotes-feature');

let mongo, db;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await db.collection('users').deleteMany({}); });

const seed = (docs) => db.collection('users').insertMany(docs);
const featuresOf = async (email) =>
  (await db.collection('users').findOne({ email }))?.features;

describe('the repair', () => {
  it('grants it to an admin whose list predates the feature', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/orders', '/materials'] }]);
    await migration.up(db);
    expect(await featuresOf('a@t.co')).toContain('/quotes');
  });

  it('grants it to finance, who raise the quotes', async () => {
    await seed([{ email: 'f@t.co', department: 'finance', features: ['/orders'] }]);
    await migration.up(db);
    expect(await featuresOf('f@t.co')).toContain('/quotes');
  });

  it('leaves every other feature exactly as it was', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/orders', '/materials'] }]);
    await migration.up(db);
    const after = await featuresOf('a@t.co');
    expect(after).toEqual(expect.arrayContaining(['/orders', '/materials']));
    expect(after).toHaveLength(3);
  });

  it('maps a pre-departments account by its role', async () => {
    // Older accounts carry only `role`, and "accounts" is the finance
    // department under another name.
    await seed([{ email: 'r@t.co', role: 'accounts', features: ['/orders'] }]);
    await migration.up(db);
    expect(await featuresOf('r@t.co')).toContain('/quotes');
  });
});

describe('what the repair must not do', () => {
  it('does not hand it to production — it shows cost and margin', async () => {
    await seed([{ email: 'p@t.co', department: 'production', features: ['/jobs'] }]);
    await migration.up(db);
    expect(await featuresOf('p@t.co')).not.toContain('/quotes');
  });

  it('does not hand it to packing', async () => {
    await seed([{ email: 'k@t.co', department: 'packing', features: ['/packing'] }]);
    await migration.up(db);
    expect(await featuresOf('k@t.co')).not.toContain('/quotes');
  });

  it('leaves an account with NO list untouched', async () => {
    // Absent means "never configured, defer to the role gate". Writing a
    // list here would narrow the account to just this one key.
    await seed([{ email: 'n@t.co', department: 'admin' }]);
    await migration.up(db);
    expect(await featuresOf('n@t.co')).toBeUndefined();
  });

  it('leaves an account with an EMPTY list untouched', async () => {
    await seed([{ email: 'e@t.co', department: 'admin', features: [] }]);
    await migration.up(db);
    expect(await featuresOf('e@t.co')).toEqual([]);
  });

  it('adds nothing twice when run again', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/orders'] }]);
    await migration.up(db);
    await migration.up(db);
    const after = await featuresOf('a@t.co');
    expect(after.filter((f) => f === '/quotes')).toHaveLength(1);
  });
});

describe('rolling back', () => {
  it('takes the key away again', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/orders'] }]);
    await migration.up(db);
    await migration.down(db);
    expect(await featuresOf('a@t.co')).not.toContain('/quotes');
    expect(await featuresOf('a@t.co')).toContain('/orders');
  });
});
