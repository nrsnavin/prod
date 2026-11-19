'use strict';
// ══════════════════════════════════════════════════════════════════
//  PAST BANK STATEMENTS, ONCE THERE ARE MANY
//
//  Found reading api/accountsBank.js line by line.
//
//  The list of an account's statements is its newest thirty. With the
//  bank's own statement arriving by mail every day, thirty is a month.
//  A line left to place on an older statement — "post them from Past
//  statements", the screen says — sat on a statement that was no longer
//  on the list, with no other way to reach it.
//
//  A statement that still has lines to place stays on the list however
//  old it is.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, BankStatement, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const list = (q = '') => request(app).get(`/api/v2/accounts/bank/statements${q}`).set('Cookie', cookie());
const DAY = 86_400_000;
const hdfc = new mongoose.Types.ObjectId();
const kotak = new mongoose.Types.ObjectId();

const line = (index, status) => ({ index, date: new Date('2026-06-01T00:00:00Z'), narration: `NEFT ${index}`, ref: '', amount: 1000 + index, direction: 'in', balance: null, key: `k${index}`, occurrence: 1, status, voucherType: null, voucher: null, voucherNo: '', note: '', suggestion: null, candidates: null });
/** A statement uploaded `daysAgo` days ago, with lines of the given statuses. */
const statement = (account, daysAgo, statuses, file) => {
  const at = new Date(Date.now() - daysAgo * DAY);
  return { account, accountName: 'Current a/c', file: file || `stmt-${daysAgo}.csv`, from: at, to: at, openingBalance: null, closingBalance: null, source: 'email', messageId: '', uploadedByName: 'Bank feed', lines: statuses.map((s, i) => line(i, s)), createdAt: at, updatedAt: at };
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  BankStatement = require('../../models/BankStatement.js');
  admin = await require('../../models/User.js').create({ name: 'Owner', email: 'bsl@t.co', password: 'pass1234', role: 'admin', department: 'admin' });

  await BankStatement.collection.insertMany([
    // Forty days of the bank's daily statement, every line in the books…
    ...Array.from({ length: 40 }, (_, i) => statement(hdfc, i + 1, ['recorded', 'posted', 'ignored'])),
    // …and three older ones with something still to place.
    statement(hdfc, 60, ['recorded', 'unmatched'], 'old-unmatched.csv'),
    statement(hdfc, 75, ['matched', 'posted'], 'old-suggested.csv'),
    statement(hdfc, 90, ['unmatched', 'unmatched', 'matched'], 'oldest-three.csv'),
    // An old one that is done with, and another account's.
    statement(hdfc, 120, ['recorded'], 'old-done.csv'),
    statement(kotak, 80, ['unmatched'], 'kotak-old.csv'),
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('an account\'s past statements', () => {
  it('keep every statement that still has a line to place, however old', async () => {
    const res = await list(`?account=${hdfc}`);
    expect(res.status).toBe(200);
    const files = res.body.statements.map((s) => s.file);
    // Before: the newest thirty, and none of these.
    expect(files).toEqual(expect.arrayContaining(['old-unmatched.csv', 'old-suggested.csv', 'oldest-three.csv']));
    // The newest thirty are still there, newest first, the old ones after them.
    expect(files.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `stmt-${i + 1}.csv`));
    expect(files.slice(30)).toEqual(['old-unmatched.csv', 'old-suggested.csv', 'oldest-three.csv']);
    // What is done with, and beyond the thirty, is not brought back.
    expect(files).not.toContain('old-done.csv');
    expect(files).not.toContain('stmt-31.csv');
    // Nor another account's.
    expect(files).not.toContain('kotak-old.csv');
  });

  it('say how many lines each still has to place: the suggested ones too', async () => {
    const by = Object.fromEntries((await list(`?account=${hdfc}`)).body.statements.map((s) => [s.file, s]));
    expect(by['oldest-three.csv']).toMatchObject({ lines: 3, toPlace: 3, counts: { unmatched: 2, matched: 1 } });
    expect(by['old-suggested.csv']).toMatchObject({ lines: 2, toPlace: 1 });
    expect(by['stmt-1.csv']).toMatchObject({ lines: 3, toPlace: 0 });
  });

  it('are every account\'s when no account is asked for (unchanged), with the old unplaced ones', async () => {
    const files = (await list()).body.statements.map((s) => s.file);
    expect(files.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `stmt-${i + 1}.csv`));
    expect(files).toEqual(expect.arrayContaining(['old-unmatched.csv', 'old-suggested.csv', 'kotak-old.csv', 'oldest-three.csv']));
  });
});
