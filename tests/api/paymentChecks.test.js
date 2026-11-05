'use strict';
// ══════════════════════════════════════════════════════════════════
//  BEFORE MONEY GOES OUT — services/paymentChecks.js
//
//    • a supplier's bank account change is kept: when, by whom, from what
//    • a payment to them within 30 days, or to an account shared with
//      another supplier, is stopped until someone says how they confirmed
//      it; the note goes on the voucher
//    • warnings: the same amount twice in a week, three times the usual,
//      more than is due, a big first payment, a payee named like a
//      supplier, the same person entering and paying a large bill
//    • a payment recorded from the bank statement is never stopped
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, clerk;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  post: (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body),
  put: (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie(u)).send(body),
});
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'Payment', 'BankAccount']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'pc@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Meena', email: 'pc2@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await as(admin).put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
const supplier = async (over = {}) => { n += 1; return M.Supplier.create({ name: `Sri Yarn Traders ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode', phoneNumber: '9840000000', ...over }); };
const bank = () => M.BankAccount.create({ name: `Kotak ${++n}`, kind: 'bank', accountNo: `7612${n}`, openingBalance: 10_00_000 });
const pay = (u, s, acct, amount, extra = {}) => as(u).post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: String(s._id), amount, mode: 'bank', account: String(acct._id), date: iso(Date.now()), allocations: [], narration: 'advance', ...extra });
const check = async (u, body) => (await as(u).post('/accounts/payments/check', body)).body.flags;

describe('a supplier\'s bank account', () => {
  it('kept with when it changed, by whom and from what; checked as it is typed', async () => {
    const s = await supplier();
    expect((await as(admin).put('/supplier/edit-supplier', { _id: String(s._id), bank: { accountNo: '5010 0123 4567', ifsc: 'hdfc0001234', holder: 'Sri Yarn Traders' } })).status).toBe(200);
    let doc = await M.Supplier.findById(s._id).lean();
    expect(doc.bank).toMatchObject({ accountNo: '501001234567', ifsc: 'HDFC0001234', changedAt: null });
    expect((await as(admin).put('/supplier/edit-supplier', { _id: String(s._id), bank: { accountNo: '9988776655', ifsc: 'ICIC0000999' } })).status).toBe(200);
    doc = await M.Supplier.findById(s._id).lean();
    expect(doc.bank).toMatchObject({ accountNo: '9988776655', previousAccountNo: '501001234567', changedByName: 'Owner' });
    expect(doc.bank.changedAt).toBeTruthy();
    expect((await as(admin).put('/supplier/edit-supplier', { _id: String(s._id), bank: { accountNo: '12ab', ifsc: 'X' } })).status).toBe(400);
  });
});

describe('a payment the checks stop', () => {
  it('to an account changed in the last 30 days: refused until someone says how they confirmed it', async () => {
    const s = await supplier({ bank: { accountNo: '9988776655', ifsc: 'ICIC0000999', changedAt: new Date(Date.now() - 3 * DAY), changedByName: 'Meena', previousAccountNo: '501001234567' } });
    const acct = await bank();
    const flags = await check(admin, { kind: 'payment', partyType: 'supplier', supplier: String(s._id), amount: 50000 });
    expect(flags.find((f) => f.code === 'BANK_CHANGED')).toMatchObject({ severity: 'danger', message: expect.stringMatching(/changed on .* by Meena \(was …4567, now …6655\) — call them on the number on file/) });

    const stopped = await pay(admin, s, acct, 50000);
    expect(stopped.status).toBe(409);
    expect(stopped.body.code).toBe('PAYMENT_RISK');
    expect((await pay(admin, s, acct, 50000, { confirmRisk: true, riskNote: 'ok' })).status).toBe(409);
    const ok = await pay(admin, s, acct, 50000, { confirmRisk: true, riskNote: 'Called Mr. Raju on 98400 00000; he confirmed the new ICICI account' });
    expect(ok.status).toBe(201);
    expect(ok.body.payment.risk).toEqual({ flags: ['BANK_CHANGED'], note: 'Called Mr. Raju on 98400 00000; he confirmed the new ICICI account', byName: 'Owner' });
    // Recorded from the bank statement, the money has left: never stopped.
    expect((await pay(admin, s, acct, 1234, { source: 'statement' })).status).toBe(201);
  });

  it('to an account another supplier has on file', async () => {
    const a = await supplier({ bank: { accountNo: '1122334455', ifsc: 'SBIN0000001' } });
    await supplier({ name: 'Other Mills', bank: { accountNo: '1122334455', ifsc: 'SBIN0000001' } });
    const flags = await check(admin, { kind: 'payment', partyType: 'supplier', supplier: String(a._id), amount: 1000 });
    expect(flags.find((f) => f.code === 'SHARED_ACCOUNT').message).toMatch(/also on file for Other Mills/);
    expect((await pay(admin, a, await bank(), 1000)).status).toBe(409);
  });
});

describe('warnings', () => {
  it('the same amount twice in a week, three times the usual, more than is due, a big first payment', async () => {
    const s = await supplier();
    const acct = await bank();
    for (const amt of [10000, 12000, 9000]) expect((await pay(admin, s, acct, amt)).status).toBe(201);
    const flags = await check(admin, { kind: 'payment', partyType: 'supplier', supplier: String(s._id), amount: 9000, allocations: [] });
    expect(flags.map((f) => f.code)).toEqual(expect.arrayContaining(['DUPLICATE', 'NOTHING_DUE']));
    expect(flags.find((f) => f.code === 'DUPLICATE').message).toMatch(/₹9,000 was paid to .* — the same payment twice\?/);
    const big = await check(admin, { kind: 'payment', partyType: 'supplier', supplier: String(s._id), amount: 150000 });
    expect(big.map((f) => f.code)).toEqual(expect.arrayContaining(['UNUSUAL_AMOUNT', 'NEW_SUPPLIER']));
    // Warnings never stop it.
    expect((await pay(admin, s, acct, 150000)).status).toBe(201);
  });

  it('a payee named like a supplier, and the same hands entering and paying a large bill', async () => {
    const s = await supplier({ name: 'Sri Murugan Textiles' });
    const look = await check(admin, { kind: 'payment', partyType: 'other', partyName: 'Sri Murugan Textile', amount: 5000 });
    expect(look.find((f) => f.code === 'LOOKALIKE_PAYEE').message).toMatch(/nearly Sri Murugan Textiles, a supplier on file/);
    expect(await check(admin, { kind: 'payment', partyType: 'other', partyName: 'TNEB', amount: 5000 })).toEqual([]);

    const bill = (await as(clerk).post('/accounts/bills', { supplier: String(s._id), supplierBillNo: 'SMT/1', lines: [{ description: 'Yarn', quantity: 1, rate: 250000, gstPercent: 0 }] })).body.bill;
    const flags = await check(clerk, { kind: 'payment', partyType: 'supplier', supplier: String(s._id), amount: 250000, allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 250000 }] });
    expect(flags.find((f) => f.code === 'SAME_HANDS').message).toMatch(/You entered the bill this pays/);
    expect((await check(admin, { kind: 'payment', partyType: 'supplier', supplier: String(s._id), amount: 250000, allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 250000 }] })).map((f) => f.code)).not.toContain('SAME_HANDS');
  });
});
