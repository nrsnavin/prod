'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PHONE'S CLOCK
//
//  The phone app sends dates as its own clock with no zone:
//  "2026-11-18T21:15:30.123456" (Dart's toIso8601String on local time).
//  The server runs on UTC, and `new Date` of that text is 21:15 UTC —
//  02:45 the next morning in India. So an order taken on the phone
//  after 18:30 was dated the next day and promised a day late, and
//  goods received in the evening were entered under tomorrow.
//
//  A phone already installed keeps sending this, so it is read right
//  here, whatever the app does later:
//
//    • the order's date and the date promised are calendar dates: that
//      day, however it was written
//    • goods received at 21:15 came in at 21:15 in India
//    • a web edit that sends the same day does not read as a change of
//      date on an order whose stored date carried a time
//    • what is not a date is refused before anything is written
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const factoryDay = require('../../utils/factoryDay');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Elastic', 'Order', 'Supplier', 'RawMaterial', 'PurchaseOrder', 'MaterialInward']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'Owner', email: 'clock@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const iso = (d) => new Date(d).toISOString();

describe('a time with no zone is the factory clock', () => {
  it('reads the phone\'s text as India time, and leaves the rest as it was', () => {
    expect(iso(factoryDay.moment('2026-11-18T21:15:30.123456'))).toBe('2026-11-18T15:45:30.123Z');
    expect(iso(factoryDay.moment('2026-11-18 09:05'))).toBe('2026-11-18T03:35:00.000Z');
    // Midnight on the phone is 18:30 UTC the day before: still the 18th in India.
    expect(factoryDay.ymd(factoryDay.moment('2026-11-18T00:00:00.000'))).toBe('2026-11-18');
    // A zone that was said is kept; a date alone is that day's UTC midnight.
    expect(iso(factoryDay.moment('2026-11-18T21:15:30.000Z'))).toBe('2026-11-18T21:15:30.000Z');
    expect(iso(factoryDay.moment('2026-11-18T21:15:30+05:30'))).toBe('2026-11-18T15:45:30.000Z');
    expect(iso(factoryDay.moment('2026-11-18'))).toBe('2026-11-18T00:00:00.000Z');
    for (const junk of ['2026-02-31T10:00:00', '2026-11-18T25:00:00', '2026-11-18T10:61:00', 'tomorrow', '', null, undefined]) {
      expect(factoryDay.moment(junk)).toBeNull();
    }
  });
});

