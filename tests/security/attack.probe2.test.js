'use strict';
// ══════════════════════════════════════════════════════════════════
//  ADVERSARIAL PROBE — ROUND TWO
//
//  Round one's numeric probes recorded "OK" on results that were not
//  OK: a selling rate of 1e308 was ACCEPTED and stored, and a null
//  rate silently became 0. The rule was "did it store something
//  finite and non-negative", which 1e308 satisfies while being
//  nonsense money.
//
//  This round asks the sharper question: does the figure that reaches
//  the P&L survive contact with the input?
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = 'probe2-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { orderPnl } = require('../../services/orderPnl');

let mongo, app, M = {}, admin, fx;
const findings = [];
const record = (area, probe, outcome, detail) => findings.push({ area, probe, outcome, detail });
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'CostSettings']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({
    name: 'Admin', email: 'p2-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  const cust = await M.Customer.create({ name: 'C', contactName: 'X', phoneNumber: '9000000000' });
  const el = await M.Elastic.create({
    name: 'E', weaveType: '8', spandexEnds: 40, pick: 30, noOfHook: 12, weight: 5,
  });
  const order = await M.Order.create({
    date: new Date(), po: 'P2', customer: cust._id, supplyDate: new Date(),
    status: 'InProgress', elasticOrdered: [{ elastic: el._id, quantity: 100, rate: 10 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: cust._id, status: 'weaving',
    producedElastic: [{ elastic: el._id, quantity: 100 }],
  });
  fx = { cust, el, order, job };
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  /* eslint-disable no-console */
  console.log('\n\n════════ PROBE ROUND 2 ════════');
  for (const f of findings) {
    console.log(`${pad(f.outcome, 11)} ${pad(f.area, 20)} ${pad(f.probe, 40)} ${f.detail}`);
  }
  const bad = findings.filter((f) => f.outcome !== 'OK');
  console.log(`\n${bad.length} of ${findings.length} probes flagged\n`);
});

const setRate = (rate) =>
  request(app).put(`/api/v2/pnl/order/${fx.order._id}/rates`).set('Cookie', adminCookie())
    .send({ rates: [{ elastic: String(fx.el._id), rate }] });

const resetRate = () => setRate(10);

// ══════════════════════════════════════════════════════════════════
//  Money with no ceiling. A fat-fingered exponent does not look like
//  an error anywhere downstream — it becomes the order value, the
//  margin, and the page total on the P&L list.
describe('F2. money has no upper bound', () => {
  afterEach(resetRate);

  test('a selling rate of 1e308 is accepted', async () => {
    const res = await setRate(1e308);
    const pnl = await orderPnl(fx.order._id);
    record('F2. money', 'selling rate 1e308',
      res.status === 400 ? 'OK' : 'VULNERABLE',
      `→ ${res.status}, order value now ${pnl.revenue.orderValue}`);
    expect(res.status).toBe(400);
  });

  test('and it overflows the P&L to Infinity', async () => {
    await setRate(1e308);
    const pnl = await orderPnl(fx.order._id);
    const broken = !Number.isFinite(pnl.revenue.orderValue) || pnl.revenue.orderValue > 1e15;
    record('F2. money', 'P&L survives an absurd rate',
      broken ? 'VULNERABLE' : 'OK',
      `orderValue=${pnl.revenue.orderValue} profit=${pnl.totals.profit} margin=${pnl.totals.marginPct}`);
    expect(broken).toBe(false);
  });

  test('the rate card accepts 1e308, re-costing every order in the factory', async () => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', adminCookie())
      .send({ overheadRatePerMeter: 1e308 });
    const pnl = await orderPnl(fx.order._id);
    record('F2. money', 'rate card 1e308 (factory-wide)',
      res.status === 400 ? 'OK' : 'VULNERABLE',
      `→ ${res.status}, this order's overhead now ${pnl.costs.overhead}`);
    expect(res.status).toBe(400);
    await request(app).put('/api/v2/pnl/settings').set('Cookie', adminCookie())
      .send({ overheadRatePerMeter: 0 });
  });

  test('a job cost override of 1e308 is accepted', async () => {
    const res = await request(app).put(`/api/v2/pnl/job/${fx.job._id}/cost-overrides`)
      .set('Cookie', adminCookie()).send({ finishing: 1e308 });
    const pnl = await orderPnl(fx.order._id);
    record('F2. money', 'job override 1e308',
      res.status === 400 ? 'OK' : 'VULNERABLE',
      `→ ${res.status}, finishing now ${pnl.costs.finishing}`);
    expect(res.status).toBe(400);
    await request(app).put(`/api/v2/pnl/job/${fx.job._id}/cost-overrides`)
      .set('Cookie', adminCookie()).send({ finishing: null });
  });
});

// ══════════════════════════════════════════════════════════════════
//  null is not a number. Number(null) is 0, and 0 on a selling rate
//  is the app's own signal for "not priced" — so a null silently
//  un-prices a line and answers 200 OK.
describe('F3. null coerces to zero', () => {
  afterEach(resetRate);

  test('a null selling rate is accepted and stored as 0', async () => {
    const res = await setRate(null);
    const stored = (await M.Order.findById(fx.order._id).lean()).elasticOrdered[0].rate;
    record('F3. null', 'null selling rate',
      res.status === 400 ? 'OK' : 'VULNERABLE',
      `→ ${res.status}, stored ${stored} (0 means "not priced")`);
    expect(res.status).toBe(400);
  });

  test('an empty-string selling rate is accepted and stored as 0', async () => {
    const res = await setRate('');
    const stored = (await M.Order.findById(fx.order._id).lean()).elasticOrdered[0].rate;
    record('F3. null', 'empty-string selling rate',
      res.status === 400 ? 'OK' : 'VULNERABLE', `→ ${res.status}, stored ${stored}`);
    expect(res.status).toBe(400);
  });

  test('a boolean selling rate is accepted and stored as 1', async () => {
    const res = await setRate(true);
    const stored = (await M.Order.findById(fx.order._id).lean()).elasticOrdered[0].rate;
    record('F3. null', 'boolean selling rate',
      res.status === 400 ? 'OK' : 'VULNERABLE', `→ ${res.status}, stored ${stored}`);
    expect(res.status).toBe(400);
  });

  test('a null rate-card figure is accepted and zeroes the line', async () => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', adminCookie())
      .send({ finishingRatePerMeter: 2, checkingRatePerMeter: null });
    const doc = await M.CostSettings.findOne({ key: 'cost' }).lean();
    record('F3. null', 'null rate-card figure',
      res.status === 400 ? 'OK' : 'VULNERABLE',
      `→ ${res.status}, checking rate now ${doc?.checkingRatePerMeter}`);
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('H2. cost of a request', () => {
  test('the P&L list is not quadratic in the number of orders', async () => {
    // 40 orders, each with a job — the list costs every one of them.
    for (let i = 0; i < 40; i++) {
      const o = await M.Order.create({
        date: new Date(), po: `BULK-${i}`, customer: fx.cust._id, supplyDate: new Date(),
        status: 'Approved', elasticOrdered: [{ elastic: fx.el._id, quantity: 100, rate: 5 }],
      });
      await M.JobOrder.create({
        date: new Date(), order: o._id, customer: fx.cust._id, status: 'weaving',
      });
    }
    const t0 = Date.now();
    const res = await request(app).get('/api/v2/pnl/orders?limit=50').set('Cookie', adminCookie());
    const ms = Date.now() - t0;
    record('H2. cost', 'P&L list of 41 orders',
      ms > 5000 ? 'VULNERABLE' : ms > 1500 ? 'REVIEW' : 'OK',
      `${ms}ms for ${res.body.rows?.length} rows (~${Math.round(ms / (res.body.rows?.length || 1))}ms each)`);
  });

  test('a P&L PDF for an order with many jobs still renders', async () => {
    const big = await M.Order.create({
      date: new Date(), po: 'BIG', customer: fx.cust._id, supplyDate: new Date(),
      status: 'Approved', elasticOrdered: [{ elastic: fx.el._id, quantity: 100, rate: 5 }],
    });
    for (let i = 0; i < 120; i++) {
      await M.JobOrder.create({
        date: new Date(), order: big._id, customer: fx.cust._id, status: 'weaving',
        producedElastic: [{ elastic: fx.el._id, quantity: 10 }],
      });
    }
    const t0 = Date.now();
    const res = await request(app).get(`/api/v2/pnl/order/${big._id}.pdf`)
      .set('Cookie', adminCookie()).buffer().parse((r, cb) => {
        const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c)));
      });
    const ms = Date.now() - t0;
    record('H2. cost', 'PDF for a 120-job order',
      res.status !== 200 ? 'VULNERABLE' : ms > 8000 ? 'REVIEW' : 'OK',
      `→ ${res.status}, ${ms}ms, ${res.body?.length ?? 0} bytes`);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('I2. error surfaces', () => {
  test('a rejected CORS origin is not reported as a server fault', async () => {
    const res = await request(app).get('/api/v2/order/list?status=all')
      .set('Cookie', adminCookie()).set('Origin', 'https://evil.example');
    record('I2. errors', 'CORS rejection status code',
      res.status === 500 ? 'REVIEW' : 'OK',
      `→ ${res.status} (a denial reported as 5xx pollutes error monitoring)`);
    expect(res.status).not.toBe(500);
  });

  test('a malformed order id on the PDF route is a clean 4xx', async () => {
    const res = await request(app).get('/api/v2/pnl/order/not-an-id.pdf')
      .set('Cookie', adminCookie());
    record('I2. errors', 'malformed id on the PDF route',
      res.status >= 500 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  test('malformed JSON is a 400, not a crash', async () => {
    const res = await request(app).put('/api/v2/pnl/settings').set('Cookie', adminCookie())
      .set('Content-Type', 'application/json').send('{"finishingRatePerMeter":');
    record('I2. errors', 'malformed JSON body',
      res.status >= 500 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });

  test('a date filter of garbage does not 500 the P&L list', async () => {
    const res = await request(app).get('/api/v2/pnl/orders?from=not-a-date&to=%00')
      .set('Cookie', adminCookie());
    record('I2. errors', 'garbage date filter',
      res.status >= 500 ? 'VULNERABLE' : 'OK', `→ ${res.status}`);
  });
});
