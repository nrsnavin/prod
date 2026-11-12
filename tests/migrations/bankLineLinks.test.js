'use strict';
// ══════════════════════════════════════════════════════════════════
//  VOUCHERS GIVEN THE IDENTITY OF THE BANK LINE THEY ANSWER
//
//  The migration reads the statements already stored:
//
//    • each line gets its occurrence (two equal lines on a day: 1, 2);
//    • a line in the books gives its live voucher the line's identity,
//      the oldest statement first; the same line on a later statement
//      pointing at the same voucher is the same thing, not a conflict;
//    • a second voucher posted from the same bank line (the old fault)
//      is left alone and listed, not given a line another already has;
//    • a line whose voucher was cancelled goes back to be placed;
//    • twice is the same as once; `down` takes the identities off.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');

const migration = require('../../migrations/20261112000003-bank-line-links');
const ME = '20261112000003-bank-line-links';

let mongo, client, db;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db = client.db('test');
}, 120_000);
afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => { for (const c of ['bankstatements', 'payments', 'contras', 'migration_notes']) await db.collection(c).deleteMany({}); });

const acct = new ObjectId();
const other = new ObjectId();
const line = (index, key, status, voucher, voucherNo, voucherType = 'Payment') => ({ index, key, date: new Date('2026-11-03'), narration: key, ref: '', amount: 100, direction: 'in', status, voucherType: voucher ? voucherType : null, voucher: voucher || null, voucherNo: voucherNo || '' });
const pay = (no, extra = {}) => ({ _id: new ObjectId(), voucherNo: no, status: 'posted', account: acct, source: 'statement', requestId: `req-${no}`, ...extra });

async function seed() {
  const v1 = pay('RCT/1'), v2 = pay('RCT/2', { source: 'manual' }), v3 = pay('RCT/3'), v4 = pay('PAY/4'), v5 = pay('PAY/5'), dead = pay('RCT/9', { status: 'cancelled' });
  const c1 = { _id: new ObjectId(), contraNo: 'CTR/1', status: 'posted', from: acct, to: other };
  await db.collection('payments').insertMany([v1, v2, v3, v4, v5, dead]);
  await db.collection('contras').insertOne(c1);
  const st1 = new ObjectId(), st2 = new ObjectId();
  await db.collection('bankstatements').insertMany([
    { _id: st1, account: acct, file: 'week1.csv', createdAt: new Date('2026-11-05'), lines: [
      line(0, 'A', 'posted', v1._id, 'RCT/1'),
      line(1, 'B', 'recorded', v2._id, 'RCT/2'),
      line(2, 'C', 'unmatched'),
      line(3, 'D', 'posted', dead._id, 'RCT/9'),
    ] },
    { _id: st2, account: acct, file: 'week2.csv', createdAt: new Date('2026-11-12'), lines: [
      line(0, 'A', 'posted', v3._id, 'RCT/3'),          // the same bank line, posted a second time
      line(1, 'B', 'recorded', v2._id, 'RCT/2'),        // the same line, the same voucher: fine
      line(2, 'K', 'posted', v4._id, 'PAY/4'),
      line(3, 'K', 'posted', v5._id, 'PAY/5'),          // an equal line the same day: the second one
      line(4, 'T', 'posted', c1._id, 'CTR/1', 'Contra'),
    ] },
  ]);
  return { v1, v2, v3, v4, v5, dead, c1, st1, st2 };
}
const id = (key, n = 1) => `${acct}|${key}#${n}`;
const bankLine = async (v) => (await db.collection('payments').findOne({ _id: v._id })).bankLine;

describe('up', () => {
  it('links each live voucher to its line, numbers equal lines, frees a cancelled voucher\'s line, and lists what it will not guess', async () => {
    const s = await seed();
    await migration.up(db);
    expect(await bankLine(s.v1)).toBe(id('A'));
    expect(await bankLine(s.v2)).toBe(id('B'));
    expect(await bankLine(s.v3)).toBeUndefined();               // A is V1's; the duplicate is not given it
    expect(await bankLine(s.v4)).toBe(id('K', 1));
    expect(await bankLine(s.v5)).toBe(id('K', 2));
    expect((await db.collection('contras').findOne({ _id: s.c1._id })).bankLineFrom).toBe(id('T'));

    const st2 = await db.collection('bankstatements').findOne({ _id: s.st2 });
    expect(st2.lines.map((l) => l.occurrence)).toEqual([1, 1, 1, 2, 1]);
    // The cancelled voucher's line is to be placed again; the voucher gives up the request id it was posted under.
    const st1 = await db.collection('bankstatements').findOne({ _id: s.st1 });
    expect(st1.lines[3]).toMatchObject({ status: 'unmatched', voucher: null, voucherNo: '', note: 'RCT/9 was cancelled: to be placed again' });
    expect((await db.collection('payments').findOne({ _id: s.dead._id })).requestId).toBeUndefined();
    expect((await db.collection('payments').findOne({ _id: s.v1._id })).requestId).toBe('req-RCT/1');

    const note = await db.collection('migration_notes').findOne({ _id: ME });
    expect(note).toMatchObject({ linked: 5, freed: 1 });
    expect(note.conflicts).toEqual([expect.objectContaining({ file: 'week2.csv', index: 0, voucherNo: 'RCT/3', why: 'RCT/1 already answers this line' })]);
  });

  it('does the same thing the second time', async () => {
    const s = await seed();
    await migration.up(db);
    const before = [await db.collection('payments').find().sort({ voucherNo: 1 }).toArray(), await db.collection('bankstatements').find().sort({ file: 1 }).toArray()];
    await migration.up(db);
    expect([await db.collection('payments').find().sort({ voucherNo: 1 }).toArray(), await db.collection('bankstatements').find().sort({ file: 1 }).toArray()]).toEqual(before);
    expect(await bankLine(s.v3)).toBeUndefined();
  });
});

describe('down', () => {
  it('takes the identities off again', async () => {
    const s = await seed();
    await migration.up(db);
    await migration.down(db);
    expect(await db.collection('payments').countDocuments({ bankLine: { $exists: true } })).toBe(0);
    expect((await db.collection('contras').findOne({ _id: s.c1._id })).bankLineFrom).toBeUndefined();
    expect(await db.collection('migration_notes').countDocuments()).toBe(0);
  });
});
