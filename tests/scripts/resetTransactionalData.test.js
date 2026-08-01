'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE RESET SCRIPT
//
//  A destructive script deserves more scepticism than most code: it is
//  run once, under pressure, and its mistakes are not recoverable. So
//  it is driven here against a real database — seeded on both sides of
//  the line — rather than reasoned about.
//
//  The two questions that matter are opposites, and both are asked:
//  does it empty everything it should, and does it leave everything it
//  should alone.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const { execFileSync } = require('child_process');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'reset-transactional-data.js');

let mongo, uri, dbName;

const run = (args = []) => {
  const res = execFileSync('node', [SCRIPT, ...args], {
    env: { ...process.env, MONGO_URI: uri },
    encoding: 'utf8',
  });
  return res;
};

/** Documents on both sides of the keep/reset line. */
async function seed() {
  const db = mongoose.connection.db;
  const master = {
    customers:    [{ name: 'Acme' }],
    elastics:     [{ name: '20mm', stock: 500, quantityProduced: 900, reservedStock: 40 }],
    rawmaterials: [{ name: 'Nylon 70D', stock: 300 }],
    suppliers:    [{ name: 'Kumar Yarns' }],
    employees:    [{ name: 'Ravi' }],
    machines:     [{ ID: 'M-1', status: 'running', orderRunning: new mongoose.Types.ObjectId(), elastics: [{ head: 1 }] }],
    users:        [{ email: 'o@t.co' }],
    documentsettings: [{ letterhead: 'x' }],
    pdftemplates: [{ name: 'DC' }],
  };
  const transactional = {
    orders:         [{ orderNo: 1 }, { orderNo: 2 }],
    joborders:      [{ jobOrderNo: 1 }],
    warpings:       [{ status: 'open' }],
    coverings:      [{ status: 'open' }],
    warpingplans:   [{ noOfBeams: 2 }],
    warpingbatches: [{ batchNo: 'WB-0001' }],
    yarnlots:       [{ lotNo: 'L-1' }],
    shiftplans:     [{ shift: 'DAY' }],
    shiftdetails:   [{ productionMeters: 100 }],
    packings:       [{ quantity: 10 }],
    deliverychallans: [{ dcNo: 1 }],
    purchaseorders: [{ poNo: 1 }],
    materialinwards: [{ quantity: 5 }],
    stockmovements: [{ quantity: 5 }],
    wastages:       [{ quantity: 1 }],
    qcrecords:      [{ result: 'pass' }],
    payrolls:       [{ net: 100 }],
    attendances:    [{ present: true }],
    counters:       [{ _id: 'orderNo', seq: 42 }],
    // Something this script has never heard of. "Reset all except the
    // master data" has to mean it, or a collection added next year
    // silently survives a reset someone believed was total.
    somethingnew:   [{ a: 1 }, { a: 2 }],
  };
  for (const [name, docs] of Object.entries({ ...master, ...transactional })) {
    await db.collection(name).insertMany(docs);
  }
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  uri = mongo.getUri();
  await mongoose.connect(uri);
  dbName = mongoose.connection.name;
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  for (const c of await mongoose.connection.db.listCollections().toArray()) {
    await mongoose.connection.db.collection(c.name).drop().catch(() => {});
  }
  await seed();
});

const count = (name) => mongoose.connection.db.collection(name).countDocuments();

