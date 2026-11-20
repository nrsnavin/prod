'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE ACCOUNTS INBOX: WHAT ITS FIGURES ARE FIGURES OF
//
//  Found reading api/accountsInsights.js line by line.
//
//  1. "CHEQUES TO DEPOSIT" ADDED IN THE CHEQUES WE ISSUED. Every held
//     cheque whose date had come was listed — a post-dated cheque given
//     to a supplier is "held" until its date too. The box's amount was
//     money to bank plus money about to leave, under one heading.
//
//  2. THE COUNTS WERE THE LENGTH OF THE PAGE READ. Each box read its
//     first 20 or 50 rows and counted those: thirty claims waiting to be
//     paid back read "20", for the amount of twenty.
//
//  3. TWO BANK LINES THAT LOOK ALIKE WERE ONE. A line was known by its
//     date, amount and wording alone. Two charges of 5.90 on one day —
//     one placed, one not — counted as nothing left to place; the same
//     line on two accounts counted once.
//
//  4. A RECURRING EXPENSE COULD BE POINTED AT A HEAD THAT IS NOT THERE
//     when edited (adding one checks), and saved with no name.
//
//  5. "/export/constructor" was a crash, not "nothing called that".
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, clerk, bank, kotak;
const cookie = (u = admin) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const get  = (url, u) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u));
const post = (url, body, u) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const put  = (url, body, u) => request(app).put(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const inbox = async (u) => (await get('/accounts/inbox', u)).body;
const DAY = 86_400_000;
/** India's day `n` days from today, as the books keep a day. */
const day = (n) => new Date(`${new Date(Date.now() + n * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}T00:00:00Z`);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Expense', 'Payment', 'BankAccount', 'BankStatement', 'ExpenseCategory', 'RecurringExpense']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'aif@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Clerk', email: 'aif-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await get('/accounts/bank-accounts');       // seeds the accounts
  bank = await M.BankAccount.findOne({ kind: { $ne: 'cash' } }) || await M.BankAccount.create({ name: 'HDFC CA', kind: 'bank', active: true });
  kotak = await M.BankAccount.create({ name: 'Kotak CA', kind: 'bank', active: true });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const name of ['expenses', 'payments', 'bankstatements', 'recurringexpenses']) await mongoose.connection.collection(name).deleteMany({});
});

let seq = 0;
const cheque = (kind, on, amount) => {
  seq += 1;
  return { kind, status: 'posted', voucherNo: `${kind === 'receipt' ? 'RCT' : 'PAY'}/T/${seq}`, partyName: kind === 'receipt' ? `Customer ${seq}` : `Supplier ${seq}`, partyType: 'other', amount, mode: 'cheque', account: bank._id, accountName: bank.name, date: day(-5), cheque: { number: String(100000 + seq), bank: 'SBI', date: on, status: 'held', receivedOn: day(-5) }, allocations: [], adjustments: [], createdAt: new Date(), updatedAt: new Date() };
};
const expense = (over) => {
  seq += 1;
  return { expenseNo: `EXP/T/${seq}`, date: day(-3), categoryName: 'Travel', description: `Bus fare ${seq}`, payeeName: 'Ravi', status: 'pending', totals: { taxable: 100, tax: 0, grand: 100 }, paidAmount: 0, source: 'manual', lines: [], createdAt: new Date(), updatedAt: new Date(), ...over };
};

