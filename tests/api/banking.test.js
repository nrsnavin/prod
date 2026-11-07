'use strict';
// ══════════════════════════════════════════════════════════════════
//  BANKING
//
//    • every account at a glance: its balance, the cheques in hand and
//      the cheques issued not yet cleared, what the bank has not shown
//    • a credit card is an account, spent on by card; its bill is paid
//      by a transfer from the bank
//    • cheques in hand and cash from the cash box go to the bank as one
//      deposit slip: each cheque held → deposited (moved into that bank
//      if it was entered against another), the cash as a contra
//    • a post-dated cheque, a cheque already deposited, more cash than
//      the box holds, or a deposit into the cash box: refused
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
const ok = async (p, status = 201) => { const r = await p; if (r.status !== status) throw new Error(`${r.request.method} ${r.request.url} → ${r.status} ${r.body.message}`); return r.body; };
const binary = (res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

let kotak, sbi, cash, card, customer, supplier;
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Payment', 'Contra', 'DepositSlip', 'BankAccount']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'bank@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await get('/accounts/bank-accounts');
  cash = (await get('/accounts/bank-accounts')).body.accounts.find((a) => a.kind === 'cash');
  kotak = (await ok(post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', bankName: 'Kotak Mahindra Bank', accountNo: '7612149219', ifsc: 'KKBK0000492', openingBalance: 100000, isDefault: true }))).account;
  sbi = (await ok(post('/accounts/bank-accounts', { name: 'SBI CC', kind: 'bank', openingBalance: 0 }))).account;
  card = (await ok(post('/accounts/bank-accounts', { name: 'HDFC Corporate Card', kind: 'card', bankName: 'HDFC' }))).account;
  customer = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', phoneNumber: '9840011111', gstin: '33AAEPS1001F1Z2' });
  supplier = await M.Supplier.create({ name: 'Amazon Business', gstin: '33AAAPA0001F1Z5', address: 'Chennai', phoneNumber: '9840000000' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const today = iso(Date.now());
const chequeIn = (amount, extra = {}, cheque = {}) => ok(post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount, mode: 'cheque', account: kotak._id, date: today, cheque: { number: String(100000 + amount), bank: 'Indian Bank', ...cheque }, ...extra }));

describe('a credit card account', () => {
  it('is spent on by card only; its bill is a transfer from the bank', async () => {
    const spend = (mode, account) => post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: supplier._id, amount: 4720, mode, account, date: today, narration: 'Printer toner' });
    expect((await spend('bank', card._id)).body.message).toMatch(/is a credit card — what is paid on it is paid by card/);
    expect((await spend('card', cash._id)).body.message).toMatch(/is the cash box/);
    await ok(spend('card', card._id));
    const pay = await ok(post('/accounts/contras', { from: kotak._id, to: card._id, amount: 4720, date: today, narration: 'HDFC card bill' }));
    expect(pay.contra.toName).toBe('HDFC Corporate Card');
    const b = (await ok(get('/accounts/banking'), 200));
    expect(b.accounts.find((a) => a.name === 'HDFC Corporate Card').balance).toBe(0);
  });
});

describe('deposits', () => {
  it('cheques in hand and cash go in on one slip; the books show where each went', async () => {
    const a = (await chequeIn(25000)).payment;
    const c2 = (await chequeIn(12500, { account: sbi._id })).payment;   // entered against SBI, deposited into Kotak
    const later = (await chequeIn(8000, {}, { date: iso(Date.now() + 10 * DAY) })).payment;
    await ok(post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 30000, mode: 'cash', account: cash._id, date: today }));

    let b = await ok(get('/accounts/banking'), 200);
    expect(b.inHand.map((c) => [c.voucherNo, c.amount, c.due])).toEqual([[a.voucherNo, 25000, true], [c2.voucherNo, 12500, true], [later.voucherNo, 8000, false]]);
    expect(b.totals.chequesInHand).toBe(45500);
    expect(b.accounts.find((x) => x.name === 'Kotak CA').chequesInHand).toEqual({ count: 2, amount: 33000 });

    // Refused: into the cash box; a post-dated cheque; more cash than the box has; nothing at all.
    expect((await post('/accounts/deposits', { account: cash._id, cheques: [a._id] })).body.message).toMatch(/is not a bank account/);
    expect((await post('/accounts/deposits', { account: kotak._id, date: today, cheques: [later._id] })).body.message).toMatch(/the bank will not take it before then/);
    expect((await post('/accounts/deposits', { account: kotak._id, date: today, cash: 50000, cashFrom: cash._id })).body.message).toMatch(/has only ₹30000.00 on that day/);
    expect((await post('/accounts/deposits', { account: kotak._id, date: today })).body.message).toMatch(/Pick the cheques, or enter the cash/);

    const kotakBefore = b.accounts.find((x) => x.name === 'Kotak CA').balance;
    const slip = (await ok(post('/accounts/deposits', { account: kotak._id, date: today, cheques: [a._id, c2._id], cash: 20000, cashFrom: cash._id, bankSlipNo: '448812' }))).slip;
    expect(slip).toMatchObject({ slipNo: expect.stringMatching(/^DEP\/\d{4}-\d{2}\/0001$/), accountName: 'Kotak CA', cash: 20000, total: 57500, bankSlipNo: '448812' });
    expect(slip.cheques.map((c) => [c.voucherNo, c.amount])).toEqual([[a.voucherNo, 25000], [c2.voucherNo, 12500]]);
    // Each cheque deposited, on the slip; the one entered against SBI now in Kotak.
    expect((await M.Payment.findById(a._id).lean()).cheque).toMatchObject({ status: 'deposited', slipNo: slip.slipNo });
    expect(await M.Payment.findById(c2._id).lean()).toMatchObject({ accountName: 'Kotak CA', cheque: { status: 'deposited' } });
    // The cash as a contra from the box.
    expect(await M.Contra.findById(slip.contra).lean()).toMatchObject({ fromName: 'Cash box', toName: 'Kotak CA', amount: 20000, reference: slip.slipNo });

    b = await ok(get('/accounts/banking'), 200);
    expect(b.inHand.map((c) => c.voucherNo)).toEqual([later.voucherNo]);
    // Kotak: + the SBI cheque moved in + the cash; its own cheque was already in its books.
    expect(b.accounts.find((x) => x.name === 'Kotak CA').balance).toBe(kotakBefore + 12500 + 20000);
    expect(b.accounts.find((x) => x.name === 'SBI CC').balance).toBe(0);
    expect(b.totals.cash).toBe(10000);

    // Already deposited: refused.
    expect((await post('/accounts/deposits', { account: kotak._id, date: today, cheques: [a._id] })).status).toBe(409);
    // The slip to hand in.
    const pdf = await get(`/accounts/deposits/${slip._id}/pdf`).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    const list = await ok(get('/accounts/deposits'), 200);
    expect(list.slips.map((s) => s.slipNo)).toEqual([slip.slipNo]);
  });

  it('shows the cheques we issued not yet cleared, and what the bank has not shown yet', async () => {
    await ok(post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: supplier._id, amount: 9000, mode: 'cheque', account: kotak._id, date: today, cheque: { number: '000451' } }));
    const b = await ok(get('/accounts/banking'), 200);
    const k = b.accounts.find((x) => x.name === 'Kotak CA');
    expect(k.chequesIssued).toEqual({ count: 1, amount: 9000 });
    expect(k.notOnStatement).toBeGreaterThan(0);
    expect(b.accounts.find((x) => x.kind === 'cash').notOnStatement).toBe(0);
  });
});
