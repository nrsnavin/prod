'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH MONTH, WHICH YEAR: THE STATUTORY SCREENS
//
//  Found reading api/accountsStatutory.js line by line.
//
//  1. THE WRONG MONTH'S GSTR-2B TOOK THE RIGHT MONTH'S PLACE. The file
//     the portal gives says which month it is for. The upload was meant
//     to go by that ("the period from the file when it says, else the
//     form") and went by the form first — and the screen always sends
//     its month. September's file, uploaded while looking at October,
//     deleted October's lines, stored September's as October's, and
//     marked October's bills "not in GSTR-2B: ITC waits".
//
//  2. A MONTH WAS ANYTHING SHAPED LIKE ONE. "2026-13" passed: the
//     thirteenth month of 2026 is January 2027, worked out and posted
//     under a label January itself does not use.
//
//  3. A YEAR LIKEWISE ("2026-28", or the month "2026-11"): a TDS
//     certificate or a Form 26AS saved under a year no screen lists.
//
//  4. FORM 26Q OPENED ON A QUARTER OF ONE YEAR IN ANOTHER. With nothing
//     asked, the quarter was the one 45 days ago and the year was
//     today's: in April and May, the last quarter of the year that had
//     only just begun.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const clock = (at) => jest.useFakeTimers({ now: new Date(at), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Gstr2bEntry', 'TdsCertificate', 'TdsChallan', 'StatutoryDeposit', 'Journal']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'stp@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.useRealTimers();
  for (const c of Object.values(mongoose.connection.collections)) if (c.collectionName !== 'users') await c.deleteMany({});
});

// ══════════════════════════════════════════════════════════════════
describe('a GSTR-2B file is filed under the month it says it is for', () => {
  const items = [{ num: 1, rt: 5, txval: 10000, cgst: 250, sgst: 250, igst: 0, cess: 0 }];
  const file = (rtnprd, numbers) => Buffer.from(JSON.stringify({ data: { gstin: '33AAECB1234F1Z5', ...(rtnprd ? { rtnprd } : {}), docdata: { b2b: [{ ctin: '33AAAPS0001F1Z5', trdnm: 'Sri Yarns', inv: numbers.map((inum) => ({ inum, dt: '03-10-2026', val: 10500, pos: '33', rev: 'N', itcavl: 'Y', items })) }] } } }));
  const upload = (buffer, period) => {
    const r = request(app).post('/api/v2/accounts/gstr2b/upload').set('Cookie', cookie());
    if (period) r.field('period', period);
    return r.attach('file', buffer, 'gstr2b.json');
  };

  it('September\'s file, sent while looking at October, is September\'s — and October\'s is left alone', async () => {
    expect((await upload(file('102026', ['OCT-1', 'OCT-2']), '2026-10')).body.period).toBe('2026-10');
    const res = await upload(file('092026', ['SEP-1']), '2026-10');
    expect(res.status).toBe(200);
    // Before: "2026-10" — and October's two lines deleted for September's one.
    expect(res.body.period).toBe('2026-09');
    expect((await M.Gstr2bEntry.find({ period: '2026-10' }).lean()).map((e) => e.number).sort()).toEqual(['OCT-1', 'OCT-2']);
    expect((await M.Gstr2bEntry.find({ period: '2026-09' }).lean()).map((e) => e.number)).toEqual(['SEP-1']);
  });

  it('a file that does not say goes under the month on the form (unchanged)', async () => {
    const res = await upload(file(null, ['X-1']), '2026-10');
    expect(res.status).toBe(200);
    expect(res.body.period).toBe('2026-10');
  });

  it('a file that says, with no month on the form, goes under its own (unchanged)', async () => {
    expect((await upload(file('112026', ['N-1']))).body.period).toBe('2026-11');
  });

  it('a file whose month is no month goes by the form, and with neither it is refused', async () => {
    expect((await upload(file('132026', ['Y-1']), '2026-10')).body.period).toBe('2026-10');
    const neither = await upload(file('132026', ['Y-2']));
    // Before: filed under "2026-13".
    expect(neither.status).toBe(400);
    expect(neither.body.message).toMatch(/which month/);
    const badForm = await upload(file(null, ['Y-3']), '2026-13');
    expect(badForm.status).toBe(400);
    expect(await M.Gstr2bEntry.countDocuments({ period: '2026-13' })).toBe(0);
  });
});

