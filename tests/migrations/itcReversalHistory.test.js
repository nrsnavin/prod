'use strict';
// The Rule 37 history migration: every reversal made before steps were
// kept gets its one reversal and one re-claim written down, unchanged.

const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const migration = require('../../migrations/20261112000004-itc-reversal-history');

let mongo, client, db;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('t');
}, 120_000);
afterAll(async () => { await client.close(); await mongo.stop(); });
beforeEach(async () => { for (const c of await db.collections()) await c.deleteMany({}); });

const sept = new Date('2026-09-20T05:00:00Z');
const nov = new Date('2026-11-18T05:00:00Z');

it('writes the reversal and the re-claim as they were recorded, and leaves the rest alone', async () => {
  const reversed = new ObjectId(); const both = new ObjectId(); const never = new ObjectId(); const kept = new ObjectId();
  await db.collection('supplierbills').insertMany([
    { _id: reversed, billNo: 'PB/2026-27/0001', itcReversal: { amount: 250, period: '2026-09', at: sept, reclaimAmount: 0, reclaimPeriod: '', reclaimAt: null } },
    { _id: both, billNo: 'PB/2026-27/0002', itcReversal: { amount: 900, period: '2026-09', at: sept, reclaimAmount: 900, reclaimPeriod: '2026-11', reclaimAt: nov } },
    { _id: never, billNo: 'PB/2026-27/0003', itcReversal: { amount: 0, period: '', reclaimAmount: 0, reclaimPeriod: '' } },
    { _id: kept, billNo: 'PB/2026-27/0004', itcReversal: { amount: 500, period: '2026-10', reclaimAmount: 200, reclaimPeriod: '2026-11', history: [{ kind: 'reverse', amount: 500, period: '2026-10' }, { kind: 'reclaim', amount: 200, period: '2026-11' }] } },
  ]);
  await migration.up(db);
  const get = (id) => db.collection('supplierbills').findOne({ _id: id });
  expect((await get(reversed)).itcReversal.history).toEqual([{ kind: 'reverse', amount: 250, period: '2026-09', at: sept, byName: '' }]);
  expect((await get(both)).itcReversal.history).toEqual([
    { kind: 'reverse', amount: 900, period: '2026-09', at: sept, byName: '' },
    { kind: 'reclaim', amount: 900, period: '2026-11', at: nov, byName: '' },
  ]);
  // No amount or month moved.
  expect((await get(both)).itcReversal).toMatchObject({ amount: 900, period: '2026-09', reclaimAmount: 900, reclaimPeriod: '2026-11' });
  expect((await get(never)).itcReversal.history).toBeUndefined();
  expect((await get(kept)).itcReversal.history).toHaveLength(2);
  const note = await db.collection('migration_notes').findOne({ _id: '20261112000004-itc-reversal-history' });
  expect(note.changed.map((c) => c.billNo).sort()).toEqual(['PB/2026-27/0001', 'PB/2026-27/0002']);

  // Run again: nothing more to write.
  await migration.up(db);
  expect((await db.collection('migration_notes').findOne({ _id: '20261112000004-itc-reversal-history' })).changed).toHaveLength(2);
});

it('down takes the history off again, except where a step was added since', async () => {
  const a = new ObjectId(); const b = new ObjectId();
  await db.collection('supplierbills').insertMany([
    { _id: a, billNo: 'PB/1', itcReversal: { amount: 250, period: '2026-09', at: sept } },
    { _id: b, billNo: 'PB/2', itcReversal: { amount: 400, period: '2026-09', at: sept } },
  ]);
  await migration.up(db);
  // A re-claim through the app after the migration.
  await db.collection('supplierbills').updateOne({ _id: b }, { $push: { 'itcReversal.history': { kind: 'reclaim', amount: 400, period: '2026-11' } } });
  await migration.down(db);
  expect((await db.collection('supplierbills').findOne({ _id: a })).itcReversal.history).toBeUndefined();
  expect((await db.collection('supplierbills').findOne({ _id: b })).itcReversal.history).toHaveLength(2);
  expect(await db.collection('migration_notes').findOne({ _id: '20261112000004-itc-reversal-history' })).toBeNull();
});
