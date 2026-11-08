'use strict';
// ══════════════════════════════════════════════════════════════════
//  CHASING SUPPLIERS FOR LATE PURCHASE ORDERS
//
//  Late yarn stops a loom, and nobody was following it up. The list of
//  late POs, the chaser written from each, and the supplier's reply
//  read for a dispatch date — kept beside the date we asked for, never
//  over it — with the customer order that date puts at risk named.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));
const mockSend = jest.fn().mockResolvedValue({ sent: true, provider: 'twilio', providerId: 'SM1' });
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true }));
const mockNotify = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../../utils/notify', () => ({ ...jest.requireActual('../../utils/notify'), notify: (...a) => mockNotify(...a) }));

let mongo, app, admin, PO, chaser, supplier, mat, late, promised, order;
const DAY = 86_400_000;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const dayFromToday = (n) => { const d = require('../../utils/factoryDay').calendarDay(); return new Date(d.getTime() + n * DAY); };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  chaser = require('../../services/poChaser');
  PO = require('../../models/PurchaseOrder');
  const User = require('../../models/User');
  const Supplier = require('../../models/Supplier');
  const RawMaterial = require('../../models/RawMaterial');
  const Order = require('../../models/Order');
  admin = await User.create({ name: 'Owner', email: 'pc@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supplier = await Supplier.collection.insertOne({ name: 'Sri Murugan Yarns', phoneNumber: '9840022222', contactPerson: 'Mr Raju' }).then((r) => ({ _id: r.insertedId, name: 'Sri Murugan Yarns' }));
  mat = await RawMaterial.create({ name: '40s black', category: 'warp', unit: 'kg', stock: 10, minStock: 50, price: 300 });
  order = await Order.collection.insertOne({ orderNo: 7001, status: 'Approved', supplyDate: dayFromToday(3) }).then((r) => r.insertedId);
  const base = { supplier: supplier._id, date: dayFromToday(-20), status: 'Partial' };
  [late, promised] = await PO.insertMany([
    { ...base, poNo: 501, expectedDate: dayFromToday(-4), forOrder: order, items: [{ rawMaterial: mat._id, quantity: 200, receivedQuantity: 80, price: 300 }] },
    { ...base, poNo: 502, expectedDate: dayFromToday(-6), items: [{ rawMaterial: mat._id, quantity: 100, receivedQuantity: 0, price: 300 }], chase: { count: 1, lastAt: new Date(Date.now() - 5 * DAY), promisedDate: dayFromToday(2) } },
    { ...base, poNo: 503, expectedDate: dayFromToday(5), items: [{ rawMaterial: mat._id, quantity: 50, receivedQuantity: 0, price: 300 }] },
    { ...base, poNo: 504, status: 'Completed', expectedDate: dayFromToday(-9), items: [{ rawMaterial: mat._id, quantity: 50, receivedQuantity: 50, price: 300 }] },
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { mockSend.mockClear(); mockNotify.mockClear(); });

describe('the list of late POs', () => {
  it('shows open POs past their date, with what is still to come', async () => {
    const res = await get('/supplier/po/chase');
    expect(res.status).toBe(200);
    const nos = res.body.rows.map((r) => r.poNo);
    expect(nos.sort()).toEqual([501, 502]);
    const r501 = res.body.rows.find((r) => r.poNo === 501);
    expect(r501.pending[0]).toMatchObject({ material: '40s black', pending: 120, unit: 'kg' });
    expect(r501.daysLate).toBe(4);
    expect(r501.chaseDue).toBe(true);
    expect(r501.draft).toMatch(/Mr Raju/);
    expect(r501.draft).toMatch(/40s black — 120 kg/);
    expect(r501.waLink).toMatch(/^https:\/\/wa\.me\/919840022222\?text=/);
  });

  it('does not chase a supplier who has promised a date still to come', async () => {
    const r502 = (await get('/supplier/po/chase')).body.rows.find((r) => r.poNo === 502);
    expect(r502.state).toBe('promised');
    expect(r502.chaseDue).toBe(false);
  });
});

describe('sending a chaser', () => {
  it('sends it on WhatsApp and notes it on the PO', async () => {
    const res = await post(`/supplier/po/${late._id}/chase`, {});
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith('+919840022222', expect.stringMatching(/PO #501/));
    const po = await PO.findById(late._id).lean();
    expect(po.chase.count).toBe(1);
    expect(po.chase.history.at(-1)).toMatchObject({ kind: 'sent', status: 'sent', by: 'Owner' });
  });

  it('does not chase the same PO again the next hour', async () => {
    const r501 = (await get('/supplier/po/chase')).body.rows.find((r) => r.poNo === 501);
    expect(r501.chaseDue).toBe(false);
    const out = await chaser.sendDue();
    expect(out).toHaveLength(0);
  });
});

describe('the supplier\'s reply', () => {
  it('takes a dispatch date as their promise, beside the date asked for', async () => {
    const res = await request(app).post('/api/v2/notify/incoming').type('form').send({ From: 'whatsapp:+919840022222', Body: 'Sir PO 501 will dispatch on ' + new Date(dayFromToday(5)).getUTCDate() + 'th' });
    expect(res.status).toBe(200);
    const po = await PO.findById(late._id).lean();
    expect(require('../../utils/factoryDay').ymd(po.chase.promisedDate)).toBe(require('../../utils/factoryDay').ymd(dayFromToday(5)));
    expect(require('../../utils/factoryDay').ymd(po.expectedDate)).toBe(require('../../utils/factoryDay').ymd(dayFromToday(-4)));
    expect(po.chase.history.at(-1)).toMatchObject({ kind: 'reply' });
  });

  it('tells the office, naming the customer order the date puts at risk', async () => {
    await chaser.handleReply({ from: '+919840022222', text: 'po 501 will send next week', supplier });
    const [event, payload] = mockNotify.mock.calls.at(-1);
    expect(event).toBe('supplierReply');
    expect(payload.body).toMatch(/Sri Murugan Yarns/);
    expect(payload.body).toMatch(/Order #7001/);
  });

  it('keeps a problem as a problem, without a date', async () => {
    const r = await chaser.handleReply({ from: '+919840022222', text: 'Sorry sir, no stock of 40s black this month', supplier });
    expect(r.read.kind).toBe('problem');
    expect(r.promised).toBeNull();
  });

  it('leaves a number that is not a supplier\'s to the usual handling', async () => {
    expect(await chaser.supplierForPhone('+919999911111')).toBeNull();
  });
});

describe('the settings', () => {
  it('turns the morning chasers on, within sane hours', async () => {
    const ok = await request(app).put('/api/v2/supplier/po/chase/settings').set('Cookie', cookie()).send({ auto: true, hour: 9 });
    expect(ok.body.settings).toMatchObject({ auto: true, hour: 9 });
    const bad = await request(app).put('/api/v2/supplier/po/chase/settings').set('Cookie', cookie()).send({ hour: 2 });
    expect(bad.status).toBe(400);
  });
});