describe('without confirmation it does nothing', () => {
  test('a bare run only prints a plan', async () => {
    const out = run();
    expect(out).toMatch(/would be deleted/);
    expect(await count('orders')).toBe(2);
    expect(await count('somethingnew')).toBe(2);
  });

  test('--yes alone is not enough — the database must be named', async () => {
    let threw = false;
    try { run(['--yes']); } catch { threw = true; }
    expect(threw).toBe(true);              // non-zero exit
    expect(await count('orders')).toBe(2); // and nothing touched
  });

  test('naming the WRONG database refuses', async () => {
    let threw = false;
    try { run(['--yes', '--confirm-db=some-other-db']); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(await count('orders')).toBe(2);
  });
});

describe('with confirmation', () => {
  const reset = (extra = []) => run(['--yes', `--confirm-db=${dbName}`, ...extra]);

  test('empties the transactional collections', async () => {
    reset();
    for (const name of [
      'orders', 'joborders', 'warpings', 'coverings', 'warpingplans',
      'warpingbatches', 'yarnlots', 'shiftplans', 'shiftdetails', 'packings',
      'deliverychallans', 'purchaseorders', 'materialinwards', 'stockmovements',
      'wastages', 'qcrecords', 'payrolls', 'attendances',
    ]) {
      expect({ name, n: await count(name) }).toEqual({ name, n: 0 });
    }
  });

  test('empties a collection it has never heard of', async () => {
    // Fails open toward resetting: "everything except the master data"
    // has to keep meaning that as the schema grows.
    reset();
    expect(await count('somethingnew')).toBe(0);
  });

  test('keeps every master collection it was asked to keep', async () => {
    reset();
    for (const name of ['customers', 'elastics', 'rawmaterials', 'suppliers', 'employees', 'machines']) {
      expect({ name, n: await count(name) }).toEqual({ name, n: 1 });
    }
  });

  test('keeps the logins and settings, so the system still opens', async () => {
    reset();
    expect(await count('users')).toBe(1);
    expect(await count('documentsettings')).toBe(1);
    expect(await count('pdftemplates')).toBe(1);
  });

  test('frees the machines, which were running orders that no longer exist', async () => {
    reset();
    const m = await mongoose.connection.db.collection('machines').findOne({});
    expect(m.status).toBe('free');
    expect(m.orderRunning).toBeNull();
    expect(m.elastics).toEqual([]);
  });

  test('zeroes the balances whose ledger it just deleted', async () => {
    reset();
    const e = await mongoose.connection.db.collection('elastics').findOne({});
    expect(e.stock).toBe(0);
    expect(e.quantityProduced).toBe(0);
    expect(e.reservedStock).toBe(0);
    expect((await mongoose.connection.db.collection('rawmaterials').findOne({})).stock).toBe(0);
  });

  test('restarts document numbering', async () => {
    reset();
    expect(await count('counters')).toBe(0);
  });

  test('keeps the collections, not just their contents', async () => {
    // deleteMany rather than drop, so the indexes survive and the app
    // is not running unindexed until something recreates them.
    reset();
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    expect(names).toContain('orders');
    expect(names).toContain('joborders');
  });
});

describe('the opt-outs', () => {
  const reset = (extra = []) => run(['--yes', `--confirm-db=${dbName}`, ...extra]);

  test('--keep-stock leaves the balances alone', async () => {
    reset(['--keep-stock']);
    expect((await mongoose.connection.db.collection('elastics').findOne({})).stock).toBe(500);
    expect((await mongoose.connection.db.collection('rawmaterials').findOne({})).stock).toBe(300);
  });

  test('--keep-counters carries the numbering forward', async () => {
    reset(['--keep-counters']);
    expect(await count('counters')).toBe(1);
  });

  test('--drop-users really does drop them', async () => {
    reset(['--drop-users']);
    expect(await count('users')).toBe(0);
    expect(await count('documentsettings')).toBe(0);
    // The master data it was asked to keep is still kept.
    expect(await count('customers')).toBe(1);
  });
});

describe('the plan it prints', () => {
  test('names every kept collection with the reason it survived', () => {
    const out = run();
    expect(out).toMatch(/customers.*master data/);
    expect(out).toMatch(/users.*locks everyone out/);
  });

  test('reports as JSON when asked', () => {
    const parsed = JSON.parse(run(['--json']));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.docsToDelete).toBeGreaterThan(0);
    const orders = parsed.plan.find((p) => p.collection === 'orders');
    expect(orders.action).toBe('reset');
    const customers = parsed.plan.find((p) => p.collection === 'customers');
    expect(customers.action).toBe('keep');
  });
});
