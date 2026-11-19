'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDERS DUE SOON, AND WHEN AN ORDER WILL BE DONE
//
//  Found reading api/orderProgress.js line by line.
//
//  1. "ORDERS AT DELIVERY RISK … WITH PENDING PRODUCTION" COUNTED THE
//     WRONG THING. GET /order/delivery-risk read "pending" off the
//     order's pendingElastic, which is what no job has been raised for
//     yet — not what is left to make. An order due tomorrow, planned in
//     full and with nothing woven, was never on the list. Now: what was
//     ordered less what is packed (the order page's "pending delivery"),
//     with what is not yet planned beside it.
//
//  2. THE DAYS WERE HOURS. An order due today read "1 day away" until
//     half past five in the morning, and the horizon's last day was in
//     or out depending on the hour.
//
//  3. THE ORDER LIST HAD NO ETA FOR AN ORDER WITH NO JOB YET. The list's
//     route loaded each order without its lines, so the estimate made
//     for an order nobody has planned ("on the plant's rate") found
//     nothing to estimate — while the order's own page showed one.
//
//  4. AN ORDER WHOSE JOB WAS NOT ON A LOOM YET HAD NO ETA AT ALL. With a
//     job still in preparation the estimate looked only at looms, found
//     none, and gave up — the day before, with no job, it had a date.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const DAY = 86_400_000;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'risk-eta@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** The calendar date `n` days from today in India, as the app keeps one (its UTC midnight). */
const dayFromToday = (n) => {
  const india = new Date(Date.now() + 5.5 * 3_600_000);
  return new Date(Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate()) + n * DAY);
};

