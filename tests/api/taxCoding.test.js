'use strict';
// ══════════════════════════════════════════════════════════════════
//  GST AND TDS CODING — services/taxCoding.js, via POST /accounts/bills/check
//
//  Warnings before a bill is saved: a rate that is no GST rate, a goods
//  line with no HSN, an HSN at a rate our own books seldom used, input
//  credit with no GSTIN or on what s.17(5) blocks, freight without
//  reverse charge, TDS due past the threshold, an odd TDS rate, no PAN.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const codes = async (body) => (await post('/accounts/bills/check', body)).body.flags.map((f) => f.code);
const flag = async (body, code) => (await post('/accounts/bills/check', body)).body.flags.find((f) => f.code === code);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'ExpenseCategory']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'tc@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

const today = new Date().toISOString().slice(0, 10);
const line = (over = {}) => ({ description: 'Nylon 70D', hsn: '5402', quantity: 10, rate: 300, gstPercent: 5, ...over });

describe('GST coding', () => {
  it('flags a rate that is no GST rate, and a goods line with no HSN', async () => {
    const s = await M.Supplier.create({ name: 'Sri Yarn', gstin: '33AAAPS0001F1Z5', address: 'Erode', pan: 'AAAPS0001F' });
    const out = await codes({ supplier: String(s._id), billDate: today, kind: 'goods', lines: [line({ gstPercent: 7 }), line({ hsn: '' })] });
    expect(out).toEqual(expect.arrayContaining(['GST_RATE_ODD', 'HSN_MISSING']));
    expect(await codes({ supplier: String(s._id), billDate: today, kind: 'goods', lines: [line()] })).toEqual([]);
  });

  it('learns each HSN\'s usual rate from our own bills, and flags one off it', async () => {
    const s = await M.Supplier.create({ name: 'Sri Yarn', gstin: '33AAAPS0001F1Z5', address: 'Erode', pan: 'AAAPS0001F' });
    for (let i = 0; i < 4; i++) {
      expect((await post('/accounts/bills', { supplier: String(s._id), supplierBillNo: `SY/${i}`, billDate: today, lines: [line({ rate: 300 + i })] })).status).toBe(201);
    }
    const f = await flag({ supplier: String(s._id), billDate: today, kind: 'goods', lines: [line({ gstPercent: 18 })] }, 'HSN_RATE_UNUSUAL');
    expect(f.message).toMatch(/HSN 5402 has been billed at 5% on 4 of 4 past lines; Nylon 70D says 18%/);
  });

  it('flags input credit with no GSTIN on file, and on what s.17(5) blocks', async () => {
    const noGstin = await M.Supplier.create({ name: 'Local Shop', address: 'Tiruppur' });
    expect(await codes({ supplier: String(noGstin._id), billDate: today, kind: 'service', lines: [line({ hsn: '', description: 'Repairs' })], itcEligible: true })).toContain('NO_GSTIN_ITC');
    const cat = await M.ExpenseCategory.create({ name: 'Canteen' });
    const s = await M.Supplier.create({ name: 'Annapoorna Caterers', gstin: '33AAAPA0002F1Z5', address: 'Tiruppur', pan: 'AAAPA0002F' });
    const f = await flag({ supplier: String(s._id), billDate: today, kind: 'service', category: String(cat._id), lines: [line({ hsn: '', description: 'Lunch for staff', gstPercent: 5 })], itcEligible: true }, 'ITC_BLOCKED');
    expect(f.message).toMatch(/Input credit on canteen is blocked \(CGST s\.17\(5\)\)/);
    expect(await codes({ supplier: String(s._id), billDate: today, kind: 'service', category: String(cat._id), lines: [line({ hsn: '', description: 'Lunch' })], itcEligible: false })).not.toContain('ITC_BLOCKED');
  });

  it('flags freight from a transporter charging no GST without reverse charge', async () => {
    const s = await M.Supplier.create({ name: 'KPN Transports', gstin: '33AAAPK0003F1Z5', address: 'Erode', pan: 'AAAPK0003F' });
    const body = { supplier: String(s._id), billDate: today, kind: 'service', lines: [{ description: 'Lorry freight Erode–Tiruppur', quantity: 1, rate: 4000, gstPercent: 0 }] };
    expect(await codes(body)).toContain('RCM_LIKELY');
    expect(await codes({ ...body, reverseCharge: true })).not.toContain('RCM_LIKELY');
  });
});

describe('TDS coding', () => {
  it('says TDS is due once a contractor passes the threshold, by the bill or by the year', async () => {
    const s = await M.Supplier.create({ name: 'Sakthi Dyeing', gstin: '33AAAPS0004F1Z5', address: 'Tiruppur' });
    const dye = (rate) => ({ supplier: String(s._id), billDate: today, kind: 'service', lines: [{ description: 'Dyeing job work', quantity: 1, rate, gstPercent: 5 }] });
    expect(await codes(dye(20_000))).not.toContain('TDS_DUE');
    const one = await flag(dye(35_000), 'TDS_DUE');
    expect(one.message).toMatch(/TDS under 194C \(contract work.*this bill is ₹35,000, over ₹30,000 — deduct it \(and add their PAN: without one it is 20%\)/);
    // Three bills of ₹25,000 this year, and a fourth: ₹1,00,000 passed.
    for (let i = 0; i < 3; i++) expect((await post('/accounts/bills', { ...dye(25_000), supplierBillNo: `SD/${i}` })).status).toBe(201);
    expect((await flag(dye(25_001), 'TDS_DUE')).message).toMatch(/₹1,00,001 from Sakthi Dyeing this year with this bill, over ₹1,00,000/);
  });

  it('flags a rate the section does not use, and no PAN', async () => {
    const s = await M.Supplier.create({ name: 'R. Kumar & Co', gstin: '33AAAPR0005F1Z5', address: 'Coimbatore' });
    const out = await codes({ supplier: String(s._id), billDate: today, kind: 'service', lines: [{ description: 'Audit fees', quantity: 1, rate: 60_000, gstPercent: 18 }], tds: { applicable: true, section: '194J', rate: 5 } });
    expect(out).toEqual(expect.arrayContaining(['TDS_RATE_ODD', 'NO_PAN']));
    await M.Supplier.updateOne({ _id: s._id }, { pan: 'AAAPR0005F' });
    expect(await codes({ supplier: String(s._id), billDate: today, kind: 'service', lines: [{ description: 'Audit fees', quantity: 1, rate: 60_000, gstPercent: 18 }], tds: { applicable: true, section: '194J', rate: 10 } })).toEqual([]);
  });
});
