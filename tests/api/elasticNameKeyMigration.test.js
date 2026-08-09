'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BACKFILL, AND THE CONSTRAINT UNDER IT
//
//  Two separate things, deliberately split across two mechanisms:
//
//    • the migration derives `nameKey` on rows written before it
//      existed — plain updates, safe anywhere in the chain;
//    • the unique index is declared on the schema and built by
//      mongoose at startup, because an index created at the end of the
//      migration chain does not return.
//
//  The split is the interesting part, so both halves are tested here,
//  including the one that matters most on a dirty catalogue: a failed
//  index build must not take the process down with it.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const migration = require('../../migrations/20260809000001-elastic-name-key-unique.js');

const INDEX = 'elastic_nameKey_unique';

let mongo, db, Elastic;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongo.getUri());
  Elastic = require('../../models/Elastic');
  db = mongoose.connection.db;
  // autoIndex builds in the background. Without waiting, a test that
  // drops the index races the build that is still creating it.
  await Elastic.init();
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await db.collection('elastics').deleteMany({}); });

const indexNames = async () =>
  (await db.collection('elastics').indexes()).map((i) => i.name);

/** Insert past the model, the way a row written before all this looks. */
const legacy = (...names) =>
  db.collection('elastics').insertMany(names.map((name) => ({ name })));

// ── The migration ─────────────────────────────────────────────────

describe('the backfill migration', () => {
  // The state a dirty catalogue is actually in when this runs: the
  // schema declares the index, mongoose tried to build it at startup,
  // and the duplicates refused it. So the backfill meets no index —
  // which is what lets it give both halves of a pair the same key and
  // make them findable. The one case where an index IS present has its
  // own test below.
  beforeEach(async () => {
    await Elastic.collection.dropIndex(INDEX).catch(() => {});
  });

  it('derives a key for every row that has none', async () => {
    await legacy('NEWDAY ROMEO BLACK', 'Newday  Romeo Black', 'BLUE 20MM');
    await migration.up(db);

    const rows = await db.collection('elastics').find({}).toArray();
    expect(rows.every((r) => typeof r.nameKey === 'string')).toBe(true);
    // The two spellings fold to one key — which is what makes them
    // findable as the duplicate pair they are.
    expect(rows.filter((r) => r.nameKey === 'newday romeo black')).toHaveLength(2);
  });

  it('creates no index, so it cannot stall the chain', async () => {
    // The whole reason this migration is updates-only.
    await legacy('Alpha', 'Beta');

    await migration.up(db);

    expect(await indexNames()).not.toContain(INDEX);
  });

  it('changes no name and deletes no row', async () => {
    // A migration that merged duplicates would move one product's
    // history onto another, silently and unrecoverably.
    await legacy('NEWDAY ROMEO BLACK', 'Newday  Romeo Black');
    const before = await db.collection('elastics').find({})
      .project({ name: 1 }).sort({ name: 1 }).toArray();
    await migration.up(db);
    const after = await db.collection('elastics').find({})
      .project({ name: 1 }).sort({ name: 1 }).toArray();
    expect(after).toEqual(before);
  });

  it('survives the index refusing a key, and says which rows', async () => {
    // The nasty one. The unique index is sparse, so rows with no key
    // yet all slip under it — and the first time two of them are given
    // the SAME key, the second is refused. Throwing would abort the
    // chain and stop `npm start` over data that needs a person.
    await Elastic.collection.createIndex(
      { nameKey: 1 }, { unique: true, sparse: true, name: INDEX }
    );
    await legacy('NEWDAY ROMEO BLACK', 'Newday  Romeo Black', 'BLUE 20MM');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(migration.up(db)).resolves.toBeUndefined();

    // One of the pair took the key; the other is left for a person.
    const rows = await db.collection('elastics').find({}).toArray();
    expect(rows.filter((r) => r.nameKey === 'newday romeo black')).toHaveLength(1);
    // The unrelated row is unaffected — one bad pair must not cost the
    // rest of the catalogue its keys.
    expect(rows.find((r) => r.name === 'BLUE 20MM').nameKey).toBe('blue 20mm');
    expect(await db.collection('elastics').countDocuments()).toBe(3);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/find-duplicate-elastics/);

    warn.mockRestore();
    await Elastic.collection.dropIndex(INDEX);
  });

  it('leaves rows that already have a key alone', async () => {
    await db.collection('elastics').insertOne({ name: 'Kept', nameKey: 'kept' });
    await migration.up(db);
    expect((await db.collection('elastics').findOne({ name: 'Kept' })).nameKey).toBe('kept');
  });

  it('is safe to run twice', async () => {
    await legacy('Alpha');
    await migration.up(db);
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db.collection('elastics').countDocuments()).toBe(1);
  });

  it('does nothing on an empty catalogue', async () => {
    await expect(migration.up(db)).resolves.toBeUndefined();
  });
});

// ── The constraint ────────────────────────────────────────────────

describe('the unique index the schema declares', () => {
  it('is refused by the database once built', async () => {
    await Elastic.collection.createIndex(
      { nameKey: 1 }, { unique: true, sparse: true, name: INDEX }
    );
    await db.collection('elastics').insertOne({ name: 'Blue 20mm', nameKey: 'blue 20mm' });

    await expect(
      db.collection('elastics').insertOne({ name: 'BLUE 20MM', nameKey: 'blue 20mm' })
    ).rejects.toMatchObject({ code: 11000 });

    await Elastic.collection.dropIndex(INDEX);
  });

  it('is sparse, so rows with no key do not collide', async () => {
    await Elastic.collection.createIndex(
      { nameKey: 1 }, { unique: true, sparse: true, name: INDEX }
    );
    await db.collection('elastics').insertMany([{ note: 'a' }, { note: 'b' }]);
    expect(await db.collection('elastics').countDocuments()).toBe(2);
    await Elastic.collection.dropIndex(INDEX);
  });

  it('reports a failed build instead of taking the process down', async () => {
    // This is the one that matters. index.js exits the process on an
    // unhandled rejection, so an unhandled index-build failure on a
    // catalogue with duplicates would become a crash loop under
    // systemd — a data problem turned into an outage.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const handlers = Elastic.listeners('index');
    expect(handlers.length).toBeGreaterThan(0);

    handlers[0](new Error('E11000 duplicate key error'));

    expect(warn).toHaveBeenCalled();
    const said = warn.mock.calls.flat().join(' ');
    // And it points at the tool that lists what is in the way.
    expect(said).toMatch(/find-duplicate-elastics/);
    expect(said).toMatch(/still refused by the API/);
    warn.mockRestore();
  });

  it('says nothing when the build succeeds', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    Elastic.listeners('index')[0](null);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