// ══════════════════════════════════════════════════════════════════
describe('cheques to deposit', () => {
  it('are the cheques received — all of them, not the first twenty, and not the ones we issued', async () => {
    await M.Payment.collection.insertMany([
      ...Array.from({ length: 25 }, () => cheque('receipt', day(-1), 1000)),      // their date has come
      cheque('receipt', day(3), 5000),                                           // comes this week
      cheque('receipt', day(30), 7777),                                          // not yet
      cheque('payment', day(2), 40000),                                          // ours, given post-dated
      cheque('payment', day(20), 9999),                                          // ours, weeks away
    ]);

    const box = (await inbox()).chequesDue;
    // Before: count 20, and the 40,000 we issued in the amount.
    expect(box.count).toBe(26);
    expect(box.amount).toBe(30000);
    expect(box.overdue).toBe(25);
    expect(box.top).toHaveLength(6);
    expect(box.top.every((c) => c.kind === 'receipt')).toBe(true);
  });

  it('say separately which of our own cheques fall due, so the bank is ready for them', async () => {
    await M.Payment.collection.insertMany([cheque('receipt', day(1), 5000), cheque('payment', day(2), 40000), cheque('payment', day(4), 12000), cheque('payment', day(20), 9999)]);
    const box = (await inbox()).chequesDue;
    expect(box).toMatchObject({ count: 1, amount: 5000 });
    expect(box.issued).toMatchObject({ count: 2, amount: 52000 });
    expect(box.issued.top.map((c) => c.amount)).toEqual([40000, 12000]);
    expect(box.issued.top.every((c) => c.kind === 'payment')).toBe(true);
  });

  it('are none when there are none (unchanged)', async () => {
    const box = (await inbox()).chequesDue;
    expect(box).toMatchObject({ count: 0, amount: 0, overdue: 0, top: [] });
    expect(box.issued).toMatchObject({ count: 0, amount: 0, top: [] });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what waits to be approved, and to be paid back', () => {
  it('counts every claim waiting to be paid, for what is still owed on each', async () => {
    await M.Expense.collection.insertMany(Array.from({ length: 30 }, () => expense({ status: 'approved', source: 'claim', totals: { taxable: 500, tax: 0, grand: 500 }, paidAmount: 100 })));
    const box = (await inbox()).claimsToPay;
    // Before: 20, ₹8,000.
    expect(box.count).toBe(30);
    expect(box.amount).toBe(12000);
    expect(box.top).toHaveLength(6);
  });

  it('counts every expense waiting for a decision', async () => {
    const someone = new mongoose.Types.ObjectId();
    await M.Expense.collection.insertMany([
      ...Array.from({ length: 60 }, () => expense({ submittedBy: someone })),
      ...Array.from({ length: 5 }, () => expense({ submittedBy: clerk._id })),
    ]);
    // Before: 50 and ₹5,000 for both.
    expect((await inbox()).approvals).toMatchObject({ count: 65, amount: 6500 });
    // A clerk does not approve their own (unchanged): theirs are left out of the count too.
    expect((await inbox(clerk)).approvals).toMatchObject({ count: 60, amount: 6000 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('bank lines still to place', () => {
  const line = (index, key, status, amount, occurrence = 1) => ({ index, date: new Date(), narration: key, amount, direction: 'out', key, occurrence, status });

  it('counts the second of two lines that look alike', async () => {
    // Two charges of 5.90 on one day: the bank's first is in the books, its second is not.
    await M.BankStatement.create({ account: bank._id, accountName: bank.name, file: 'nov.csv', lines: [line(0, 'chg-590', 'recorded', 5.9, 1), line(1, 'chg-590', 'unmatched', 5.9, 2), line(2, 'rent', 'posted', 25000)] });
    // Before: 0 — the wording was "placed".
    expect((await inbox()).bankLines).toMatchObject({ count: 1, amount: 5.9 });
  });

  it('counts the same wording on two accounts as two lines', async () => {
    await M.BankStatement.create({ account: bank._id, accountName: bank.name, file: 'a.csv', lines: [line(0, 'neft-1000', 'unmatched', 1000)] });
    await M.BankStatement.create({ account: kotak._id, accountName: kotak.name, file: 'b.csv', lines: [line(0, 'neft-1000', 'unmatched', 1000)] });
    // Before: 1.
    expect((await inbox()).bankLines).toMatchObject({ count: 2, amount: 2000 });
  });

  it('still counts a line once when the same statement is uploaded again (unchanged)', async () => {
    await M.BankStatement.create({ account: bank._id, accountName: bank.name, file: 'a.csv', lines: [line(0, 'neft-1000', 'unmatched', 1000), line(1, 'upi-50', 'recorded', 50)] });
    await M.BankStatement.create({ account: bank._id, accountName: bank.name, file: 'a-again.csv', lines: [line(0, 'neft-1000', 'unmatched', 1000), line(1, 'upi-50', 'unmatched', 50)] });
    expect((await inbox()).bankLines).toMatchObject({ count: 1, amount: 1000 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a recurring expense, edited', () => {
  const make = async () => {
    await get('/accounts/categories');
    const head = await M.ExpenseCategory.findOne({});
    const res = await post('/accounts/recurring', { name: 'Shed rent', category: String(head._id), description: 'Rent for the shed', amount: 25000, nextDate: day(10).toISOString().slice(0, 10), every: 1 });
    expect(res.status).toBe(201);
    return { row: res.body.row, head };
  };

  it('is not pointed at a head that is not there', async () => {
    const { row, head } = await make();
    const res = await put(`/accounts/recurring/${row._id}`, { category: String(new mongoose.Types.ObjectId()) });
    // Before: 200 — and next month's expense drafted under no head.
    expect(res.status).toBe(404);
    expect(String((await M.RecurringExpense.findById(row._id).lean()).category)).toBe(String(head._id));
  });

  it('keeps a name and a description', async () => {
    const { row } = await make();
    expect((await put(`/accounts/recurring/${row._id}`, { name: '   ' })).status).toBe(400);
    expect((await put(`/accounts/recurring/${row._id}`, { description: '' })).status).toBe(400);
    expect((await M.RecurringExpense.findById(row._id).lean()).name).toBe('Shed rent');
  });

  it('takes the changes that are right (unchanged)', async () => {
    const { row } = await make();
    const res = await put(`/accounts/recurring/${row._id}`, { name: 'Shed rent (new)', amount: 27500, active: false });
    expect(res.status).toBe(200);
    expect(res.body.row).toMatchObject({ name: 'Shed rent (new)', amount: 27500, active: false });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('asking for something that is not there', () => {
  it('an export that does not exist is "nothing called that", whatever it is called', async () => {
    for (const what of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nothing']) {
      // Before: a 500 for the first four.
      expect((await get(`/accounts/export/${what}`)).status).toBe(404);
    }
  });

  it('a refund from a kind of credit that does not exist is refused, not a crash', async () => {
    const Customer = require('../../models/Customer.js');
    const c = await Customer.create({ name: 'Sunrise Garments', contactName: 'R', phoneNumber: '9840099001' });
    const res = await post('/accounts/payments', { kind: 'payment', partyType: 'customer', customer: String(c._id), amount: 500, mode: 'bank', account: String(bank._id), refunds: [{ sourceType: 'constructor', id: String(new mongoose.Types.ObjectId()), amount: 500 }] });
    // Before: 500.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sourceType must be/);
  });
});
