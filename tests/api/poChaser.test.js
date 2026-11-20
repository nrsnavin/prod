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

let mockClaude = null;   // no model: the keywords read the reply, unless a test gives one
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => mockClaude, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));
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

// ══════════════════════════════════════════════════════════════════
//  Found reading services/poChaser.js line by line.
//
//  A reply's day decides whether the chaser waits. The day was read the
//  way a PROMISE is read — looking forward — whatever the reply said:
//
//    • "Dispatched on 15/11", written on the 20th, was the 15th of
//      November NEXT YEAR: the PO sat as "promised" and was not chased
//      again for twelve months
//    • "Sent on 15th" was a promise to dispatch on the 15th of next month
//    • "not yet dispatched" read as dispatched
//    • any date at all ("your PO dated 01/11…") was a promise, a year off
//    • the model's day was checked for its shape only (the second copy of
//      the rule in services/collectionReply.js, without its checks)
// ══════════════════════════════════════════════════════════════════
describe('the day in a supplier\'s reply', () => {
  const FRIDAY = new Date('2026-11-20T06:00:00Z');
  const read = (text, when = FRIDAY) => chaser.keywordRead(text, when);

  it('is a day gone by when they say it has been sent', () => {
    expect(read('Dispatched on 15/11, LR no 4471')).toMatchObject({ kind: 'dispatched', date: '2026-11-15' });
    expect(read('Dispatched on 28/12', new Date('2027-01-02T06:00:00Z'))).toMatchObject({ kind: 'dispatched', date: '2026-12-28' });
    expect(read('Sent on 15th itself sir')).toMatchObject({ kind: 'dispatched', date: '2026-11-15' });
    expect(read('Material dispatched yesterday')).toMatchObject({ kind: 'dispatched', date: '2026-11-19' });
    expect(read('Loaded on Monday')).toMatchObject({ kind: 'dispatched', date: '2026-11-16' });
    expect(read('Dispatched today, will reach tomorrow')).toMatchObject({ kind: 'dispatched', date: '2026-11-20' });
  });

  it('is a promise when it is still to be sent', () => {
    expect(read('Will be dispatched tomorrow')).toMatchObject({ kind: 'promise', date: '2026-11-21' });
    expect(read('will dispatch by 25/11')).toMatchObject({ kind: 'promise', date: '2026-11-25' });
    expect(read('Sorry sir, not yet dispatched. Will send on Monday')).toMatchObject({ kind: 'promise', date: '2026-11-23' });
  });

  it('is not a promise when it is only a date they mention', () => {
    // Read forward, 01/11 is next November: nobody promises yarn a year out.
    expect(read('Your PO dated 01/11 is not in our records')).toMatchObject({ kind: 'other', date: null });
  });

  it('leaves a PO that was "dispatched last week" to be chased, not waiting a year', async () => {
    const ago = dayFromToday(-5);
    const r = await chaser.handleReply({ from: '+919840022222', text: `PO 501 dispatched on ${ago.getUTCDate()}/${ago.getUTCMonth() + 1}`, supplier });
    expect(r.read.kind).toBe('dispatched');
    expect(r.promised).toBe(ago.toISOString().slice(0, 10));
    const row = (await chaser.overdue()).find((x) => x.poNo === 501);
    expect(row.state).toBe('overdue');
    const [, payload] = mockNotify.mock.calls.at(-1);
    expect(payload.body).toMatch(/says it is dispatched/);
  });

  describe('when the model reads it', () => {
    const says = (obj) => { mockClaude = { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }], usage: {} }) } }; };
    afterEach(() => { mockClaude = null; });

    it('takes its day only when it is a day, not gone for a promise, and not months away', async () => {
      says({ kind: 'promise', date: '2026-11-31', summary: 'x' });            // no such day
      expect((await chaser.readReply('ok sir will send by 25th', { today: FRIDAY })).date).toBe('2026-11-25');
      says({ kind: 'promise', date: '2025-11-25', summary: 'x' });            // a model a year out
      expect((await chaser.readReply('ok sir will send by 25th', { today: FRIDAY })).date).toBe('2026-11-25');
      says({ kind: 'promise', date: '2027-11-25', summary: 'x' });            // a year ahead
      expect((await chaser.readReply('ok will send', { today: FRIDAY })).date).toBeNull();
      says({ kind: 'dispatched', date: '2026-11-18', summary: 'Sent on 18th' }); // sent: a day gone is right
      expect(await chaser.readReply('sent 2 days back', { today: FRIDAY })).toMatchObject({ kind: 'dispatched', date: '2026-11-18', ai: true });
      says({ kind: 'promise', date: '2026-12-02', summary: 'x' });
      expect((await chaser.readReply('next to next week', { today: FRIDAY })).date).toBe('2026-12-02');
    });
  });
});

describe('the morning run', () => {
  let other, a, b;
  const tenThirty = () => new Date(require('../../utils/factoryDay').calendarDay().getTime() + (10.5 * 60 - 330) * 60_000);

  beforeAll(async () => {
    const Supplier = require('../../models/Supplier');
    other = (await Supplier.collection.insertOne({ name: 'Kovai Rubber', phoneNumber: '9840033333' })).insertedId;
    const base = { supplier: other, date: dayFromToday(-20), status: 'Open' };
    [a, b] = await PO.insertMany([
      { ...base, poNo: 606, expectedDate: dayFromToday(-8), items: [{ rawMaterial: mat._id, quantity: 10, receivedQuantity: 0, price: 300 }] },
      { ...base, poNo: 607, expectedDate: dayFromToday(-7), items: [{ rawMaterial: mat._id, quantity: 10, receivedQuantity: 0, price: 300 }] },
    ]);
  });

  it('goes on to the next PO when one fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('provider library crashed'));
    const out = await chaser.sendDue();
    expect(out.map((x) => x.poNo)).toEqual([606, 607]);
    expect(out[0]).toMatchObject({ sent: false, error: expect.stringMatching(/crashed/) });
    expect(out[1]).toMatchObject({ sent: true });
    expect((await PO.findById(b._id).lean()).chase.count).toBe(1);
    expect((await PO.findById(a._id).lean()).chase?.count || 0).toBe(0);
  });

  it('that failed before anything went is recorded as failed, and tried again at the next tick', async () => {
    const ScheduledRun = require('../../models/ScheduledRun');
    await request(app).put('/api/v2/supplier/po/chase/settings').set('Cookie', cookie()).send({ auto: true, hour: 10 });
    const now = tenThirty();
    const day = require('../../utils/factoryDay').ymd(now);
    const spy = jest.spyOn(PO, 'find').mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(chaser.tick(now)).rejects.toThrow('db down');
    spy.mockRestore();
    expect(await ScheduledRun.findOne({ key: `poChase:${day}` }).lean()).toMatchObject({ ok: false, error: 'db down' });

    const again = await chaser.tick(now);
    expect(again.ran).toBe(true);
    expect(again.sent.map((x) => x.poNo)).toEqual([606]);          // 607 went above; nothing goes twice
    expect(await ScheduledRun.findOne({ key: `poChase:${day}` }).lean()).toMatchObject({ ok: true });
    expect(await chaser.tick(now)).toMatchObject({ ran: false, why: 'already sent today' });
  });
});
