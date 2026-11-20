'use strict';
// ══════════════════════════════════════════════════════════════════
//  METRES A HEAD, AND METRES A LOOM
//
//  Found reading services/floorEntry.js, shiftHandover.js and
//  productionModel.js line by line.
//
//  Production is entered a head; verifying it stores the loom's total
//  (metres a head × the heads running). The floor's own view of a loom
//  carried whichever of the two the entry held — a head while it waited,
//  the total once verified — in one field, which
//
//    • the floor screens print as "m/head": a verified loom on 2 heads
//      that made 250 a head read "500 m/head";
//    • the shift handover added up as it came, against an expectation
//      that is always a loom's total: four heads entered at 300 a head
//      counted as 300 of the 1,200 they made.
//
//  And what a loom "should make" took the pick of mixed elastics one per
//  elastic, not one per head — the model itself is trained per head.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, floor, handover, pm;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const DATE = '2026-10-21';

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  floor = require('../../services/floorEntry');
  handover = require('../../services/shiftHandover');
  pm = require('../../services/productionModel');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'Customer', 'Order', 'Elastic']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ff@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

async function scene() {
  const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9100000077' });
  const elastic = await M.Elastic.create({ name: '20mm ff', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({ orderNo: 5001, customer: customer._id, status: 'InProgress', po: 'PO-1', date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }] });
  const job = await M.JobOrder.create({ date: new Date(), order: order._id, customer: customer._id, status: 'weaving', elastics: [{ elastic: elastic._id, quantity: 100000 }] });
  const loom = (ID, heads) => M.Machine.create({
    ID, manufacturer: 'Comez', NoOfHead: heads, NoOfHooks: 8, status: 'running', orderRunning: job._id,
    elastics: Array.from({ length: heads }, (_, head) => ({ head, elastic: elastic._id })),
  });
  const four = await loom('F4', 4);
  const two = await loom('T2', 2);
  const ravi = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  const { createShiftPlan } = require('../../services/shiftPlanCreate');
  const { shiftPlan } = await createShiftPlan({ date: DATE, shiftType: 'DAY', machines: [{ machine: four._id, operator: ravi._id }, { machine: two._id, operator: ravi._id }] });
  const entry = (m) => M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id, machine: m._id }).lean();
  // F4: entered at 300 a head, waiting to be verified.
  await M.ShiftDetail.updateOne({ _id: (await entry(four))._id }, { $set: { status: 'pending_verification', submittedProductionMeters: 300, submittedTimer: '7:30:00' } });
  // T2: entered at 250 a head, and verified by the office.
  const t2 = await entry(two);
  await M.ShiftDetail.updateOne({ _id: t2._id }, { $set: { status: 'pending_verification', submittedProductionMeters: 250, submittedTimer: '7:00:00' } });
  const verified = await post('/shift/verify-production', { shiftId: String(t2._id), productionMeters: 250, timer: '7:00:00' });
  expect(verified.status).toBe(200);
  expect(await entry(two)).toMatchObject({ status: 'closed', productionMeters: 500, headsRun: 2 });
  return { four, two, elastic };
}

describe('what a loom made, on the floor\'s view of the shift', () => {
  it('is a head in one figure and the loom in another, verified or not', async () => {
    await scene();
    const state = await floor.shiftState({ dateKey: DATE, shift: 'DAY' });
    const by = Object.fromEntries(state.machines.map((m) => [m.ID, m]));
    // Waiting: a head as entered, the loom across the heads it runs.
    expect(by.F4).toMatchObject({ entry: 'entered', headsRunning: 4 });
    expect(by.F4.detail.submitted).toMatchObject({ production: 300, total: 1200, timer: '7:30:00' });
    // Verified: still a head in "production" — the screens print it "m/head".
    expect(by.T2).toMatchObject({ entry: 'verified' });
    expect(by.T2.detail.submitted).toMatchObject({ production: 250, total: 500, timer: '7:00:00' });
  });

  it('adds up to the shift\'s metres in the handover', async () => {
    await scene();
    const f = await handover.figures({ dateKey: DATE, shift: 'DAY' });
    // 4 heads × 300 + 2 heads × 250.
    expect(f.metres.made).toBe(1700);
    const n = await handover.note({ dateKey: DATE, shift: 'DAY' });
    expect(n.text).toContain('Metres: 1,700');
  });

  it('a shift verified before the heads it ran were kept is divided by the loom\'s heads', async () => {
    const { two } = await scene();
    await M.ShiftDetail.collection.updateOne({ machine: two._id }, { $unset: { headsRun: '' } });
    const state = await floor.shiftState({ dateKey: DATE, shift: 'DAY' });
    expect(state.machines.find((m) => m.ID === 'T2').detail.submitted).toMatchObject({ production: 250, total: 500 });
  });
});

describe('what a loom should make, with different picks on its heads', () => {
  it('takes the pick a head at a time, as the model is trained', async () => {
    const a = await M.Elastic.create({ name: 'pick ten', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 10, noOfHook: 8, weight: 2.4 });
    const b = await M.Elastic.create({ name: 'pick twenty', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 20, noOfHook: 8, weight: 2.4 });
    const loom = await M.Machine.create({ ID: 'MX', manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 8, status: 'free', elastics: [] });
    // Three heads at pick 10 and one at pick 20 make the length of four heads at 11.43, not at 13.33.
    const mixed = await pm.expectFor({ machineId: loom._id, elasticIds: [a._id, a._id, a._id, b._id] });
    expect(mixed).toMatchObject({ pickProblem: 'mixed', pick: 11.43 });
    expect(mixed.machine.headsRunning).toBe(4);
    expect(mixed.elastics.map((e) => [e.name, e.heads])).toEqual([['pick ten', 3], ['pick twenty', 1]]);
    // One pick on every head is that pick; none is said.
    expect(await pm.expectFor({ machineId: loom._id, elasticIds: [a._id, a._id] })).toMatchObject({ pickProblem: null, pick: 10 });
    expect(await pm.expectFor({ machineId: loom._id, elasticIds: [] })).toMatchObject({ pickProblem: 'no-elastics', pick: null });
  });
});