let seq = 0;
async function makeOrder({ ordered = 1000, planned = 0, packed = 0, produced = 0, dueIn = 3, status = 'InProgress' } = {}) {
  seq += 1;
  const elastic = await M.Elastic.create({ name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const order = await M.Order.create({
    customer: customer._id, status, po: `ACME-${seq}`, date: dayFromToday(-10), supplyDate: dayFromToday(dueIn),
    elasticOrdered: [{ elastic: elastic._id, quantity: ordered }],
    pendingElastic: [{ elastic: elastic._id, quantity: Math.max(0, ordered - planned) }],
    producedElastic: [{ elastic: elastic._id, quantity: produced }],
    packedElastic: [{ elastic: elastic._id, quantity: packed }],
  });
  return { order, elastic, customer };
}
const risk = async (query = '') => {
  const res = await get(`/order/delivery-risk${query}`);
  if (res.status >= 400) throw new Error(`delivery-risk failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const rowFor = (body, s) => body.orders.find((o) => String(o.orderId) === String(s.order._id));

// ══════════════════════════════════════════════════════════════════
describe('orders at delivery risk', () => {
  it('lists an order planned in full with nothing made', async () => {
    const s = await makeOrder({ ordered: 1000, planned: 1000, packed: 0, dueIn: 1 });
    const body = await risk();
    // Before: not on the list — everything had a job, so nothing was "pending".
    expect(rowFor(body, s)).toMatchObject({ orderNo: s.order.orderNo, daysToSupply: 1, pendingUnits: 1000, notPlanned: 0 });
    expect(body.count).toBe(1);
  });

  it('counts what is still owed, and says how much of it has no job', async () => {
    const s = await makeOrder({ ordered: 1000, planned: 800, packed: 250.5, dueIn: 2 });
    // Before: pendingUnits 200 — the part nobody had planned.
    expect(rowFor(await risk(), s)).toMatchObject({ pendingUnits: 749.5, notPlanned: 200 });
  });

  it('leaves out an order that is packed in full, whatever was never planned', async () => {
    const s = await makeOrder({ ordered: 1000, planned: 900, packed: 1000, dueIn: 1 });
    // Before: listed, with 100 "pending".
    expect(rowFor(await risk(), s)).toBeUndefined();
  });

  it('a line packed over its quantity does not pay for one that is behind', async () => {
    const s = await makeOrder({ ordered: 1000, planned: 1000, packed: 1200, dueIn: 1 });
    const other = await M.Elastic.create({ name: 'Second line', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
    await M.Order.updateOne({ _id: s.order._id }, {
      $push: {
        elasticOrdered: { elastic: other._id, quantity: 500 },
        packedElastic: { elastic: other._id, quantity: 100 },
        pendingElastic: { elastic: other._id, quantity: 0 },
      },
    });
    expect(rowFor(await risk(), s)).toMatchObject({ pendingUnits: 400 });
  });

  it('counts days as days: due today is 0, overdue is negative, soonest first', async () => {
    const today = await makeOrder({ dueIn: 0, planned: 1000 });
    const late = await makeOrder({ dueIn: -2, planned: 1000 });
    const week = await makeOrder({ dueIn: 7, planned: 1000 });
    const beyond = await makeOrder({ dueIn: 8, planned: 1000 });
    const body = await risk();
    expect(rowFor(body, today).daysToSupply).toBe(0);
    expect(rowFor(body, late).daysToSupply).toBe(-2);
    // The horizon's last day is inside it at any hour; the day after is not.
    expect(rowFor(body, week).daysToSupply).toBe(7);
    expect(rowFor(body, beyond)).toBeUndefined();
    expect(body.orders.map((o) => o.daysToSupply)).toEqual([-2, 0, 7]);
  });

  it('leaves out orders that will not ship', async () => {
    for (const status of ['Completed', 'Cancelled']) await makeOrder({ status, planned: 1000, dueIn: 1 });
    expect((await risk()).count).toBe(0);
  });

  it('takes a horizon, and nonsense for one is a week', async () => {
    const s = await makeOrder({ dueIn: 20, planned: 1000 });
    expect(rowFor(await risk('?horizonDays=30'), s)).toBeTruthy();
    expect(rowFor(await risk('?horizonDays=abc'), s)).toBeUndefined();
    const huge = await risk('?horizonDays=999999999999');
    expect(huge.horizonDays).toBe(365);
  });
});

describe('the day arithmetic, at the hours it used to go wrong', () => {
  const { deliveryRisk } = require('../../services/deliveryRisk');
  const order = (supplyDate) => ({
    _id: 'o1', orderNo: 7, status: 'InProgress', supplyDate,
    elasticOrdered: [{ elastic: 'a', quantity: 100 }], packedElastic: [], pendingElastic: [],
  });

  it('an order due today is due today at two in the morning', () => {
    // 02:00 on 20 Nov in India is 20:30 on the 19th, UTC.
    const now = new Date('2026-11-19T20:30:00Z');
    // Before: 1 — three and a half hours to the date's midnight, rounded up.
    expect(deliveryRisk([order(new Date('2026-11-20T00:00:00Z'))], { now })[0].daysToSupply).toBe(0);
    expect(deliveryRisk([order(new Date('2026-11-21T00:00:00Z'))], { now })[0].daysToSupply).toBe(1);
  });

  it('reads a date kept at India\'s midnight as the same day', () => {
    const now = new Date('2026-11-19T06:00:00Z');
    // 20 Nov, kept the older way: 18:30 UTC on the 19th.
    expect(deliveryRisk([order(new Date('2026-11-19T18:30:00Z'))], { now })[0].daysToSupply).toBe(1);
  });

  it('an order with no promised date is not on the list', () => {
    expect(deliveryRisk([order(null)], { now: new Date() })).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('when an order will be done', () => {
  const single = async (s) => (await get(`/order/${s.order._id}/running-eta`)).body;
  const inList = async (s) => (await post('/order/running-eta-bulk', { orderIds: [String(s.order._id)] })).body.etas[String(s.order._id)];

  it('the order list has an estimate for an approved order with no job, as its page does', async () => {
    const s = await makeOrder({ status: 'Approved', ordered: 50_000, dueIn: 30 });
    const page = await single(s);
    expect(page.ok).toBe(true);

    const row = await inList(s);
    // Before: { ok: false, reason: 'NOTHING_REMAINING' } — the order had been loaded without its lines.
    expect(row.ok).toBe(true);
    // The same day (each answer carries the moment it was worked out).
    expect(String(row.expectedDate).slice(0, 10)).toBe(String(page.expectedDate).slice(0, 10));
    expect(row.workingDays).toBe(page.workingDays);
  });

  it('an order whose job is still in preparation keeps its estimate', async () => {
    const s = await makeOrder({ status: 'InProgress', ordered: 50_000, planned: 50_000, dueIn: 30 });
    await M.JobOrder.create({
      date: new Date(), order: s.order._id, customer: s.customer._id, status: 'preparatory',
      elastics: [{ elastic: s.elastic._id, quantity: 50_000 }],
    });
    const page = await single(s);
    // Before: { ok: false, reason: 'NO_ACTIVE_JOBS' } — there is a job, but no loom yet.
    expect(page.ok).toBe(true);
    expect(page.expectedDate).toBeTruthy();
    expect((await inList(s)).ok).toBe(true);
  });

  it('an order with everything woven and its job in finishing has nothing left to estimate', async () => {
    const s = await makeOrder({ status: 'InProgress', ordered: 50_000, planned: 50_000, produced: 50_000, dueIn: 30 });
    await M.JobOrder.create({
      date: new Date(), order: s.order._id, customer: s.customer._id, status: 'finishing',
      elastics: [{ elastic: s.elastic._id, quantity: 50_000 }],
      producedElastic: [{ elastic: s.elastic._id, quantity: 50_000 }],
    });
    expect(await single(s)).toMatchObject({ ok: false, reason: 'NOTHING_REMAINING' });
  });

  it('the morning digest calls the same orders late, by the same number of days, as the risk list', async () => {
    const Machine = require('../../models/Machine.js');
    for (let i = 0; i < 4; i += 1) {
      await Machine.create({ ID: `L-${i}`, manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'), NoOfHead: 4, NoOfHooks: 8, status: 'free' });
    }
    // Far more than can be woven in five days: late on any count of looms.
    const s = await makeOrder({ status: 'Approved', ordered: 5_000_000, dueIn: 5 });

    const list = (await get('/order/eta-risks')).body.risks.find((r) => String(r.orderId) === String(s.order._id));
    expect(list).toBeTruthy();

    const { buildDigestData } = require('../../utils/digest.js');
    const inDigest = (await buildDigestData(new Date())).predictedLate.find((r) => r.orderNo === s.order.orderNo);
    expect(inDigest).toBeTruthy();
    // Before: the digest estimated on one loom where the list used the four that are free.
    expect(inDigest.lateWorkingDays).toBe(list.lateWorkingDays);
  });

  it('an order that is not running is told apart (unchanged)', async () => {
    const s = await makeOrder({ status: 'Open' });
    expect(await inList(s)).toMatchObject({ ok: false, reason: 'NOT_RUNNING' });
  });
});
