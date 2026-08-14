'use strict';
// ══════════════════════════════════════════════════════════════════
//  SEEDING GROUPS FROM THE CATEGORIES ACTUALLY IN USE
//
//  The migration reads the distinct `category` values in the database
//  rather than any hardcoded list, because there were eight of those
//  and they did not agree. The two things that had to be true:
//
//    • it folds "warp" and "Warp" into ONE group, keeping whichever
//      spelling the most materials use — otherwise it carries the
//      split forward permanently, which is the fault it exists to fix;
//
//    • running it twice does nothing the second time.
//
//  Standalone mongod, not a replica set: the migration is plain
//  updateMany work with no transaction, and a replset here is slower
//  for no gain.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

const migration = require('../../migrations/20260814000001-material-groups');

let mongo, client, db;

beforeAll(async () => {
  mongo  = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db     = client.db('test');
}, 120_000);

afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => {
  await db.collection('rawmaterials').deleteMany({});
  await db.collection('materialgroups').deleteMany({});
});

const seed = (rows) =>
  db.collection('rawmaterials').insertMany(
    rows.map((r) => ({ name: r.name, category: r.category, stock: 0, price: 0 }))
  );

const groups    = () => db.collection('materialgroups').find().sort({ name: 1 }).toArray();
const materials = () => db.collection('rawmaterials').find().sort({ name: 1 }).toArray();

// ══════════════════════════════════════════════════════════════════
describe('what it creates', () => {
  it('makes one group per distinct category in the data', async () => {
    await seed([
      { name: 'A', category: 'warp' },
      { name: 'B', category: 'weft' },
      { name: 'C', category: 'warp' },
    ]);
    await migration.up(db);

    expect((await groups()).map((g) => g.name)).toEqual(['warp', 'weft']);
  });

  it('creates the categories no hardcoded list knew about', async () => {
    // The mobile app has always offered "Chemicals"; the web never
    // had it. Seeding from a list would have dropped it.
    await seed([{ name: 'A', category: 'Chemicals' }]);
    await migration.up(db);

    expect((await groups()).map((g) => g.name)).toEqual(['Chemicals']);
  });

  it('points every material at its group', async () => {
    await seed([{ name: 'A', category: 'warp' }]);
    await migration.up(db);

    const [g] = await groups();
    const [m] = await materials();
    expect(String(m.group)).toBe(String(g._id));
    expect(m.category).toBe('warp');
  });

  it('gives each group a code derived from its name', async () => {
    await seed([{ name: 'A', category: 'Warp Yarn' }]);
    await migration.up(db);
    expect((await groups())[0].code).toBe('WARP_YARN');
  });

  it('reads the axis off the name, and guesses nothing it cannot tell', async () => {
    await seed([
      { name: 'A', category: 'warp' },
      { name: 'B', category: 'Rubber' },
      { name: 'C', category: 'Misc' },
    ]);
    await migration.up(db);

    const byName = Object.fromEntries((await groups()).map((g) => [g.name, g.kind]));
    expect(byName).toEqual({ warp: 'position', Rubber: 'material', Misc: 'other' });
  });

  it('does nothing at all on an empty database', async () => {
    await migration.up(db);
    expect(await groups()).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('two spellings of one group', () => {
  it('folds them into a single group', async () => {
    await seed([
      { name: 'A', category: 'warp' },
      { name: 'B', category: 'Warp' },
    ]);
    await migration.up(db);

    expect(await groups()).toHaveLength(1);
  });

  it('keeps the spelling the most materials use', async () => {
    await seed([
      { name: 'A', category: 'Warp' },
      { name: 'B', category: 'warp' },
      { name: 'C', category: 'warp' },
    ]);
    await migration.up(db);

    expect((await groups())[0].name).toBe('warp');   // 2 beats 1
  });

  it('rewrites the odd one out, so category matches the group name', async () => {
    await seed([
      { name: 'A', category: 'warp' },
      { name: 'B', category: 'warp' },
      { name: 'C', category: 'Warp' },
    ]);
    await migration.up(db);

    expect((await materials()).map((m) => m.category)).toEqual(['warp', 'warp', 'warp']);
  });

  it('files both spellings under the one group', async () => {
    await seed([
      { name: 'A', category: 'Rubber' },
      { name: 'B', category: 'rubber' },
    ]);
    await migration.up(db);

    const [g] = await groups();
    const ids = new Set((await materials()).map((m) => String(m.group)));
    expect(ids).toEqual(new Set([String(g._id)]));
  });
});

// ══════════════════════════════════════════════════════════════════
describe('running it twice', () => {
  it('creates no second set of groups', async () => {
    await seed([
      { name: 'A', category: 'warp' },
      { name: 'B', category: 'weft' },
    ]);
    await migration.up(db);
    await migration.up(db);

    expect(await groups()).toHaveLength(2);
  });

  it('leaves every material pointing where it did', async () => {
    await seed([{ name: 'A', category: 'warp' }]);
    await migration.up(db);
    const before = await materials();

    await migration.up(db);
    const after = await materials();

    expect(after.map((m) => String(m.group))).toEqual(before.map((m) => String(m.group)));
  });

  it('finds its own group again after an admin changes the capitals', async () => {
    await seed([{ name: 'A', category: 'warp' }]);
    await migration.up(db);

    // Somebody tidies the name in Settings; the rename cascades to the
    // member, exactly as the router does it.
    const [g] = await groups();
    await db.collection('materialgroups')
      .updateOne({ _id: g._id }, { $set: { name: 'Warp' } });
    await db.collection('rawmaterials')
      .updateMany({ group: g._id }, { $set: { category: 'Warp' } });

    await migration.up(db);
    expect(await groups()).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('units', () => {
  it('defaults every material to kg', async () => {
    // api/rawMaterial.js read `m.unit || ""` for years before the field
    // existed, so every unit it returned was the empty string.
    await seed([{ name: 'A', category: 'warp' }]);
    await migration.up(db);

    expect((await materials())[0].unit).toBe('kg');
  });

  it('does not overwrite a unit somebody already set', async () => {
    await seed([{ name: 'A', category: 'Chemicals' }]);
    await db.collection('rawmaterials').updateOne({ name: 'A' }, { $set: { unit: 'ltr' } });
    await migration.up(db);

    expect((await materials())[0].unit).toBe('ltr');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('rolling back', () => {
  it('leaves category alone — it is what every reader uses', async () => {
    await seed([{ name: 'A', category: 'warp' }]);
    await migration.up(db);
    await migration.down(db);

    const [m] = await materials();
    expect(m.category).toBe('warp');
    expect(m.group).toBeUndefined();
    expect(await groups()).toHaveLength(0);
  });
});
