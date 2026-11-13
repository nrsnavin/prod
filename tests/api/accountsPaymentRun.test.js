'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE WEEK'S PAYMENT RUN — services/paymentRun.js
//
//    • the bills to pay this week, in order: a micro or small supplier
//      whose days under the MSMED Act run out, then the overdue, then
//      those falling due; each with its TDS off and why it is there
//    • a supplier whose bank account changed lately, or with none on
//      file, held back with the reason
//    • the money: the bank, less what else goes out this week, less what
//      is kept back, or a budget; while a micro supplier's bill is left
//      unpaid for want of money, nothing else is proposed
//    • paid: one bank payment a supplier, through the normal payment
//      door, the run kept; the same request twice pays nobody twice
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const bizDates = require('../../utils/bizDates');

let mongo, app, M, admin, kotak, S = {}, B = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const DAY = 86_400_000;
const daysAgo = (n) => new Date(bizDates.today().getTime() - n * DAY).toISOString().slice(0, 10);
const bankOk = (n) => ({ accountNo: `50100123${n}`, ifsc: 'HDFC0001234', holder: 'x' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'SupplierBill', 'BankAccount', 'Payment', 'PaymentRun', 'RecurringExpense']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'run@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806' } });
  kotak = await M.BankAccount.create({ name: 'Kotak CA', kind: 'bank', accountNo: '761200001', openingBalance: 10_00_000, isDefault: true });

  S.micro = await M.Supplier.create({ name: 'Murugan Covering Works', gstin: '33AAAPM0001F1Z5', pan: 'AAAPM0001F', paymentTermsDays: 60, msme: { category: 'micro', udyam: 'UDYAM-TN-28-0001234', agreedDays: 45 }, bank: bankOk(1) });
  S.over = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0002F1Z5', pan: 'AAAPS0002F', paymentTermsDays: 30, bank: bankOk(2) });
  S.due = await M.Supplier.create({ name: 'Kumar Dyes', gstin: '33AAAPK0003F1Z5', pan: 'AAAPK0003F', paymentTermsDays: 30, bank: bankOk(3) });
  S.later = await M.Supplier.create({ name: 'Lakshmi Packing', gstin: '33AAAPL0004F1Z5', pan: 'AAAPL0004F', paymentTermsDays: 30, bank: bankOk(4) });
  S.changed = await M.Supplier.create({ name: 'Velan Spares', gstin: '33AAAPV0005F1Z5', pan: 'AAAPV0005F', paymentTermsDays: 30,
    bank: { ...bankOk(5), changedAt: new Date(Date.now() - 3 * DAY), changedByName: 'Meena', previousAccountNo: '998877665544' } });
  S.noBank = await M.Supplier.create({ name: 'Anand Tapes', gstin: '33AAAPA0006F1Z5', pan: 'AAAPA0006F', paymentTermsDays: 30 });

  const bill = async (s, no, billDate, rate, extra = {}) => {
    const res = await post('/accounts/bills', { supplier: String(s._id), supplierBillNo: no, billDate, lines: [{ description: 'Goods', quantity: 1, rate, gstPercent: 5 }], ...extra });
    if (res.status !== 201) throw new Error(`bill ${no}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.bill;
  };
  B.micro = await bill(S.micro, 'MC/40', daysAgo(40), 100000);               // 1,05,000; its 45 days end in 5
  B.over = await bill(S.over, 'SY/77', daysAgo(45), 50000, { kind: 'service', tds: { applicable: true, section: '194C', rate: 2 } }); // 52,500, TDS 1,000; 15 days overdue
  B.due = await bill(S.due, 'KD/12', daysAgo(27), 20000);                    // 21,000; due in 3 days
  B.later = await bill(S.later, 'LP/5', daysAgo(5), 10000);                  // 10,500; due in 25 days
  B.changed = await bill(S.changed, 'VS/9', daysAgo(40), 8000);              // 8,400; 10 days overdue
  B.noBank = await bill(S.noBank, 'AT/3', daysAgo(40), 4000);                // 4,200; 10 days overdue
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('the proposal', () => {
  it('in order — the micro supplier\'s days, the overdue, the falling due — each with its TDS off and why; the rest held or later', async () => {
    const res = await get('/accounts/payment-run');
    expect(res.status).toBe(200);
    const r = res.body;
    expect(r.lines.map((l) => l.supplierName)).toEqual(['Murugan Covering Works', 'Sri Yarn Traders', 'Kumar Dyes']);
    expect(r.lines[0]).toMatchObject({ priority: 'msme', msme: 'micro', gross: 105000, tds: 0, cash: 105000 });
    expect(r.lines[0].why).toMatch(/^Micro enterprise: its 45 days under the MSMED Act run out on \d+ \w+\. Paid later, interest runs at three times the bank rate/);
    expect(r.lines[1]).toMatchObject({ priority: 'overdue', gross: 52500, tds: 1000, cash: 51500, why: expect.stringMatching(/^Due on \d+ \w+: 15 days overdue$/) });
    expect(r.lines[1].docs[0]).toMatchObject({ docNo: B.over.billNo, refNo: 'SY/77', section: '194C' });
    expect(r.lines[2]).toMatchObject({ priority: 'due', cash: 21000, why: expect.stringMatching(/^Due on /) });

    const held = Object.fromEntries(r.held.map((h) => [h.supplierName, h.holds.map((x) => `${x.code}:${x.severity}`)]));
    expect(held).toEqual({ 'Velan Spares': ['BANK_CHANGED:confirm'], 'Anand Tapes': ['NO_BANK:danger'] });
    expect(r.held.find((h) => h.supplierName === 'Velan Spares').holds[0].message).toMatch(/changed on .* \(by Meena\), from …5544 to …1235: call them on the number on file/);
    expect(r.later).toEqual({ count: 1, amount: 10500 });
    expect(r.totals).toMatchObject({ suppliers: 3, gross: 178500, tds: 1000, cash: 177500 });
    expect(r.cash).toMatchObject({ bank: 1000000, committed: 0, cushion: 0, spendable: 1000000, limit: 1000000, proposed: 177500, left: 822500, payFrom: { name: 'Kotak CA' } });
    expect(r.msmeShort).toBe(0);
  });

  it('a budget: bills taken in order while it lasts, a smaller one after a bill that does not fit', async () => {
    const r = (await get('/accounts/payment-run?budget=150000')).body;
    expect(r.lines.map((l) => l.supplierName)).toEqual(['Murugan Covering Works', 'Kumar Dyes']);
    expect(r.short.map((l) => [l.supplierName, l.docs[0].reason])).toEqual([['Sri Yarn Traders', 'cash']]);
    expect(r.cash).toMatchObject({ budget: 150000, limit: 150000, proposed: 126000, left: 24000 });
  });

  it('too little for the micro supplier: nothing else is proposed, and how much more is needed is said', async () => {
    const r = (await get('/accounts/payment-run?cushion=900000')).body;
    expect(r.cash).toMatchObject({ cushion: 900000, spendable: 100000, limit: 100000 });
    expect(r.lines).toEqual([]);
    expect(r.msmeShort).toBe(5000);
    expect(r.short.map((l) => [l.supplierName, l.docs[0].reason])).toEqual([['Murugan Covering Works', 'cash'], ['Sri Yarn Traders', 'msme'], ['Kumar Dyes', 'msme']]);
  });

  it('what else goes out this week, from the cash forecast, is set aside first', async () => {
    const rent = await M.RecurringExpense.create({ name: 'Factory rent', category: new mongoose.Types.ObjectId(), description: 'Rent', payeeName: 'Landlord', amount: 900000, nextDate: new Date(bizDates.today().getTime() + 2 * DAY) });
    try {
      const r = (await get('/accounts/payment-run')).body;
      expect(r.cash.commitments).toEqual([expect.objectContaining({ party: 'Landlord', docNo: 'Factory rent', amount: 900000, basis: 'recurring' })]);
      expect(r.cash).toMatchObject({ committed: 900000, spendable: 100000 });
      expect(r.lines).toEqual([]);
      expect(r.msmeShort).toBe(5000);
      // Looking 2 days ahead, the rent is not yet due.
      expect((await get('/accounts/payment-run?horizon=1')).body.cash.committed).toBe(0);
    } finally {
      await M.RecurringExpense.deleteOne({ _id: rent._id });
    }
  });
});

describe('paying the run', () => {
  it('a changed bank account is not paid without a note of how it was confirmed', async () => {
    const res = await post('/accounts/payment-run/pay', { requestId: 'run-0', account: String(kotak._id), suppliers: [String(S.changed._id)] });
    expect(res.status).toBe(201);
    expect(res.body.run).toMatchObject({ status: 'failed', totals: { paid: 0, failed: 1 } });
    expect(res.body.run.lines[0].error).toMatch(/say how you confirmed it to pay/);
    expect(await M.Payment.countDocuments({})).toBe(0);
  });

  it('one bank payment a supplier, through the payment door, the run kept; sent twice, nobody is paid twice', async () => {
    const body = {
      requestId: 'run-1', account: String(kotak._id),
      suppliers: [String(S.micro._id), String(S.over._id), String(S.changed._id), String(S.noBank._id)],
      riskNotes: { [String(S.changed._id)]: 'Called Velan on the number on file; the new account is theirs' },
    };
    const res = await post('/accounts/payment-run/pay', body);
    expect(res.status).toBe(201);
    const run = res.body.run;
    expect(run).toMatchObject({ status: 'partly_paid', accountName: 'Kotak CA', totals: { suppliers: 4, paid: 3, failed: 1, cash: 105000 + 51500 + 8400, tds: 1000 } });
    const by = Object.fromEntries(run.lines.map((l) => [l.supplierName, l]));
    expect(by['Murugan Covering Works']).toMatchObject({ status: 'paid', priority: 'msme', voucherNo: expect.stringMatching(/^PAY\//) });
    expect(by['Anand Tapes']).toMatchObject({ status: 'failed', error: expect.stringMatching(/^No bank account on file/) });
    expect(by['Velan Spares']).toMatchObject({ status: 'paid', riskNote: expect.stringMatching(/^Called Velan/) });

    const pay = await M.Payment.findById(by['Sri Yarn Traders'].payment).lean();
    expect(pay).toMatchObject({ kind: 'payment', mode: 'bank', amount: 51500, requestId: 'run-1:' + String(S.over._id) });
    expect(pay.allocations).toEqual([expect.objectContaining({ docNo: B.over.billNo, amount: 52500, tds: 1000 })]);
    expect(pay.narration).toMatch(/^Payment run of \d+ \w+: Due on/);
    expect((await M.SupplierBill.findById(B.micro._id).lean()).status).toBe('paid');
    expect((await M.SupplierBill.findById(B.over._id).lean()).status).toBe('paid');

    const again = await post('/accounts/payment-run/pay', body);
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(again.body.run._id).toBe(run._id);
    expect(await M.Payment.countDocuments({ status: 'posted' })).toBe(3);

    // What is left for the week, and the run on record.
    const next = (await get('/accounts/payment-run')).body;
    expect(next.lines.map((l) => l.supplierName)).toEqual(['Kumar Dyes']);
    expect(next.held.map((l) => l.supplierName)).toEqual(['Anand Tapes']);
    const runs = (await get('/accounts/payment-runs')).body.runs;
    expect(runs.map((x) => x.requestId)).toEqual(['run-1', 'run-0']);
  });

  it('refused: no request id, a cash account, nobody ticked', async () => {
    const cash = await M.BankAccount.create({ name: 'Cash box', kind: 'cash' });
    expect((await post('/accounts/payment-run/pay', { account: String(kotak._id), suppliers: [String(S.due._id)] })).status).toBe(400);
    expect((await post('/accounts/payment-run/pay', { requestId: 'run-x', account: String(cash._id), suppliers: [String(S.due._id)] })).body.message).toMatch(/not a bank account/);
    expect((await post('/accounts/payment-run/pay', { requestId: 'run-y', account: String(kotak._id), suppliers: [] })).body.message).toMatch(/Tick at least one supplier/);
  });
});
