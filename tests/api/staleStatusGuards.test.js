'use strict';
// ══════════════════════════════════════════════════════════════════
//  A STATUS CHECKED ON A COPY THAT WENT STALE
//
//  Each route reads a record, checks its status, then saves. These serve
//  the route the copy it read just before someone else changed the
//  record, and check the save no longer writes over the change:
//    • starting production on an order cancelled meanwhile;
//    • sending a loom for service just as it was assigned a job.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Order, Machine, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(url).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  Machine = require('../../models/Machine');
  const User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => jest.restoreAllMocks());

/** The record as the route will read it: the copy from before `change`. */
async function staleAfter(Model, id, change) {
  const stale = await Model.findById(id);
  await Model.updateOne({ _id: id }, change);
  jest.spyOn(Model, 'findById').mockImplementationOnce(() => Promise.resolve(stale));
}

it('does not revive an order cancelled meanwhile by starting its production', async () => {
  const order = await Order.create({
    customer: new mongoose.Types.ObjectId(), status: 'Approved', po: 'PO-S1',
    date: new Date(), supplyDate: new Date(), elasticOrdered: [],
  });
  await staleAfter(Order, order._id, { $set: { status: 'Cancelled' } });
  const res = await post('/api/v2/order/start-production', { orderId: String(order._id) });
  expect(res.status).toBe(409);
  expect((await Order.findById(order._id).lean()).status).toBe('Cancelled');
});

it('does not put a loom into maintenance as it starts a job', async () => {
  const machine = await Machine.create({
    ID: 'M-S1', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'free', elastics: [],
  });
  const job = new mongoose.Types.ObjectId();
  await staleAfter(Machine, machine._id, { $set: { status: 'running', orderRunning: job } });
  const res = await post('/api/v2/machine/add-service-log', {
    machineId: String(machine._id), type: 'Preventive', description: 'Oil change', setMaintenance: true,
  });
  expect(res.status).toBe(409);
  expect(await Machine.findById(machine._id).lean()).toMatchObject({ status: 'running' });
});

describe('a quote', () => {
  const quoteBody = {
    customerName: 'Ravi Textiles', productName: '20mm Woven Elastic',
    materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240 }],
    conversionCost: 1.25, marginPercent: 20, gstPercent: 5, quantityMetres: 5000,
  };
  const Quote = () => require('../../models/Quote');

  it('is not repriced after it was accepted meanwhile', async () => {
    const created = await post('/api/v2/quote/create', quoteBody);
    expect(created.status).toBe(201);
    const id = created.body.quote._id;
    // Accepted through the status route: the version does not move.
    await staleAfter(Quote(), id, { $set: { status: 'accepted' } });

    const res = await request(app).put('/api/v2/quote/update').set('Cookie', cookie())
      .send({ id, auditReason: 'customer asked for 30%', marginPercent: 30 });
    expect(res.status).toBe(409);
    const stored = await Quote().findById(id).lean();
    expect(stored.status).toBe('accepted');
    expect(stored.grandTotal).toBe(created.body.quote.grandTotal);
  });

  it('two status changes at once: the second is told', async () => {
    const created = await post('/api/v2/quote/create', quoteBody);
    const id = created.body.quote._id;
    await staleAfter(Quote(), id, { $set: { status: 'accepted' } });

    const res = await request(app).patch('/api/v2/quote/status').set('Cookie', cookie())
      .send({ id, status: 'declined' });
    expect(res.status).toBe(409);
    expect((await Quote().findById(id).lean()).status).toBe('accepted');
  });
});

it('a sample closed and reopened at the same moment: the second is told', async () => {
  const SampleRequest = require('../../models/SampleRequest');
  const raised = await post('/api/v2/sample', {
    title: 'Navy 25mm woven', details: '25mm navy', customerName: 'Zenith Apparel', quantity: 50,
  });
  expect(raised.status).toBe(201);
  const id = raised.body.sample._id;
  await staleAfter(SampleRequest, id, { $set: { status: 'closed' } });

  const res = await request(app).put(`/api/v2/sample/${id}/status`).set('Cookie', cookie())
    .send({ status: 'completed', note: 'sent to customer' });
  expect(res.status).toBe(409);
  expect((await SampleRequest.findById(id).lean()).status).toBe('closed');
});
