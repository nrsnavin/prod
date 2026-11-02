'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CHALLAN ROUTES, CHECKED LINE BY LINE
//
//  What a review of api/deliveryChallan.js turned up and this holds:
//    • an id that is not one is a 404 on /detail and /delete, not a 500
//    • a date that is not one is refused, not stored as Invalid Date
//    • a line naming an elastic that does not exist is refused, and the
//      name printed on a line is the catalogue's, not the client's
//    • a challan refused for stock does not burn a number in the series
//    • the order's customer address reaches the form
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Order, Customer, Elastic, DeliveryChallan, User, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  DeliveryChallan = require('../../models/DeliveryChallan');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'dcreview@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let seq = 0;
const makeElastic = (stock = 1000) => Elastic.create({
  name: `20mm-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock, reservedStock: 0,
});
const cut = (body) => post('/dc/create', { type: 'elastic', customerName: 'Acme', ...body });

describe('an id that is not one', () => {
  it('is a 404 on the detail and the delete, not a 500', async () => {
    expect((await get('/dc/detail?id=not-an-id')).status).toBe(404);
    expect((await get('/dc/detail')).status).toBe(404);
    expect((await request(app).delete('/api/v2/dc/delete?id=nope').set('Cookie', cookie())).status).toBe(404);
  });
});

describe('the lines and the date on the way in', () => {
  it('refuses an elastic that does not exist, and prints the catalogue name on one that does', async () => {
    const el = await makeElastic();
    const ghost = await cut({ items: [{ elastic: new mongoose.Types.ObjectId(), elasticName: 'Ghost', quantity: 10 }] });
    expect(ghost.status).toBe(400);
    expect(ghost.body.message).toMatch(/Line 1 \("Ghost"\): that elastic does not exist/);

    const res = await cut({ items: [{ elastic: el._id, elasticName: 'typed wrong', quantity: 10 }] });
    expect(res.status).toBe(201);
    expect(res.body.dc.items[0].elasticName).toBe(el.name);
    // The ghost burnt no number: this is the first challan of the year.
    expect(res.body.dc.sequence).toBe(1);
  });

  it('refuses a dispatch date that is not a date', async () => {
    const el = await makeElastic();
    const res = await cut({ dispatchDate: 'next tuesday', items: [{ elastic: el._id, quantity: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/dispatchDate is not a date/);
    expect(await DeliveryChallan.countDocuments()).toBe(0);
  });
});

describe('a challan refused for stock', () => {
  it('burns no number in the series, and the reason lets it through with the next number', async () => {
    const el = await makeElastic(50);
    const short = await cut({ items: [{ elastic: el._id, quantity: 80 }] });
    expect(short.status).toBe(409);
    expect(short.body.code).toBe('DC_STOCK_SHORT');
    expect(short.body.details.shortfalls[0]).toMatchObject({ shipping: 80, onHand: 50, short: 30 });

    const ok = await cut({ items: [{ elastic: el._id, quantity: 80 }], stockShortfallReason: 'Counted on the rack, system is behind' });
    expect(ok.status).toBe(201);
    expect(ok.body.dc.sequence).toBe(1);
    expect(ok.body.dc.dcNumber).toMatch(/-0001$/);
    expect(ok.body.dc.stockShortfall.lines[0]).toMatchObject({ shipping: 80, onHand: 50 });
    expect((await Elastic.findById(el._id).lean()).stock).toBe(0);
  });
});

describe('the order behind a challan', () => {
  it('hands the form the customer address too', async () => {
    const customer = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000001', gstin: '33AAAAA0000A1Z5', address: '12 Mill Road, Tiruppur' });
    const el = await makeElastic();
    const order = await Order.create({
      customer: customer._id, po: 'PO-7', date: new Date(), supplyDate: new Date(), status: 'Approved',
      elasticOrdered: [{ elastic: el._id, quantity: 500 }],
    });
    const res = await get(`/dc/order-info?id=${order._id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ name: 'Acme', gstin: '33AAAAA0000A1Z5' });
    expect(res.body.customer.address).toBe('12 Mill Road, Tiruppur');
  });
});
