'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CHEQUE REGISTER, AND THE LABELS A YEAR AND A MONTH GO BY
//
//  Found reading api/accountsRegisters.js line by line.
//
//  1. "TO DEPOSIT" ADDED IN THE CHEQUES WE ISSUED. The register's
//     figures for cheques due today and this week took every held
//     cheque — the ones received, and the post-dated ones we gave —
//     and the screen printed the sum as "to deposit".
//
//  2. "TODAY" WAS THE SERVER'S DATE. Until 05:30 in India that is
//     yesterday: a cheque dated today was not yet due.
//
//  3. THE OLDEST FIVE HUNDRED. The list is sorted by cheque date,
//     oldest first, and cut at 500. Right for cheques in hand; for the
//     cleared ones it meant that after five hundred, no cheque cleared
//     since was ever listed.
//
//  4. ONE DOOR CHECKED THE DATE, THE OTHER DID NOT. A deposit slip
//     refuses a cheque dated after the deposit ("the bank will not take
//     it before then"); the cheque's own Deposit button took it.
//
//  5. A YEAR OR A MONTH WAS CHECKED FOR ITS SHAPE ONLY. "2026-28" and
//     the month "2026-11" passed for a financial year, "2026-13" for a
//     month. A year's depreciation posted for "2026-28" is 2026-27's,
//     under another label — and 2026-27 could then be posted as well.
//
//  6. Closing stock could not be posted for today before 05:30, and the
//     registers' default month was the server's month.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, bank;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const DAY = 86_400_000;
/** India's day `n` days from today, as the books keep a day. */
const day = (n) => new Date(`${new Date(Date.now() + n * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}T00:00:00Z`);
const ymd = (d) => d.toISOString().slice(0, 10);
const clock = (at) => jest.useFakeTimers({ now: new Date(at), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Payment', 'BankAccount', 'Journal', 'ExpenseCategory', 'Budget']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'rcl@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await get('/accounts/bank-accounts');       // seeds the accounts
  bank = await M.BankAccount.findOne({ kind: 'bank' }) || await M.BankAccount.create({ name: 'HDFC CA', kind: 'bank', active: true });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.useRealTimers();
  for (const name of ['payments', 'journals', 'fixedassets', 'budgets']) await mongoose.connection.collection(name).deleteMany({});
});

let seq = 0;
const cheque = (kind, on, amount, status = 'held', more = {}) => {
  seq += 1;
  return {
    kind, status: 'posted', voucherNo: `${kind === 'receipt' ? 'RCT' : 'PAY'}/T/${seq}`, partyName: kind === 'receipt' ? `Customer ${seq}` : `Supplier ${seq}`, partyType: 'other',
    amount, mode: 'cheque', account: bank._id, accountName: bank.name, date: new Date(on.getTime() - 5 * DAY),
    cheque: { number: String(100000 + seq), bank: 'SBI', date: on, status, receivedOn: new Date(on.getTime() - 5 * DAY), ...more },
    allocations: [], adjustments: [], fingerprints: [], createdAt: new Date(), updatedAt: new Date(),
  };
};

