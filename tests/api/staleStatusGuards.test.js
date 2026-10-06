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

describe('the shift clock', () => {
  const Attendance = () => require('../../models/Attendence.js');
  const Employee = () => require('../../models/Employee');
  const clock = (what, employeeId) =>
    post(`/api/v2/attendance/clock-${what}`, { employeeId: String(employeeId), shift: 'DAY', date: '2026-06-02' });

  it('a second clock-in does not move the start of a running shift', async () => {
    const emp = await Employee().create({ name: 'Clock A', hourlyRate: 100 });
    expect((await clock('in', emp._id)).status).toBe(200);
    const started = (await Attendance().findOne({ employee: emp._id }).lean()).clockInAt;
    // The double tap's look at the shift was taken before the first landed.
    jest.spyOn(Attendance(), 'findOne').mockImplementationOnce(() => Promise.resolve(null));

    const res = await clock('in', emp._id);
    expect(res.status).toBe(409);
    expect((await Attendance().findOne({ employee: emp._id }).lean()).clockInAt).toEqual(started);
  });

  it('a second clock-out does not move the end of a finished shift', async () => {
    const emp = await Employee().create({ name: 'Clock B', hourlyRate: 100 });
    await clock('in', emp._id);
    const open = await Attendance().findOne({ employee: emp._id });
    expect((await clock('out', emp._id)).status).toBe(200);
    const ended = (await Attendance().findOne({ employee: emp._id }).lean()).clockOutAt;
    jest.spyOn(Attendance(), 'findOne').mockImplementationOnce(() => Promise.resolve(open));

    const res = await clock('out', emp._id);
    expect(res.status).toBe(409);
    expect((await Attendance().findOne({ employee: emp._id }).lean()).clockOutAt).toEqual(ended);
  });
});

describe('the loom status override', () => {
  it('will not free a loom running a job', async () => {
    const job = new mongoose.Types.ObjectId();
    const machine = await Machine.create({
      ID: 'M-S2', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'running', orderRunning: job, elastics: [],
    });
    const res = await request(app).patch('/api/v2/machine/status').set('Cookie', cookie())
      .send({ id: String(machine._id), status: 'free' });
    expect(res.status).toBe(409);
    expect(String((await Machine.findById(machine._id).lean()).orderRunning)).toBe(String(job));
  });

  it('does not wipe a job assigned after it read the loom', async () => {
    const machine = await Machine.create({
      ID: 'M-S3', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'maintenance', elastics: [],
    });
    const job = new mongoose.Types.ObjectId();
    await staleAfter(Machine, machine._id, { $set: { status: 'running', orderRunning: job } });
    const res = await request(app).patch('/api/v2/machine/status').set('Cookie', cookie())
      .send({ id: String(machine._id), status: 'free' });
    expect(res.status).toBe(409);
    expect(await Machine.findById(machine._id).lean()).toMatchObject({ status: 'running' });
    expect(String((await Machine.findById(machine._id).lean()).orderRunning)).toBe(String(job));
  });

  it('still frees a loom back from maintenance', async () => {
    const machine = await Machine.create({
      ID: 'M-S4', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'maintenance', elastics: [],
    });
    const res = await request(app).patch('/api/v2/machine/status').set('Cookie', cookie())
      .send({ id: String(machine._id), status: 'free' });
    expect(res.status).toBe(200);
    expect((await Machine.findById(machine._id).lean()).status).toBe('free');
  });
});

it('an elastic is not archived as an order reserves stock on it', async () => {
  const Elastic = require('../../models/Elastic');
  const elastic = await Elastic.create({
    name: 'Archive me', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const stale = await Elastic.findById(elastic._id).select('_id name archived reservedStock');
  await Elastic.updateOne({ _id: elastic._id }, { $set: { reservedStock: 300 } });
  jest.spyOn(Elastic, 'findById').mockImplementationOnce(() => ({ select: () => Promise.resolve(stale) }));

  const res = await request(app).patch(`/api/v2/elastic/${elastic._id}/archive`).set('Cookie', cookie()).send({});
  expect(res.status).toBe(409);
  expect((await Elastic.findById(elastic._id).lean()).archived).toBeFalsy();
});
