'use strict';
// ══════════════════════════════════════════════════════════════════
//  MAINTENANCE SCRIPTS THAT FELL BEHIND THE SYSTEM
//
//  These are run by hand, once, on the real database. Each was right
//  when it was written; the system then moved and nobody ran them to
//  find out.
//
//    • reset-to-masters kept the raw materials and erased the GROUPS
//      they are filed under, so every kept material named a group that
//      was gone and the recipe pickers went by a category nobody types.
//    • reset-transactional-data erased the record of which migrations
//      have run. The next `migrate-mongo up` replays all of them —
//      including the ones that rewrite who may open what.
//    • reset-for-production clears a hand-written list from before
//      invoices and the books existed: it would leave every invoice in
//      place and restart their numbering at 1.
//    • migrate-stock-movements, run a second time, set every elastic's
//      "produced" figure back to what it was on the day of the move.
//    • seed-demo-workers wrote four logins with a password printed in
//      the file into whatever database was configured — the live one.
//    • create-admin looked the email up by exact case, and made a second
//      account beside "Owner@…" instead of updating it.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const script = (name) => path.join(__dirname, '..', '..', 'scripts', name);

let mongo, base, uri, db;

function run(name, args = [], env = {}) {
  try {
    const stdout = execFileSync('node', [script(name), ...args], {
      env: { ...process.env, MONGO_URL: uri, MONGO_URI: uri, ...env },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out: stdout };
  } catch (err) {
    if (typeof err.status !== 'number') throw err;
    return { status: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const count = (name, q = {}) => db.collection(name).countDocuments(q);

beforeEach(async () => {
  mongo = await MongoMemoryServer.create();
  base = mongo.getUri();
  uri = `${base}scripts_behind_test`;
  await mongoose.connect(uri);
  db = mongoose.connection.db;
}, 120_000);

afterEach(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('reset-to-masters', () => {
  it('keeps the groups the kept raw materials are filed under', async () => {
    const group = await db.collection('materialgroups').insertOne({ name: 'Warp Polyester' });
    await db.collection('rawmaterials').insertOne({ name: 'Poly 150D', category: 'Warp Polyester', group: group.insertedId, stock: 5 });
    await db.collection('orders').insertOne({ orderNo: 1 });
    await db.collection('users').insertOne({ email: 'o@t.co' });

    const r = run('reset-to-masters.js', ['--yes', '--db', 'scripts_behind_test', '--i-have-a-backup']);
    expect(r.status).toBe(0);
    expect(await count('orders')).toBe(0);
    expect(await count('materialgroups')).toBe(1);
    const mat = await db.collection('rawmaterials').findOne({ name: 'Poly 150D' });
    expect(await count('materialgroups', { _id: mat.group })).toBe(1);
  }, 60_000);
});

describe('reset-transactional-data', () => {
  const seed = async () => {
    await db.collection('changelog').insertMany([{ fileName: '20260711000001-a.js' }, { fileName: '20260805000002-b.js' }]);
    await db.collection('materialgroups').insertOne({ name: 'Rubber' });
    await db.collection('costsettings').insertOne({ key: 'cost', wageMode: 'shift' });
    await db.collection('rawmaterials').insertOne({ name: 'Rubber 40', stock: 5 });
    await db.collection('users').insertOne({ email: 'o@t.co' });
    await db.collection('orders').insertMany([{ orderNo: 1 }, { orderNo: 2 }]);
  };

  it('keeps the record of which migrations have run, the material groups and the cost settings', async () => {
    await seed();
    const r = run('reset-transactional-data.js', ['--yes', '--confirm-db=scripts_behind_test']);
    expect(r.status).toBe(0);
    expect(await count('orders')).toBe(0);
    expect(await count('changelog')).toBe(2);
    expect(await count('materialgroups')).toBe(1);
    expect(await count('costsettings')).toBe(1);
  }, 60_000);

  it('keeps the migration record even when the logins and settings are dropped', async () => {
    await seed();
    const r = run('reset-transactional-data.js', ['--yes', '--confirm-db=scripts_behind_test', '--drop-users']);
    expect(r.status).toBe(0);
    expect(await count('users')).toBe(0);
    expect(await count('changelog')).toBe(2);
  }, 60_000);
});

describe('reset-for-production (the hand-written list)', () => {
  it('refuses, names the two scripts that replaced it, and touches nothing', async () => {
    await db.collection('orders').insertMany([{ orderNo: 1 }, { orderNo: 2 }]);
    await db.collection('invoices').insertOne({ invoiceNo: 'INV-1' });
    await db.collection('counters').insertOne({ _id: 'invoice', seq: 1 });

    for (const args of [[], ['--yes'], ['--yes', '--reset-stock']]) {
      const r = run('reset-for-production.js', args);
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/reset-to-masters\.js/);
      expect(r.out).toMatch(/reset-transactional-data\.js/);
    }
    expect(await count('orders')).toBe(2);
    expect(await count('invoices')).toBe(1);
    expect(await count('counters')).toBe(1);
  }, 60_000);
});

describe('migrate-stock-movements, run again', () => {
  it('does not set "produced" back to the figure from the day of the move', async () => {
    const id = new mongoose.Types.ObjectId();
    await db.collection('elastics').insertOne({
      _id: id, name: '20mm', stock: 100, quantityProduced: 100,
      stockMovements: [{ _id: new mongoose.Types.ObjectId(), date: new Date('2026-05-01'), type: 'PACKING_INWARD', quantity: 100, balance: 100 }],
    });

    const first = run('migrate-stock-movements.js');
    expect(first.status).toBe(0);
    expect(await count('stockmovements', { elastic: id })).toBe(1);
    expect((await db.collection('elastics').findOne({ _id: id })).quantityProduced).toBe(100);

    // Months of packing since, recorded in the ledger only.
    await db.collection('elastics').updateOne({ _id: id }, { $set: { quantityProduced: 2600, stock: 400 } });

    const again = run('migrate-stock-movements.js');
    expect(again.status).toBe(0);
    expect((await db.collection('elastics').findOne({ _id: id })).quantityProduced).toBe(2600);
    expect(await count('stockmovements', { elastic: id })).toBe(1);
  }, 90_000);
});

describe('seed-demo-workers', () => {
  it('refuses a database that looks live, and writes no login there', async () => {
    const live = `${base}erp_production`;
    const r = run('seed-demo-workers.js', [], { MONGO_URL: live });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/looks like a live database/i);
    const there = mongoose.connection.useDb('erp_production', { useCache: true }).db;
    expect(await there.collection('users').countDocuments()).toBe(0);
    expect(await there.collection('employees').countDocuments()).toBe(0);
  }, 60_000);

  it('gives the demo logins a password made for this run, not one printed in the file', async () => {
    const r = run('seed-demo-workers.js');
    expect(r.status).toBe(0);
    expect(await count('users')).toBe(4);
    expect(r.out).not.toMatch(/worker123/);
    const said = /Password:\s+(\S+)/.exec(r.out);
    expect(said).not.toBeNull();
    expect(said[1].length).toBeGreaterThanOrEqual(12);

    // The old one does not open the account.
    const { verifyPassword } = require('../../utils/passwordHash');
    const user = await db.collection('users').findOne({ email: 'warper@demo.local' });
    expect((await verifyPassword('worker123', user.password)).ok).toBe(false);
    expect((await verifyPassword(said[1], user.password)).ok).toBe(true);

    // A second run makes no second set, and claims no password for them.
    const again = run('seed-demo-workers.js');
    expect(again.status).toBe(0);
    expect(await count('users')).toBe(4);
    expect(again.out).not.toMatch(/Password:/);
  }, 90_000);
});

describe('create-admin', () => {
  it('updates the account that is there, whatever case its email was saved in', async () => {
    await db.collection('users').insertOne({ name: 'Owner', email: 'Owner@Balu.in', password: 'x', role: 'accounts', department: 'finance' });

    const refused = run('create-admin.js', ['Owner', 'owner@balu.in', 'a-long-password']);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toMatch(/already exists/);
    expect(await count('users')).toBe(1);

    const r = run('create-admin.js', ['Owner', 'owner@balu.in', 'a-long-password', '--update']);
    expect(r.status).toBe(0);
    expect(await count('users')).toBe(1);
    const user = await db.collection('users').findOne({});
    expect(user.role).toBe('admin');
  }, 90_000);
});
