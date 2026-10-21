'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DISPATCH QUEUE
//
//  A job reaching packing, or a sample completed, joins the queue and
//  waits for marketing / admin to say how urgent delivery is: tomorrow,
//  today, today morning or today evening. The queue puts whatever is
//  still unanswered first, then everything by deadline.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let DispatchItem, JobOrder, Order, Customer, Elastic, SampleRequest, User;
let admin, marketing, packer, finance, production;
let customer, elastic;

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app           = require('../../app.js');
  DispatchItem  = require('../../models/DispatchItem');
  JobOrder      = require('../../models/JobOrder');
  Order         = require('../../models/Order');
  Customer      = require('../../models/Customer');
  Elastic       = require('../../models/Elastic');
  SampleRequest = require('../../models/SampleRequest');
  User          = require('../../models/User');
  const mk = (name, department, role, features) => User.create({
    name, email: `${name}@t.co`, password: 'pass1234', role, department, ...(features ? { features } : {}),
  });
  admin      = await mk('owner', 'admin', 'admin');
  marketing  = await mk('meena', 'marketing', 'marketing', ['/', '/dispatch']);
  packer     = await mk('pandi', 'packing', 'production', ['/', '/packing', '/dispatch']);
  finance    = await mk('fathima', 'finance', 'accounts', ['/', '/delivery-challans', '/dispatch']);
  production = await mk('prabhu', 'production', 'production', ['/', '/jobs']);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  customer = await Customer.create({ name: 'Fellows Fashion', contactName: 'M', phoneNumber: `97874${seq}0000`.slice(0, 10) });
  elastic = await Elastic.create({
    name: `20mm Knitted ${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
});

afterEach(async () => {
  jest.useRealTimers();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function jobAt(status) {
  const order = await Order.create({
    customer: customer._id, po: 'PO-1', date: new Date(), supplyDate: new Date(), status: 'InProgress',
    elasticOrdered: [{ elastic: elastic._id, quantity: 2000, rate: 10 }],
  });
  return JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(), status,
    elastics: [{ elastic: elastic._id, quantity: 2000 }],
  });
}

const advance = (job, nextStatus, who = admin) => request(app).post('/api/v2/job/update-status')
  .set('Cookie', cookie(who)).send({ jobId: String(job._id), nextStatus });
const queue = (who = admin, view) => request(app).get(`/api/v2/dispatch/queue${view ? `?view=${view}` : ''}`).set('Cookie', cookie(who));
const setUrgency = (item, urgency, who = marketing) => request(app).patch(`/api/v2/dispatch/${item._id}/urgency`)
  .set('Cookie', cookie(who)).send({ urgency });

describe('joining the queue', () => {
  test('a job reaching packing waits for an urgency, named as people know it', async () => {
    const job = await jobAt('checking');
    const res = await advance(job, 'packing');
    expect(res.status).toBe(200);
    const item = await DispatchItem.findOne({ job: job._id }).lean();
    expect(item).toMatchObject({
      kind: 'job', status: 'awaiting_urgency', urgency: null, customerName: 'Fellows Fashion',
      ref: `J-${job.jobOrderNo}`, title: elastic.name, quantity: 2000,
    });
  });

  test('completing the job does not add it twice', async () => {
    const job = await jobAt('checking');
    await advance(job, 'packing');
    await advance(job, 'completed');
    expect(await DispatchItem.countDocuments({ job: job._id })).toBe(1);
  });

  test('a job completed without an entry gets one then', async () => {
    const job = await jobAt('packing');
    await advance(job, 'completed');
    expect(await DispatchItem.countDocuments({ job: job._id })).toBe(1);
  });

  test('a job moving between earlier stages does not join', async () => {
    const job = await jobAt('finishing');
    await advance(job, 'checking');
    expect(await DispatchItem.countDocuments({})).toBe(0);
  });

  test('cancelling the job takes it off the queue', async () => {
    const job = await jobAt('checking');
    await advance(job, 'packing');
    const res = await request(app).post('/api/v2/job/cancel').set('Cookie', cookie(admin))
      .send({ jobId: String(job._id), reason: 'customer withdrew' });
    expect(res.status).toBe(200);
    expect(await DispatchItem.findOne({ job: job._id }).lean()).toMatchObject({ status: 'cancelled', cancelReason: 'Job cancelled' });
  });

  test('a completed sample joins; reopened it comes off; completed again it comes back', async () => {
    const s = await SampleRequest.create({ sampleNo: 12, title: 'Hanger elastic', details: 'white', customerName: 'Fellows', status: 'in_progress' });
    const status = (st, note = 'done') => request(app).put(`/api/v2/sample/${s._id}/status`).set('Cookie', cookie(admin)).send({ status: st, note });
    expect((await status('completed')).status).toBe(200);
    expect(await DispatchItem.findOne({ sample: s._id }).lean()).toMatchObject({ kind: 'sample', ref: 'Sample #12', status: 'awaiting_urgency' });
    await status('open', 'needs a redo');
    expect((await DispatchItem.findOne({ sample: s._id }).lean()).status).toBe('cancelled');
    await status('completed');
    expect(await DispatchItem.countDocuments({ sample: s._id })).toBe(1);
    expect((await DispatchItem.findOne({ sample: s._id }).lean()).status).toBe('awaiting_urgency');
  });
});

describe('asking for the urgency', () => {
  test('marketing sets it, and it becomes a deadline in plant time', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-21T04:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] }); // 09:30 IST
    const job = await jobAt('checking');
    await advance(job, 'packing');
    const item = await DispatchItem.findOne({ job: job._id });
    const res = await setUrgency(item, 'today_morning');
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: 'queued', urgency: 'today_morning', urgencyLabel: 'Today morning', urgencySetByName: 'meena' });
    expect(new Date(res.body.item.dueAt).toISOString()).toBe('2026-10-21T07:30:00.000Z'); // 1 PM IST
  });

  test('admin can set it; packing, finance and production cannot', async () => {
    const job = await jobAt('checking');
    await advance(job, 'packing');
    const item = await DispatchItem.findOne({ job: job._id });
    expect((await setUrgency(item, 'today', packer)).status).toBe(403);
    expect((await setUrgency(item, 'today', finance)).status).toBe(403);
    expect((await setUrgency(item, 'today', production)).status).toBe(403);
    expect((await setUrgency(item, 'tomorrow', admin)).status).toBe(200);
  });

  test('only the four slots are accepted', async () => {
    const job = await jobAt('checking');
    await advance(job, 'packing');
    const item = await DispatchItem.findOne({ job: job._id });
    expect((await setUrgency(item, 'next_week')).status).toBe(400);
  });

  test('it can be changed while waiting, not after it has gone', async () => {
    const job = await jobAt('checking');
    await advance(job, 'packing');
    const item = await DispatchItem.findOne({ job: job._id });
    await setUrgency(item, 'tomorrow');
    expect((await setUrgency(item, 'today_evening')).body.item.urgency).toBe('today_evening');
    await request(app).post(`/api/v2/dispatch/${item._id}/dispatched`).set('Cookie', cookie(packer)).send({});
    expect((await setUrgency(item, 'today')).status).toBe(409);
  });
});

describe('the queue', () => {
  test('unanswered first, then by deadline; late ones flagged', async () => {
    const make = (ref, over) => DispatchItem.create({ kind: 'job', job: new mongoose.Types.ObjectId(), ref, ...over });
    const now = Date.now();
    await make('J-tomorrow', { status: 'queued', urgency: 'tomorrow', dueAt: new Date(now + 30 * 3600e3), readyAt: new Date(now - 5e6) });
    await make('J-morning-late', { status: 'queued', urgency: 'today_morning', dueAt: new Date(now - 3600e3), readyAt: new Date(now - 4e6) });
    await make('J-awaiting', { status: 'awaiting_urgency', readyAt: new Date(now - 1e6) });
    await make('J-evening', { status: 'queued', urgency: 'today_evening', dueAt: new Date(now + 3 * 3600e3), readyAt: new Date(now - 3e6) });
    await make('J-gone', { status: 'dispatched', dispatchedAt: new Date() });

    const res = await queue(finance);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.ref)).toEqual(['J-awaiting', 'J-morning-late', 'J-evening', 'J-tomorrow']);
    expect(res.body.items.find((i) => i.ref === 'J-morning-late').late).toBe(true);
    expect(res.body.counts).toEqual({ awaiting: 1, queued: 3, late: 1 });
    expect(res.body.urgencies.map((u) => u.label)).toEqual(['Today morning', 'Today evening', 'Today', 'Tomorrow']);

    const gone = await queue(finance, 'dispatched');
    expect(gone.body.items.map((i) => i.ref)).toEqual(['J-gone']);
  });

  test('packing marks it dispatched; it leaves the open queue', async () => {
    const job = await jobAt('checking');
    await advance(job, 'packing');
    const item = await DispatchItem.findOne({ job: job._id });
    await setUrgency(item, 'today');
    const res = await request(app).post(`/api/v2/dispatch/${item._id}/dispatched`).set('Cookie', cookie(packer)).send({ note: 'DC-41, lorry TN38' });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: 'dispatched', dispatchedByName: 'pandi', dispatchNote: 'DC-41, lorry TN38' });
    expect((await queue(packer)).body.items).toHaveLength(0);
  });

  test('only admin removes an item, and says why', async () => {
    const job = await jobAt('checking');
    await advance(job, 'packing');
    const item = await DispatchItem.findOne({ job: job._id });
    const cancel = (who, reason) => request(app).post(`/api/v2/dispatch/${item._id}/cancel`).set('Cookie', cookie(who)).send({ reason });
    expect((await cancel(marketing, 'customer collecting')).status).toBe(403);
    expect((await cancel(admin, '')).status).toBe(400);
    expect((await cancel(admin, 'customer collecting')).status).toBe(200);
  });

  test('someone without the Dispatch feature cannot open it', async () => {
    expect((await queue(production)).status).toBe(403);
  });
});
