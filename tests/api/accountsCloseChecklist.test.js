'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT IS LEFT BEFORE A MONTH IS CLOSED, AND WHAT THE BANK WILL NEED
//    services/accountsInsights.js closeChecklist(), forecast(), anomalies()
//
//  • "TDS to deposit" was ticked only for a month with no TDS at all. It
//    asked what was deducted and never what was deposited, so a month
//    whose challan was paid and recorded stayed open for good, and the
//    checklist could not be finished.
//  • The cash forecast had the same blind spot: TDS already deposited
//    was still shown going out on the 7th.
//  • Two bank lines that look alike — the bank charging 5.90 twice in a
//    day — were one line to the checklist: with one of them placed it
//    said "every line is in the books".
//  • A bill dated tomorrow was not flagged as dated in the future (only
//    one dated the day after was).
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, insights, cal;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  insights = require('../../services/accountsInsights');
  cal = require('../../utils/bizDates');
  M = {};
  for (const n of ['User', 'Supplier', 'SupplierBill', 'Payment', 'BankAccount', 'BankStatement', 'TdsChallan']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'close@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
const DAY = 86_400_000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const supplier = async () => { n += 1; return M.Supplier.create({ name: `Sri Dyers ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, pan: 'AAAPS1234F', address: 'Erode' }); };
const bank = async (name = `Bank ${++n}`) => { await get('/accounts/bank-accounts'); return (await post('/accounts/bank-accounts', { name, kind: 'bank' })).body.account; };
/** A dyeing bill of 52,500 paid in full with 2% TDS on 50,000: ₹1,000 deducted on `date`. */
async function tdsOf1000(date) {
  const s = await supplier();
  const acct = await bank();
  const b = await post('/accounts/bills', { supplier: s._id, supplierBillNo: `S/${++n}`, kind: 'service', billDate: date, lines: [{ description: 'Dyeing', quantity: 1, rate: 50000, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 2 } });
  expect(b.status).toBe(201);
  const p = await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s._id, amount: 51500, mode: 'bank', account: acct._id, tds: { section: '194C', rate: 2 }, allocations: [{ docType: 'SupplierBill', doc: b.body.bill._id, amount: 52500 }], date });
  expect(p.status).toBe(201);
}
const challan = (month, amount, over = {}) => post('/accounts/tds/challans', { month, section: '194C', amount, bsrCode: '0510308', challanNo: `00${400 + (++n)}`, depositedOn: iso(Date.now()), ...over });
const item = async (month, key) => (await get(`/accounts/close?month=${month}`)).body.items.find((i) => i.key === key);

describe('TDS to deposit', () => {
  it('is open while it is owed, and done once the challan is recorded', async () => {
    await tdsOf1000('2026-09-20');
    const open = await item('2026-09', 'tds');
    expect(open).toMatchObject({ ok: false, amount: 1000 });
    expect(open.detail).toMatch(/₹1,000 deducted/);
    expect(open.detail).toMatch(/deposit by the 7th/);

    // Part of it paid in: what is left is what is asked for.
    expect((await challan('2026-09', 400)).status).toBe(201);
    const part = await item('2026-09', 'tds');
    expect(part).toMatchObject({ ok: false, amount: 600 });
    expect(part.detail).toMatch(/₹400 of ₹1,000 deposited/);
    expect(part.detail).toMatch(/₹600 still to deposit/);

    // All of it: the month's TDS is done.
    expect((await challan('2026-09', 600)).status).toBe(201);
    const done = await item('2026-09', 'tds');
    expect(done).toMatchObject({ ok: true, amount: 0 });
    expect(done.detail).toMatch(/₹1,000 deducted and deposited/);
  });

  it('a month with none deducted is done, as before', async () => {
    expect(await item('2026-09', 'tds')).toMatchObject({ ok: true, amount: 0, detail: 'No TDS deducted this month' });
  });

  it('a challan for another month does not close this one', async () => {
    await tdsOf1000('2026-09-20');
    expect((await challan('2026-08', 1000)).status).toBe(201);
    expect(await item('2026-09', 'tds')).toMatchObject({ ok: false, amount: 1000 });
  });
});

describe('the cash the next weeks will need', () => {
  const tdsItems = (f) => [...f.weeks.flatMap((w) => w.items)].filter((x) => x.party === 'Income tax (TDS)' && /this month/.test(x.basis));

  it('does not send out TDS that has been deposited', async () => {
    const today = iso(cal.today());
    await tdsOf1000(today);
    expect(tdsItems(await insights.forecast({ weeks: 8 }))).toEqual([expect.objectContaining({ direction: 'out', amount: 1000 })]);
    expect((await challan(cal.monthKey(), 400)).status).toBe(201);
    expect(tdsItems(await insights.forecast({ weeks: 8 }))).toEqual([expect.objectContaining({ direction: 'out', amount: 600 })]);
    expect((await challan(cal.monthKey(), 600)).status).toBe(201);
    expect(tdsItems(await insights.forecast({ weeks: 8 }))).toEqual([]);
  });
});

describe('bank lines placed', () => {
  const line = (index, key, status, over = {}) => ({ index, date: new Date('2026-09-14T00:00:00Z'), narration: key, amount: 5.9, direction: 'out', key, status, ...over });
  const statement = (acct, file, lines) => M.BankStatement.create({ account: acct._id, accountName: acct.name, file, lines });

  it('two lines that look alike are two: one placed leaves one to place', async () => {
    const acct = await bank();
    await statement(acct, 'sep.csv', [line(0, 'SMS CHARGES', 'posted', { occurrence: 1 }), line(1, 'SMS CHARGES', 'unmatched', { occurrence: 2 })]);
    expect(await item('2026-09', 'bank')).toMatchObject({ ok: false, count: 1, amount: 5.9 });
  });

  it('and both of them when neither is placed', async () => {
    const acct = await bank();
    await statement(acct, 'sep.csv', [line(0, 'SMS CHARGES', 'unmatched', { occurrence: 1 }), line(1, 'SMS CHARGES', 'unmatched', { occurrence: 2 })]);
    expect(await item('2026-09', 'bank')).toMatchObject({ ok: false, count: 2, amount: 11.8 });
  });

  it('one line uploaded twice is still one, and placed in either it is placed', async () => {
    const acct = await bank();
    await statement(acct, 'sep.csv', [line(0, 'NEFT SUNRISE', 'unmatched', { amount: 5000, direction: 'in' })]);
    await statement(acct, 'sep-again.csv', [line(0, 'NEFT SUNRISE', 'unmatched', { amount: 5000, direction: 'in' })]);
    expect(await item('2026-09', 'bank')).toMatchObject({ ok: false, count: 1, amount: 5000 });
    await M.BankStatement.updateOne({ file: 'sep-again.csv' }, { $set: { 'lines.0.status': 'posted' } });
    expect(await item('2026-09', 'bank')).toMatchObject({ ok: true, count: 0 });
  });

  it('the same words in two accounts are two lines', async () => {
    const one = await bank('Kotak CA');
    const two = await bank('SBI CA');
    await statement(one, 'kotak.csv', [line(0, 'SMS CHARGES', 'posted')]);
    await statement(two, 'sbi.csv', [line(0, 'SMS CHARGES', 'unmatched')]);
    expect(await item('2026-09', 'bank')).toMatchObject({ ok: false, count: 1, amount: 5.9 });
  });
});

describe('a bill dated in the future', () => {
  it('is flagged from tomorrow, not from the day after', async () => {
    const s = await supplier();
    const check = async (billDate) => (await post('/accounts/bills/check', { supplier: s._id, billDate, lines: [{ description: 'Yarn', quantity: 1, rate: 700 }] })).body.flags.map((f) => f.code);
    expect(await check(iso(cal.today().getTime() + DAY))).toContain('FUTURE_DATE');
    expect(await check(iso(cal.today().getTime() + 5 * DAY))).toContain('FUTURE_DATE');
    expect(await check(iso(cal.today()))).not.toContain('FUTURE_DATE');
    expect(await check(iso(cal.today().getTime() - DAY))).not.toContain('FUTURE_DATE');
  });
});
