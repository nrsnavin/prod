'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PERMISSION TRAP, THIRD TIME
//
//  Adding a nav item to this system mints a new permission key, and
//  canAccess() reads a user's explicit `features` list BEFORE the admin
//  shortcut. A key that did not exist when that list was saved is
//  therefore missing from it for ever — so a new page ships INVISIBLE
//  to every configured account, the owner's included, with no error to
//  explain the absence.
//
//  20260806000001 documented it. 20260812000001 rescued /quotes from
//  it. The NavItem comment in the web app names /quotes as the warning.
//  /ai-health walked into it anyway, which is the strongest possible
//  argument for this test existing rather than the comment.
//
//  Three properties matter, and the third is the one that makes this
//  safe to run on a live database:
//
//    • an admin with a list gets the key
//    • an account whose department default does not include it does not
//    • an account with NO list is left alone — absent means "defer to
//      the role gate", and writing a list would TIGHTEN access
//
//  Standalone mongod: plain updateOne work, no transactions.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

const migration = require('../../migrations/20260818000001-grant-ai-health-feature');
const { featuresForDepartment } = require('../../utils/features');

let mongo, client, db;

beforeAll(async () => {
  mongo  = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db     = client.db('test');
}, 120_000);

afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => { await db.collection('users').deleteMany({}); });

const seed = (rows) => db.collection('users').insertMany(rows);
const featuresOf = async (email) =>
  (await db.collection('users').findOne({ email })).features;

describe('granting /ai-health to accounts that should already have it', () => {
  test('an admin with an explicit list gets the key', async () => {
    await seed([{
      email: 'owner@t.co', role: 'admin', department: 'admin',
      features: ['/', '/orders', '/users'],
    }]);

    await migration.up(db);

    expect(await featuresOf('owner@t.co')).toContain('/ai-health');
    // Nothing else was touched — an admin who deliberately narrowed
    // their own list keeps that narrowing.
    expect(await featuresOf('owner@t.co')).toEqual(
      expect.arrayContaining(['/', '/orders', '/users'])
    );
  });

  test('a legacy account carrying only a role is mapped to its department', async () => {
    // Accounts created before departments existed have `role` and no
    // `department`. The same mapping the web uses, so both sides agree.
    await seed([{ email: 'legacy@t.co', role: 'admin', features: ['/'] }]);
    await migration.up(db);
    expect(await featuresOf('legacy@t.co')).toContain('/ai-health');
  });

  test('a non-admin does not gain an admin-only key', async () => {
    // The narrow rule: a key is added only where the DEPARTMENT DEFAULT
    // already allows it. Otherwise a migration meant to restore access
    // becomes one that widens it.
    await seed([
      { email: 'fin@t.co',  role: 'accounts',   department: 'finance',    features: ['/', '/orders'] },
      { email: 'prod@t.co', role: 'production', department: 'production', features: ['/', '/jobs'] },
    ]);

    await migration.up(db);

    expect(await featuresOf('fin@t.co')).not.toContain('/ai-health');
    expect(await featuresOf('prod@t.co')).not.toContain('/ai-health');
  });

  test('an account with no list is left alone', async () => {
    // Absent is not the same as empty. No list means "never configured,
    // defer to the role gate"; writing one would replace a broad
    // fallback with a narrow explicit set and LOSE the user access.
    await seed([{ email: 'unset@t.co', role: 'admin', department: 'admin' }]);
    await migration.up(db);

    const u = await db.collection('users').findOne({ email: 'unset@t.co' });
    expect(u.features).toBeUndefined();
  });

  test('an empty list is left alone too — it is a deliberate "nothing"', async () => {
    await seed([{ email: 'none@t.co', role: 'admin', department: 'admin', features: [] }]);
    await migration.up(db);
    expect(await featuresOf('none@t.co')).toEqual([]);
  });

  test('running it twice changes nothing the second time', async () => {
    await seed([{ email: 'owner@t.co', role: 'admin', department: 'admin', features: ['/'] }]);
    await migration.up(db);
    const first = await featuresOf('owner@t.co');
    await migration.up(db);
    expect(await featuresOf('owner@t.co')).toEqual(first);
  });

  test('down removes the key again', async () => {
    await seed([{ email: 'owner@t.co', role: 'admin', department: 'admin', features: ['/'] }]);
    await migration.up(db);
    await migration.down(db);
    expect(await featuresOf('owner@t.co')).not.toContain('/ai-health');
  });
});

// ══════════════════════════════════════════════════════════════════
//  AND THE CATALOG ITSELF
// ══════════════════════════════════════════════════════════════════
describe('the feature catalog', () => {
  test('a NEW admin is created with /ai-health, so this never needs a fourth migration', async () => {
    // The migration rescues accounts that already exist. This is the
    // half that stops the problem recurring: if the key is not in the
    // admin department default, tomorrow's admin is locked out exactly
    // as today's was.
    expect(featuresForDepartment('admin')).toContain('/ai-health');
  });

  test('it is admin-only, matching the server gate on /health/ai', async () => {
    expect(featuresForDepartment('finance')).not.toContain('/ai-health');
    expect(featuresForDepartment('production')).not.toContain('/ai-health');
    expect(featuresForDepartment('packing')).not.toContain('/ai-health');
  });
});
