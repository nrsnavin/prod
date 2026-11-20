'use strict';
// ══════════════════════════════════════════════════════════════════
//  APPROVING AN EXPENSE INTO A CLOSED MONTH
//
//  Found reading api/accountsExpenses.js line by line.
//
//  An expense waiting for approval is not in the books: no report counts
//  it, nothing is posted. Its date is checked against the closed period
//  when it is ENTERED — and it can wait. Entered on 28 October, the
//  books closed up to the 31st in November, approved after that: it went
//  into October — its expense, its input credit, the supplier's ledger —
//  through the one door that did not ask whether October was still open.
//  (Cancelling it asks. Paying it asks, for the payment's own date.)
//
//  It is refused like any other entry dated inside the closed period,
//  and an admin can let it through with a reason, which is recorded.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, clerk, other, head, supplier;
const cookie = (u = admin) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const get = (url, u) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u));

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Expense', 'ExpenseCategory', 'Supplier', 'PartyLedgerEntry', 'BooksLockEvent']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'eal@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Meena', email: 'eal-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  other = await M.User.create({ name: 'Ravi', email: 'eal-other@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await get('/accounts/bank-accounts');
  head = await M.ExpenseCategory.create({ name: 'Job work (test)', ledger: 'Job Work', itcEligible: true, approvalAbove: 0 });
  supplier = await M.Supplier.create({ name: 'Sri Dyers', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  await post('/accounts/lock', { lockDate: null, reason: 'Opened again for the next test' });
  for (const name of ['expenses', 'partyledgerentries', 'bookslockevents']) await mongoose.connection.collection(name).deleteMany({});
});

/** An expense entered by Ravi, waiting for approval, on a day the books were open. */
const waiting = async (date) => {
  const res = await post('/accounts/expenses', { category: head._id, supplier: supplier._id, description: 'Dyeing, lot 14', amount: 10000, gstPercent: 5, date }, other);
  expect(res.status).toBe(201);
  expect(res.body.expense.status).toBe('pending');
  return res.body.expense;
};
const closeUpTo = async (day) => expect((await post('/accounts/lock', { lockDate: day })).status).toBe(200);
const inBooks = (e) => M.PartyLedgerEntry.countDocuments({ docType: 'Expense', doc: e._id });

describe('an expense waiting for approval when its month is closed', () => {
  it('is not approved into the closed month', async () => {
    const e = await waiting('2026-10-28');
    await closeUpTo('2026-10-31');
    const res = await post(`/accounts/expenses/${e._id}/approve`, {}, clerk);
    // Before: 200 — October's expenses, input credit and Sri Dyers' ledger changed after the close.
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/books are closed up to 31 Oct 2026/);
    expect((await M.Expense.findById(e._id).lean()).status).toBe('pending');
    expect(await inBooks(e)).toBe(0);
  });

  it('is not approved-and-paid into it either', async () => {
    const e = await waiting('2026-10-28');
    await closeUpTo('2026-10-31');
    const cash = (await get('/accounts/bank-accounts')).body.accounts.find((a) => a.kind === 'cash');
    const res = await post(`/accounts/expenses/${e._id}/approve`, { payNow: { account: cash._id } }, clerk);
    expect(res.status).toBe(409);
    expect((await M.Expense.findById(e._id).lean())).toMatchObject({ status: 'pending', paidAmount: 0 });
  });

  it('an admin can let it through with a reason, and the reason is kept', async () => {
    const e = await waiting('2026-10-28');
    await closeUpTo('2026-10-31');
    expect((await post(`/accounts/expenses/${e._id}/approve`, {})).status).toBe(409);
    const res = await post(`/accounts/expenses/${e._id}/approve`, { lockOverride: 'Bill came late; belongs in October' });
    expect(res.status).toBe(200);
    expect(res.body.expense.status).toBe('approved');
    expect(await inBooks(e)).toBe(1);
    const events = await M.BooksLockEvent.find({ kind: 'override' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'Bill came late; belongs in October' });
    // The clerk's override is not one.
    const e2 = await waiting('2026-11-05');
    await closeUpTo('2026-11-30');
    expect((await post(`/accounts/expenses/${e2._id}/approve`, { lockOverride: 'Bill came late; belongs in November' }, clerk)).status).toBe(409);
  });

  it('can still be rejected: that puts nothing in the books (unchanged)', async () => {
    const e = await waiting('2026-10-28');
    await closeUpTo('2026-10-31');
    const res = await post(`/accounts/expenses/${e._id}/reject`, { reason: 'Duplicate of EXP 14' }, clerk);
    expect(res.status).toBe(200);
    expect(res.body.expense.status).toBe('rejected');
  });

  it('dated after the close, it is approved as before (unchanged)', async () => {
    const e = await waiting('2026-11-03');
    await closeUpTo('2026-10-31');
    const res = await post(`/accounts/expenses/${e._id}/approve`, {}, clerk);
    expect(res.status).toBe(200);
    expect(res.body.expense.status).toBe('approved');
    expect(await inBooks(e)).toBe(1);
  });
});