// ══════════════════════════════════════════════════════════════════
describe('the cheque register\'s figures', () => {
  beforeEach(async () => {
    await M.Payment.collection.insertMany([
      cheque('receipt', day(-1), 1000), cheque('receipt', day(0), 2000), cheque('receipt', day(3), 5000), cheque('receipt', day(20), 7000),
      cheque('payment', day(0), 40000), cheque('payment', day(5), 12000), cheque('payment', day(30), 9000),
    ]);
  });

  it('"to deposit" is the cheques received; the ones we gave are counted beside them', async () => {
    const t = (await get('/accounts/pdc')).body.totals;
    // Before: { count: 3, amount: 43000 } — our own 40,000 cheque "to deposit".
    expect(t.dueToday).toEqual({ count: 2, amount: 3000, issued: { count: 1, amount: 40000 } });
    // Before: { count: 5, amount: 60000 }.
    expect(t.dueThisWeek).toEqual({ count: 3, amount: 8000, issued: { count: 2, amount: 52000 } });
  });

  it('says how many are in the drawer and how many are ours, held to their date', async () => {
    const t = (await get('/accounts/pdc')).body.totals;
    expect(t.held).toEqual({ count: 7, received: 15000, issued: 61000, receivedCount: 4, issuedCount: 3 });
  });

  it('lists the held ones soonest first (unchanged), and says how many there are', async () => {
    const res = await get('/accounts/pdc');
    expect(res.body.status).toBe('held');
    expect(res.body.rows).toHaveLength(7);
    expect(res.body.total).toBe(7);
    const dates = res.body.rows.map((r) => r.cheque.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('"today" on the cheque register', () => {
  it('is India\'s day: at half past one in the morning a cheque dated today is due', async () => {
    clock('2026-11-20T20:00:00Z');            // 01:30 on 21 November in India
    await M.Payment.collection.insertMany([
      cheque('receipt', new Date('2026-11-21T00:00:00Z'), 2500),
      cheque('receipt', new Date('2026-11-22T00:00:00Z'), 900),
    ]);
    const t = (await get('/accounts/pdc')).body.totals;
    // Before: { count: 0, amount: 0 } until 05:30.
    expect(t.dueToday).toMatchObject({ count: 1, amount: 2500 });
    expect(t.dueThisWeek).toMatchObject({ count: 2, amount: 3400 });
  });
});

describe('the cleared cheques, once there are more than the page holds', () => {
  it('are the newest five hundred, and the answer says how many there are in all', async () => {
    const first = new Date('2024-01-01T00:00:00Z');
    await M.Payment.collection.insertMany(Array.from({ length: 505 }, (_, i) => {
      const on = new Date(first.getTime() + i * DAY);
      return cheque('receipt', on, 100 + i, 'cleared', { depositedOn: on, clearedOn: on });
    }));
    const res = await get('/accounts/pdc?status=cleared');
    expect(res.body.rows).toHaveLength(500);
    expect(res.body.total).toBe(505);
    // Before: the oldest five hundred — the five cleared last were not on it.
    expect(ymd(new Date(res.body.rows[0].cheque.date))).toBe(ymd(new Date(first.getTime() + 504 * DAY)));
    expect(res.body.rows.map((r) => r.amount)).toContain(604);
    expect(res.body.rows.map((r) => r.amount)).not.toContain(100);
  });

  it('every stage together is newest first too', async () => {
    await M.Payment.collection.insertMany([
      cheque('receipt', day(-40), 1, 'cleared'), cheque('receipt', day(-10), 2, 'deposited'), cheque('receipt', day(4), 3, 'held'),
    ]);
    const res = await get('/accounts/pdc?status=all');
    expect(res.body.rows.map((r) => r.amount)).toEqual([3, 2, 1]);
  });
});

describe('depositing one cheque from its own button', () => {
  it('refuses a cheque dated after the day of deposit, as a deposit slip does', async () => {
    const { insertedId } = await M.Payment.collection.insertOne(cheque('receipt', day(10), 8000));
    const res = await post(`/accounts/payments/${insertedId}/cheque`, { action: 'deposited', on: ymd(day(0)) });
    // Before: 200, and the cheque read "deposited" ten days before a bank would take it.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/the bank will not take it before then/);
    expect((await M.Payment.findById(insertedId).lean()).cheque.status).toBe('held');
  });

  it('takes it on its date (unchanged)', async () => {
    const { insertedId } = await M.Payment.collection.insertOne(cheque('receipt', day(0), 8000));
    const res = await post(`/accounts/payments/${insertedId}/cheque`, { action: 'deposited', on: ymd(day(0)) });
    expect(res.status).toBe(200);
    expect(res.body.payment.cheque.status).toBe('deposited');
  });

  it('lets a cheque we gave be marked handed over before its date (unchanged): that is what post-dating is', async () => {
    const { insertedId } = await M.Payment.collection.insertOne(cheque('payment', day(10), 8000));
    const res = await post(`/accounts/payments/${insertedId}/cheque`, { action: 'deposited', on: ymd(day(0)) });
    expect(res.status).toBe(200);
  });

  it('lets the bank\'s own word stand: a cheque it has cleared is cleared (unchanged)', async () => {
    const { insertedId } = await M.Payment.collection.insertOne(cheque('receipt', day(10), 8000));
    const res = await post(`/accounts/payments/${insertedId}/cheque`, { action: 'cleared', on: ymd(day(0)) });
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a financial year is April to March, and says so', () => {
  const asset = () => post('/accounts/fixed-assets', { name: 'Needle loom 12', block: 'plant', purchaseDate: '2026-05-01', putToUse: '2026-05-10', cost: 1000000 });

  it('depreciation cannot be posted under a label that is not a year — and so not twice', async () => {
    expect((await asset()).status).toBe(201);
    for (const fy of ['2026-28', '2026-99', '2026-11', '2026-26']) {
      const res = await post('/accounts/fixed-assets/depreciation', { fy });
      // Before: 201 — 2026-27's depreciation, posted under another name.
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/fy must be like 2026-27/);
    }
    expect((await post('/accounts/fixed-assets/depreciation', { fy: '2026-27' })).status).toBe(201);
    expect(await M.Journal.countDocuments({ source: 'depreciation', status: 'posted' })).toBe(1);
  });

  it('an asset brought in with its written-down value is not saved without it because the year was mistyped', async () => {
    const body = { name: 'Old compressor', block: 'plant', purchaseDate: '2021-06-01', putToUse: '2021-06-10', cost: 500000 };
    for (const fy of ['2026', '26-27', '2026-2027', '2026-28']) {
      const res = await post('/accounts/fixed-assets', { ...body, openingWdv: { fy, companiesAct: 300000 } });
      // Before: 201 — the asset saved at its full cost, the opening value dropped without a word
      // ("2026-28" was kept, as a year that does not exist).
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/openingWdv\.fy must be a financial year like 2026-27/);
    }
    // A value with no year at all is the same slip.
    const noYear = await post('/accounts/fixed-assets', { ...body, openingWdv: { companiesAct: 300000 } });
    expect(noYear.status).toBe(400);
    expect(await mongoose.connection.collection('fixedassets').countDocuments({})).toBe(0);
    // A real year is kept (unchanged), and no opening value at all is fine.
    const ok = await post('/accounts/fixed-assets', { ...body, openingWdv: { fy: '2026-27', companiesAct: 300000 } });
    expect(ok.status).toBe(201);
    expect(ok.body.asset.openingWdv).toMatchObject({ fy: '2026-27', companiesAct: 300000, incomeTax: 300000 });
    expect((await post('/accounts/fixed-assets', { ...body, name: 'New compressor', openingWdv: { fy: '', companiesAct: '' } })).status).toBe(201);
  });

  it('a budget cannot be saved under one', async () => {
    const head = await M.ExpenseCategory.create({ name: 'Power', ledger: 'Power & Fuel' });
    const rows = [{ category: String(head._id), annual: 120000 }];
    for (const fy of ['2026-11', '2026-28']) {
      const res = await put('/accounts/budgets', { fy, rows });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/fy must be like 2026-27/);
    }
    expect(await M.Budget.countDocuments({})).toBe(0);
    expect((await put('/accounts/budgets', { fy: '2026-27', rows })).status).toBe(200);
  });

  it('a register asked for one answers for this year, under this year\'s name', async () => {
    clock('2026-11-20T06:00:00Z');
    // Before: the label was handed back as the year ("2026-11"), over 2026-27's figures.
    expect((await get('/accounts/budgets?fy=2026-11')).body.fy).toBe('2026-27');
    expect((await get('/accounts/fixed-assets?fy=2026-28')).body.fy).toBe('2026-27');
    expect((await get('/accounts/fixed-assets?fy=2025-26')).body.fy).toBe('2025-26');
    // A year sent as a list is not a year: this year's, and as text.
    expect((await get('/accounts/fixed-assets?fy[]=2025-26')).body.fy).toBe('2026-27');
  });
});

describe('days and months by India\'s calendar', () => {
  it('closing stock can be valued today from midnight, not from half past five', async () => {
    clock('2026-11-20T20:00:00Z');            // 01:30 on 21 November in India
    const today = await post('/accounts/closing-stock', { asOf: '2026-11-21' });
    // Before: 400 "Stock cannot be valued on a day that has not come".
    expect(today.body.message).toMatch(/Nothing valued on 2026-11-21/);
    expect(today.status).toBe(409);
    const tomorrow = await post('/accounts/closing-stock', { asOf: '2026-11-22' });
    expect(tomorrow.status).toBe(400);
    expect(tomorrow.body.message).toMatch(/has not come/);
  });

  it('the registers open on this month from its first midnight', async () => {
    clock('2026-11-30T20:00:00Z');            // 01:30 on 1 December in India
    for (const url of ['/accounts/registers/sales', '/accounts/registers/purchase']) {
      const res = await get(url);
      // Before: 1 November to 1 December — last month and a day.
      expect(ymd(new Date(res.body.from))).toBe('2026-12-01');
      expect(ymd(new Date(res.body.to))).toBe('2026-12-01');
    }
    expect((await get('/accounts/cost-centres')).status).toBe(200);
  });

  it('a period that is asked for is the one answered (unchanged)', async () => {
    const res = await get('/accounts/registers/sales?from=2026-10-01&to=2026-10-31');
    expect(ymd(new Date(res.body.from))).toBe('2026-10-01');
    expect(ymd(new Date(res.body.to))).toBe('2026-10-31');
  });
});