describe('an order taken on the phone in the evening', () => {
  async function scene() {
    const customer = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'Ravi', phoneNumber: '9000000001' });
    const elastic = await M.Elastic.create({ name: '20mm Knitted', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
    const body = (over) => ({ po: 'PO-77', customer: String(customer._id), elasticOrdered: [{ elastic: String(elastic._id), quantity: 500 }], ...over });
    return { customer, elastic, body };
  }

  it('is dated that day and promised on the day shown, not the next', async () => {
    const { body } = await scene();
    // 21:15 on the 18th; promised a week on, also 21:15.
    const res = await post('/order/create-order', body({ date: '2026-11-18T21:15:30.123456', supplyDate: '2026-11-25T21:15:30.123456' }));
    expect(res.status).toBe(201);
    const order = await M.Order.findOne({ po: 'PO-77' }).lean();
    expect(iso(order.date)).toBe('2026-11-18T00:00:00.000Z');
    expect(iso(order.supplyDate)).toBe('2026-11-25T00:00:00.000Z');
  });

  it('CONTROL: the web\'s plain dates are what they were', async () => {
    const { body } = await scene();
    expect((await post('/order/create-order', body({ date: '2026-11-18', supplyDate: '2026-11-25' }))).status).toBe(201);
    const order = await M.Order.findOne({ po: 'PO-77' }).lean();
    expect(iso(order.date)).toBe('2026-11-18T00:00:00.000Z');
    expect(iso(order.supplyDate)).toBe('2026-11-25T00:00:00.000Z');
  });

  it('refuses a date that is not one, and makes no order', async () => {
    const { body } = await scene();
    const res = await post('/order/create-order', body({ date: '2026-11-18', supplyDate: 'next week' }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('supplyDate is not a date');
    expect(await M.Order.countDocuments({})).toBe(0);
  });

  it('a web edit sending the same day is not a change of date', async () => {
    const { customer, elastic } = await scene();
    // As a phone order was stored before: the promised date with a time of day.
    const order = await M.Order.create({
      customer: customer._id, po: 'PO-OLD', date: new Date('2026-11-18T10:00:00Z'), supplyDate: new Date('2026-11-25T10:00:00Z'), status: 'Open',
      elasticOrdered: [{ elastic: elastic._id, quantity: 500 }], producedElastic: [{ elastic: elastic._id, quantity: 0 }],
      packedElastic: [{ elastic: elastic._id, quantity: 0 }], pendingElastic: [{ elastic: elastic._id, quantity: 500 }],
    });
    const same = await post('/order/update-order', { orderId: String(order._id), supplyDate: '2026-11-25', description: 'Deliver to gate 2', auditReason: 'added delivery note' });
    expect(same.status).toBe(200);
    let stored = await M.Order.findById(order._id).lean();
    expect(iso(stored.supplyDate)).toBe('2026-11-25T10:00:00.000Z');
    expect(stored.description).toBe('Deliver to gate 2');

    // A real change of date is kept as the day.
    const moved = await post('/order/update-order', { orderId: String(order._id), supplyDate: '2026-11-27T21:15:30.123', auditReason: 'customer asked for later' });
    expect(moved.status).toBe(200);
    stored = await M.Order.findById(order._id).lean();
    expect(iso(stored.supplyDate)).toBe('2026-11-27T00:00:00.000Z');
  });
});

describe('goods received on the phone in the evening', () => {
  async function po() {
    const supplier = await M.Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
    const yarn = await M.RawMaterial.create({ name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 300, supplier: supplier._id });
    const order = await M.PurchaseOrder.create({ poNo: 7, supplier: supplier._id, status: 'Open', items: [{ rawMaterial: yarn._id, quantity: 100, price: 300, receivedQuantity: 0 }] });
    return { yarn, order };
  }
  const receive = (order, yarn, inwardDate, quantity = 10) => post('/supplier/inward-stock', {
    poId: String(order._id), items: [{ rawMaterial: String(yarn._id), quantity, ...(inwardDate === undefined ? {} : { inwardDate }) }],
  });

  it('came in at that time in India, on that day', async () => {
    const { yarn, order } = await po();
    expect((await receive(order, yarn, '2026-11-18T21:15:30.123456')).status).toBe(201);
    const row = await M.MaterialInward.findOne({ purchaseOrder: order._id }).lean();
    expect(iso(row.inwardDate)).toBe('2026-11-18T15:45:30.123Z');
    expect(factoryDay.ymd(row.inwardDate)).toBe('2026-11-18');
  });

  it('CONTROL: a time sent with its zone, and none sent at all', async () => {
    const { yarn, order } = await po();
    expect((await receive(order, yarn, '2026-11-18T15:45:30.000Z')).status).toBe(201);
    const before = Date.now();
    expect((await receive(order, yarn, undefined)).status).toBe(201);
    const rows = await M.MaterialInward.find({ purchaseOrder: order._id }).sort({ _id: 1 }).lean();
    expect(iso(rows[0].inwardDate)).toBe('2026-11-18T15:45:30.000Z');
    expect(new Date(rows[1].inwardDate).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(rows[1].inwardDate).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('refuses a date that is not one, and receives nothing', async () => {
    const { yarn, order } = await po();
    const res = await receive(order, yarn, 'yesterday evening');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('inwardDate is not a date');
    expect(await M.MaterialInward.countDocuments({})).toBe(0);
    expect((await M.RawMaterial.findById(yarn._id).lean()).stock).toBe(0);
    expect((await M.PurchaseOrder.findById(order._id).lean()).items[0].receivedQuantity).toBe(0);
  });
});
