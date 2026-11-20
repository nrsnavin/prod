'use strict';
// ══════════════════════════════════════════════════════════════════
//  TWO BANK LINES THAT LOOK THE SAME ARE TWO LINES
//
//  Found reading services/reconcile.js line by line.
//
//  The bank charges 5.90 twice on one day: two lines with the same day,
//  amount and narration. Everywhere else they are kept apart — the
//  first of them and the second (services/bankLines.js) — so each gets
//  its own voucher. The reconciliation counted "each line once" by the
//  line's key alone, so the two were one:
//
//    • both unplaced: only one 5.90 was listed and taken off, and the
//      reconciliation was 5.90 out with nothing on the screen to explain it;
//    • one of them posted: the other vanished from the list (the key was
//      "done"), and the difference stayed.
//
//  A line is its key AND which of that key's lines it is.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const csv = (lines) => Buffer.from(['Txn Date,Narration,Ref No,Withdrawal,Deposit,Balance', ...lines].join('\n'));
const upload = (bank, file, name = 'kotak.csv') => request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(bank._id)).field('useModel', 'false').attach('file', file, { filename: name, contentType: 'text/csv' });
const recon = async (bank, extra = '') => (await get(`/accounts/bank/reconciliation?account=${bank._id}&asOf=2026-07-31${extra}`)).body;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Payment', 'BankAccount', 'BankStatement']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'twins@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
async function bankAccount() {
  n += 1;
  await get('/accounts/bank-accounts');
  return (await post('/accounts/bank-accounts', { name: `Kotak ${n}`, kind: 'bank', openingBalance: 100000 })).body.account;
}
const TWINS = ['08/07/2026,SMS CHARGES,,5.90,,99994.10', '08/07/2026,SMS CHARGES,,5.90,,99988.20'];

describe('two bank lines with the same day, amount and narration', () => {
  it('are both taken off in the reconciliation, which then agrees with the bank', async () => {
    const bank = await bankAccount();
    const up = await upload(bank, csv(TWINS));
    expect(up.status).toBe(200);
    expect(up.body.counts).toMatchObject({ unmatched: 2 });

    const rec = await recon(bank);
    // Before: one line of 5.90, expected 99,994.10, and 5.90 unexplained.
    expect(rec.unmatched.map((l) => [l.narration, l.amount, l.direction])).toEqual([['SMS CHARGES', 5.9, 'out'], ['SMS CHARGES', 5.9, 'out']]);
    expect(rec.totals).toMatchObject({ unmatchedOut: 11.8, unmatchedIn: 0 });
    expect(rec).toMatchObject({ bookBalance: 100000, bankBalance: 99988.2, expectedBankBalance: 99988.2, difference: 0 });
    // Each is its own line of the statement.
    expect(new Set(rec.unmatched.map((l) => l.index)).size).toBe(2);
  });

  it('one posted leaves the other still to place', async () => {
    const bank = await bankAccount();
    const up = await upload(bank, csv(TWINS));
    const [first] = up.body.rows;
    const posted = await post('/accounts/bank/statement/post', { account: bank._id, statement: up.body.statement, rows: [{ index: first.index, partyType: 'other', partyName: 'Kotak bank charges' }] });
    expect(posted.body.posted).toBe(1);

    const rec = await recon(bank);
    // Before: nothing listed, and the reconciliation 5.90 out.
    expect(rec.unmatched).toHaveLength(1);
    expect(rec.unmatched[0]).toMatchObject({ narration: 'SMS CHARGES', amount: 5.9, direction: 'out' });
    expect(rec.unmatched[0].index).not.toBe(first.index);
    expect(rec).toMatchObject({ bookBalance: 99994.1, expectedBankBalance: 99988.2, difference: 0 });
  });

  it('the same statement uploaded again is still two lines, not four', async () => {
    const bank = await bankAccount();
    await upload(bank, csv(TWINS));
    await upload(bank, csv([...TWINS, '09/07/2026,NEFT CR APEX,UTR9,,2500,102488.20']), 'kotak-2.csv');
    const rec = await recon(bank);
    expect(rec.unmatched.map((l) => [l.narration, l.amount])).toEqual([['SMS CHARGES', 5.9], ['SMS CHARGES', 5.9], ['NEFT CR APEX', 2500]]);
    expect(rec.totals).toMatchObject({ unmatchedOut: 11.8, unmatchedIn: 2500 });
    expect(rec).toMatchObject({ bankBalance: 102488.2, expectedBankBalance: 102488.2, difference: 0 });
  });

  it('a line posted on one upload is done on the other too (unchanged)', async () => {
    const bank = await bankAccount();
    const a = await upload(bank, csv(['08/07/2026,LOCKER RENT,,1180,,98820']));
    await upload(bank, csv(['08/07/2026,LOCKER RENT,,1180,,98820', '09/07/2026,NEFT CR APEX,UTR9,,2500,101320']), 'kotak-2.csv');
    await post('/accounts/bank/statement/post', { account: bank._id, statement: a.body.statement, rows: [{ index: a.body.rows[0].index, partyType: 'other', partyName: 'Kotak locker rent' }] });
    const rec = await recon(bank);
    expect(rec.unmatched.map((l) => l.narration)).toEqual(['NEFT CR APEX']);
    expect(rec).toMatchObject({ difference: 0 });
  });
});