describe('a month is a year and one of its twelve months', () => {
  const id = new mongoose.Types.ObjectId();
  const writers = [
    ['/accounts/gstr2b/reconcile', (m) => ({ period: m })],
    ['/accounts/payroll-books/salary', (m) => ({ month: m })],
    ['/accounts/payroll-books/paid', (m) => ({ month: m })],
    ['/accounts/payroll-books/deposits', (m) => ({ kind: 'pf', month: m, amount: 1800, challanNo: 'PF-1', depositedOn: '2026-11-12' })],
    ['/accounts/tds/challans', (m) => ({ month: m, section: '194C', amount: 500, bsrCode: '0510308', challanNo: '00042', depositedOn: '2026-11-07' })],
    [`/accounts/bills/${id}/itc-reverse`, (m) => ({ month: m })],
  ];

  it.each(writers)('%s refuses the thirteenth month, and month nought', async (url, body) => {
    for (const m of ['2026-13', '2026-00', '2026-27']) {
      const res = await post(url, body(m));
      // Before: taken as a month ("2026-13" is January 2027) — a 409 or a 404 further in, or a row saved under it.
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/must be YYYY-MM/);
    }
    expect(await M.TdsChallan.countDocuments({})).toBe(0);
    expect(await M.StatutoryDeposit.countDocuments({})).toBe(0);
  });

  it('a real month is taken (unchanged)', async () => {
    const dep = await post('/accounts/payroll-books/deposits', { kind: 'pf', month: '2026-10', amount: 1800, challanNo: 'PF-1', depositedOn: '2026-11-12' });
    expect(dep.status).toBe(201);
    const ch = await post('/accounts/tds/challans', { month: '2026-10', section: '194C', amount: 500, bsrCode: '0510308', challanNo: '00042', depositedOn: '2026-11-07' });
    expect(ch.status).toBe(201);
    expect((await get('/accounts/gstr2b/follow-ups?period=2026-10')).status).toBe(200);
    expect((await get('/accounts/gstr2b/follow-ups?period=2026-13')).status).toBe(400);
  });

  it('a screen asked for a month that is not one opens on last month, and says so', async () => {
    clock('2026-11-20T06:00:00Z');
    // Before: each answered for "2026-13" — January 2027, under that name.
    expect((await get('/accounts/gstr1?month=2026-13')).body.month).toBe('2026-10');
    expect((await get('/accounts/tds/register?month=2026-13')).body.month).toBe('2026-10');
    expect((await get('/accounts/payroll-books?month=2026-00')).body.month).toBe('2026-10');
    expect((await get('/accounts/gstr2b?period=2026-13')).body.period).toBe('2026-10');
    expect((await get('/accounts/itc-reversal?month=2026-13')).body.month).toBe('2026-10');
    expect((await get('/accounts/close?month=2026-13')).body.month).toBe('2026-10');
    // One that is asked for is answered (unchanged).
    expect((await get('/accounts/gstr1?month=2026-08')).body.month).toBe('2026-08');
    expect((await get('/accounts/close?month=2026-08')).body.month).toBe('2026-08');
  });
});

describe('a financial year on the statutory screens', () => {
  it('a screen asked for a year that is not one opens on this year, and says so', async () => {
    clock('2026-11-20T06:00:00Z');
    // Before: "2026-28" and the month "2026-11" were handed back as the year.
    expect((await get('/accounts/tds/receivable?fy=2026-28')).body.fy).toBe('2026-27');
    expect((await get('/accounts/tds/194q?fy=2026-11')).body.fy).toBe('2026-27');
    expect((await get('/accounts/tds/certificates?fy=2026-28')).body.fy).toBe('2026-27');
    expect((await get('/accounts/msme/year-end?fy=2026-11')).body.fy).toBe('2026-27');
    expect((await get('/accounts/tds/receivable?fy=2025-26')).body.fy).toBe('2025-26');
  });

  it('a certificate is not filed under a year that is not one', async () => {
    clock('2026-11-20T06:00:00Z');
    const customer = await M.Customer.create({ name: 'Apex Garments', contactName: 'R', phoneNumber: '9300000001', paymentTerms: '30' });
    const body = { kind: 'received', party: String(customer._id), quarter: 'Q2', certNo: 'ABCD123', section: '194Q', amount: 250 };
    const bad = await post('/accounts/tds/certificates', { ...body, fy: '2025-27' });
    // Before: 201, filed under "2025-27" — a year no screen lists.
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/fy must be like 2026-27/);
    expect(await M.TdsCertificate.countDocuments({})).toBe(0);
    // With none given it is this year's (unchanged), and one given is the one kept.
    expect((await post('/accounts/tds/certificates', body)).body.certificate.fy).toBe('2026-27');
    expect((await post('/accounts/tds/certificates', { ...body, certNo: 'ABCD124', fy: '2025-26' })).body.certificate.fy).toBe('2025-26');
  });

  it('a Form 26AS is not stored under a year that is not one', async () => {
    const csv = Buffer.from('Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid/Credited,Tax Deducted,TDS Deposited\nAPEX GARMENTS,CHEA12345B,194Q,15-Sep-2026,100000,100,100\n');
    const res = await request(app).post('/api/v2/accounts/tds/26as').set('Cookie', cookie()).field('fy', '2026-28').attach('file', csv, '26as.csv');
    // Before: 200 — stored under "2026-28", where no screen would show it.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fy must be like 2026-27/);
  });
});

describe('Form 26Q with nothing asked', () => {
  it('opens on the quarter just ended, in the year that quarter belongs to', async () => {
    clock('2027-04-20T06:00:00Z');            // the return for January–March 2027 is due in May
    const res = await get('/accounts/tds/26q');
    expect(res.status).toBe(200);
    expect(res.body.quarter).toBe('Q4');
    // Before: "2027-28" — January to March 2028.
    expect(res.body.fy).toBe('2026-27');
    expect(new Date(res.body.from).toISOString().slice(0, 10)).toBe('2027-01-01');
  });

  it('a quarter asked for is of this year unless a year is asked for too (unchanged)', async () => {
    clock('2027-04-20T06:00:00Z');
    expect((await get('/accounts/tds/26q?q=Q1')).body).toMatchObject({ fy: '2027-28', quarter: 'Q1' });
    expect((await get('/accounts/tds/26q?fy=2026-27&q=Q3')).body).toMatchObject({ fy: '2026-27', quarter: 'Q3' });
  });
});
