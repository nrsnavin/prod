'use strict';
// ══════════════════════════════════════════════════════════════════
//  RESET TO MASTERS
//
//  A script that erases a production database deserves more scepticism
//  than most code: it is run once, under pressure, and its mistakes are
//  not recoverable. So it is driven here against a real database, seeded
//  on both sides of the line, rather than reasoned about.
//
//  Both opposite questions get asked — does it erase everything it
//  should, and does it leave everything it should alone — plus the two
//  that only matter for a destructive tool: does it refuse to run by
//  accident, and does it erase a collection NOBODY LISTED, which is how
//  a wipe-list script quietly goes stale.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'reset-to-masters.js');

let mongo, uri, db, dbName;

function run(args = []) {
  return execFileSync('node', [SCRIPT, ...args], {
    env: { ...process.env, MONGO_URL: uri },
    encoding: 'utf8',
  });
}

/** Same call, for the paths that are expected to exit non-zero. */
function runExpectingFailure(args = []) {
  try {
    run(args);
    throw new Error('expected the script to refuse, but it succeeded');
  } catch (err) {
    if (!err.status) throw err;
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
}

const KEPT = ['rawmaterials', 'elastics', 'suppliers', 'customers', 'elasticgroups'];

// Named in the request, plus the four a hand-maintained wipe-list missed.
const ERASED = [
  'stockmovements', 'purchaseorders', 'employees', 'materialinwards', 'materialoutwards',
  'orders', 'joborders', 'deliverychallans', 'packings', 'wastages',
  'shiftplans', 'shiftdetails', 'attendances', 'payrolls', 'machines',
  'samplerequests', 'samplephotos', 'yarnlots', 'warpingbatches', 'machineservicebills',
  'doc_counters', 'counters',
];

async function seed() {
  for (const name of [...KEPT, ...ERASED]) {
    await db.collection(name).insertMany([{ seeded: 1 }, { seeded: 2 }]);
  }
  await db.collection('users').insertOne({ email: 'owner@t.co' });
  await db.collection('changelog').insertOne({ fileName: 'x.js' });
  await db.collection('documentsettings').insertOne({ letterhead: 'x' });
  await db.collection('costings').insertOne({ elastic: 'e1' });

  // The masters carry the embedded half of the stock ledger, plus
  // counters derived from transactions that are about to disappear.
  await db.collection('elastics').insertOne({
    name: '20mm', stock: 500, quantityProduced: 900, reservedStock: 40,
    stockMovements: [{ qty: 5 }, { qty: -2 }],
  });
  await db.collection('rawmaterials').insertOne({
    name: 'Nylon 70D', stock: 300, stockMovements: [{ qty: 10 }],
  });
}

const count = (name) => db.collection(name).countDocuments();

beforeEach(async () => {
  mongo = await MongoMemoryServer.create();
  uri = `${mongo.getUri()}jarvis-reset-test`;
  await mongoose.connect(uri);
  db = mongoose.connection.db;
  dbName = mongoose.connection.name;
  await seed();
}, 120_000);

afterEach(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('refusing to run by accident', () => {
  it('changes nothing without --yes', async () => {
    const out = run();
    expect(out).toMatch(/DRY RUN/);
    expect(out).toMatch(/Nothing was changed/);
    for (const name of ERASED) expect(await count(name)).toBe(2);
  }, 60_000);

  // The connection string lives in an env file you cannot see from the
  // command line, so "which database am I about to empty" is a real
  // question — the script makes you answer it.
  it('refuses --yes unless the database is named, and names it for you', async () => {
    const out = runExpectingFailure(['--yes']);
    expect(out).toMatch(/Refusing to erase/);
    expect(out).toContain(`--db ${dbName}`);
    expect(await count('orders')).toBe(2);
  }, 60_000);

  it('refuses a database name that does not match', async () => {
    runExpectingFailure(['--yes', '--db', 'some-other-db']);
    expect(await count('orders')).toBe(2);
  }, 60_000);

  it('refuses to erase the logins that are the way back in', async () => {
    const out = runExpectingFailure(['--yes', '--db', dbName, '--wipe', 'users']);
    expect(out).toMatch(/locks you out|Refusing to erase "users"/);
    expect(await count('users')).toBe(1);
  }, 60_000);
});

describe('what it erases', () => {
  it('empties everything that is not a master', async () => {
    run(['--yes', '--db', dbName]);
    for (const name of ERASED) expect(await count(name)).toBe(0);
  }, 60_000);

  // The whole reason for a keep-list. A wipe-list names what to erase, so
  // a collection added after it was written survives — silently, into a
  // supposedly fresh production ledger.
  it('erases a collection nobody ever listed', async () => {
    await db.collection('somethingaddedlater').insertMany([{ a: 1 }, { a: 2 }]);
    const out = run(['--yes', '--db', dbName]);
    expect(await count('somethingaddedlater')).toBe(0);
    expect(out).toMatch(/somethingaddedlater/);
  }, 60_000);

  it('says out loud what it erased that the request never named', async () => {
    const out = run(); // dry run
    expect(out).toMatch(/ALSO ERASED/);
    expect(out).toMatch(/machines/);
  }, 60_000);
});

describe('what it keeps', () => {
  it('leaves the five master lists alone', async () => {
    run(['--yes', '--db', dbName]);
    expect(await count('customers')).toBe(2);
    expect(await count('suppliers')).toBe(2);
    expect(await count('elasticgroups')).toBe(2);
    expect(await count('elastics')).toBe(3);      // 2 seeded + the detailed one
    expect(await count('rawmaterials')).toBe(3);
  }, 60_000);

  it('leaves the logins, the settings and the migration changelog alone', async () => {
    run(['--yes', '--db', dbName]);
    expect(await count('users')).toBe(1);
    expect(await count('documentsettings')).toBe(1);
    expect(await count('costings')).toBe(1);
    // Erasing this replays every migration against a live database.
    expect(await count('changelog')).toBe(1);
  }, 60_000);

  it('spares a collection named with --keep', async () => {
    run(['--yes', '--db', dbName, '--keep', 'machines']);
    expect(await count('machines')).toBe(2);
    expect(await count('orders')).toBe(0);
  }, 60_000);

  it('erases a kept collection named with --wipe', async () => {
    run(['--yes', '--db', dbName, '--wipe', 'costings']);
    expect(await count('costings')).toBe(0);
    expect(await count('users')).toBe(1);
  }, 60_000);
});

describe('the masters that stay', () => {
  it('clears the embedded stock ledger and the counters derived from erased work', async () => {
    run(['--yes', '--db', dbName]);

    const elastic = await db.collection('elastics').findOne({ name: '20mm' });
    expect(elastic.stockMovements).toEqual([]);
    expect(elastic.quantityProduced).toBe(0);
    // A reservation held against an order that no longer exists would
    // block dispatch of the stock for good.
    expect(elastic.reservedStock).toBe(0);

    const material = await db.collection('rawmaterials').findOne({ name: 'Nylon 70D' });
    expect(material.stockMovements).toEqual([]);
  }, 60_000);

  it('keeps the stock BALANCES by default, and says they now have no history', async () => {
    const out = run(['--yes', '--db', dbName]);
    expect((await db.collection('elastics').findOne({ name: '20mm' })).stock).toBe(500);
    expect((await db.collection('rawmaterials').findOne({ name: 'Nylon 70D' })).stock).toBe(300);
    expect(out).toMatch(/nothing behind those/i);
  }, 60_000);

  it('zeroes the balances with --reset-stock', async () => {
    run(['--yes', '--db', dbName, '--reset-stock']);
    expect((await db.collection('elastics').findOne({ name: '20mm' })).stock).toBe(0);
    expect((await db.collection('rawmaterials').findOne({ name: 'Nylon 70D' })).stock).toBe(0);
  }, 60_000);
});

describe('copying what survived into a second database', () => {
  const targetDb = () => mongoose.connection.useDb('baluElastics', { useCache: true }).db;

  it('lands the masters, and nothing that was erased', async () => {
    run(['--yes', '--db', dbName, '--copy-to', 'baluElastics']);
    const t = targetDb();

    expect(await t.collection('customers').countDocuments()).toBe(2);
    expect(await t.collection('elastics').countDocuments()).toBe(3);
    expect(await t.collection('rawmaterials').countDocuments()).toBe(3);
    expect(await t.collection('suppliers').countDocuments()).toBe(2);
    expect(await t.collection('elasticgroups').countDocuments()).toBe(2);
    // The logins come across too, or nobody can sign in to the new one.
    expect(await t.collection('users').countDocuments()).toBe(1);

    for (const name of ['orders', 'employees', 'purchaseorders', 'stockmovements']) {
      expect(await t.collection(name).countDocuments()).toBe(0);
    }
  }, 60_000);

  it('copies the reset masters, not the pre-reset ones', async () => {
    run(['--yes', '--db', dbName, '--copy-to', 'baluElastics']);
    const elastic = await targetDb().collection('elastics').findOne({ name: '20mm' });
    expect(elastic.reservedStock).toBe(0);
    expect(elastic.stockMovements).toEqual([]);
  }, 60_000);

  it('keeps the same _id, so nothing that referenced a master breaks', async () => {
    const before = await db.collection('customers').findOne({});
    run(['--yes', '--db', dbName, '--copy-to', 'baluElastics']);
    const after = await targetDb().collection('customers').findOne({ _id: before._id });
    expect(after).not.toBeNull();
  }, 60_000);

  // Merging into a populated database gives you something that is
  // neither one nor the other, and no way to tell which row came from
  // where.
  it('refuses a target that already holds documents', async () => {
    await targetDb().collection('customers').insertOne({ name: 'Already here' });
    const out = runExpectingFailure(['--yes', '--db', dbName, '--copy-to', 'baluElastics']);
    expect(out).toMatch(/already holds/);
    // …and the source is not erased on the way to refusing.
    expect(await count('orders')).toBe(2);
  }, 60_000);

  it('empties the target first with --overwrite-target', async () => {
    await targetDb().collection('customers').insertOne({ name: 'Already here' });
    run(['--yes', '--db', dbName, '--copy-to', 'baluElastics', '--overwrite-target']);
    const names = await targetDb().collection('customers').find({}).toArray();
    expect(names.some((c) => c.name === 'Already here')).toBe(false);
    expect(names).toHaveLength(2);
  }, 60_000);

  it('refuses to copy a database onto itself', async () => {
    const out = runExpectingFailure(['--yes', '--db', dbName, '--copy-to', dbName]);
    expect(out).toMatch(/is the database you are connected to/);
  }, 60_000);

  it('reports the copy in the dry run without performing it', async () => {
    const out = run(['--copy-to', 'baluElastics']);
    expect(out).toMatch(/COPY TO "baluElastics"/);
    expect(await targetDb().collection('customers').countDocuments()).toBe(0);
  }, 60_000);
});

describe('the dry run', () => {
  it('reports each named collection and its document count before anything happens', async () => {
    const out = run();
    expect(out).toMatch(/NAMED IN THE REQUEST/);
    for (const name of ['stockmovements', 'purchaseorders', 'employees', 'materialinwards', 'materialoutwards']) {
      expect(out).toMatch(new RegExp(`${name}\\s+will be erased \\(2 docs\\)`));
    }
    expect(out).toMatch(/KEEPING/);
    expect(out).toMatch(/ERASING/);
  }, 60_000);

  it('marks a named collection that --keep has spared, rather than staying silent', async () => {
    const out = run(['--keep', 'employees']);
    expect(out).toMatch(/employees\s+⚠️\s+KEPT/);
  }, 60_000);
});
