'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDER-LEVEL P&L
//
//  Every cost line is derived from a document that already exists, so
//  the failure mode this suite is built around is not a wrong sum — it
//  is a line that quietly reads ZERO because the document it comes from
//  was never written, or was written without a price. A P&L that
//  reports a confident profit built on four zeroes is worse than no
//  P&L, so the warnings are asserted as hard as the arithmetic.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { orderPnl } = require('../../services/orderPnl');

let mongo, app, M = {}, admin;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

const MODELS = [
  'User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'Employee',
  'ShiftDetail', 'RawMaterial', 'DeliveryChallan', 'CostSettings',
];

let seq = 0;
const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of MODELS) M[n] = require(`../../models/${n}.js`);
  M.MaterialOutward = require('../../models/MaterialOut.cjs');

  admin = await M.User.create({
    name: 'Owner', email: 'pnl-owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// A clean rate card between tests — it is a singleton, so one test
// setting it would otherwise silently cost every later test's job.
beforeEach(async () => {
  await M.CostSettings.deleteMany({});
});

// ── Fixtures ─────────────────────────────────────────────────────
const makeElastic = (name) =>
  M.Elastic.create({
    name, weaveType: '8', spandexEnds: 40, pick: 30, noOfHook: 12, weight: 5,
  });

const makeEmployee = (name, hourlyRate) =>
  M.Employee.create({ name, department: 'weaving', skill: 1, hourlyRate });

async function makeOrder({ lines, status = 'Approved' } = {}) {
  const customer = await M.Customer.create({
    name: `Acme ${++seq}`, contactName: 'Ms Rao', phoneNumber: '9000000001',
  });
  return M.Order.create({
    customer: customer._id,
    po: `PO-${seq}`,
    date: new Date('2026-03-01'),
    supplyDate: new Date('2026-06-30'),
    status,
    elasticOrdered: lines,
  });
}

async function makeJob(order, over = {}) {
  return M.JobOrder.create({
    order: order._id, customer: order.customer, date: new Date('2026-03-02'),
    status: 'weaving', ...over,
  });
}

/** A shift on a job. shiftPlan/machine are refs this P&L never reads. */
const makeShift = (job, employee, over = {}) =>
  M.ShiftDetail.create({
    date: new Date('2026-03-03'), shift: 'DAY', job: job._id,
    employee: employee._id, shiftPlan: oid(), machine: oid(),
    status: 'closed', productionMeters: 0, ...over,
  });

const getPnl = (orderId) =>
  request(app).get(`/api/v2/pnl/order/${orderId}`).set('Cookie', adminCookie());

// ══════════════════════════════════════════════════════════════════
describe('revenue', () => {
  test('comes from the rate on the order lines, not from dispatch', async () => {
    const e = await makeElastic('E-Rev');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 1000, rate: 18 }] });

    const pnl = await orderPnl(order._id);
    expect(pnl.revenue.orderValue).toBe(18000);
    // Nothing has shipped, so nothing is invoiced — and that does NOT
    // make the order's revenue zero.
    expect(pnl.revenue.invoiced.amount).toBe(0);
    expect(pnl.revenue.invoiced.challans).toBe(0);
  });

  test('reports the challan value alongside, once goods ship', async () => {
    const e = await makeElastic('E-Ship');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 1000, rate: 18 }] });
    await M.DeliveryChallan.create({
      dcNumber: `DC-${++seq}`, type: 'elastic', financialYear: '2026-27', sequence: seq,
      order: order._id, customerName: 'Acme', status: 'dispatched',
      items: [{ elastic: e._id, quantity: 400, rate: 18, amount: 7200 }],
      totalQuantity: 400, totalAmount: 7200,
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.revenue.orderValue).toBe(18000);
    expect(pnl.revenue.invoiced).toMatchObject({ amount: 7200, quantity: 400, challans: 1 });
  });

  test('a cancelled challan is not invoiced revenue', async () => {
    const e = await makeElastic('E-Cancel');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    await M.DeliveryChallan.create({
      dcNumber: `DC-${++seq}`, type: 'elastic', financialYear: '2026-27', sequence: seq,
      order: order._id, customerName: 'Acme', status: 'cancelled',
      items: [{ elastic: e._id, quantity: 100, rate: 10, amount: 1000 }],
      totalQuantity: 100, totalAmount: 1000,
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.revenue.invoiced.amount).toBe(0);
  });

  // An unpriced line is the difference between "this order lost money"
  // and "nobody typed the price in".
  test('names the unpriced lines instead of reporting a false loss', async () => {
    const a = await makeElastic('E-Priced');
    const b = await makeElastic('E-Unpriced');
    const order = await makeOrder({
      lines: [
        { elastic: a._id, quantity: 100, rate: 20 },
        { elastic: b._id, quantity: 500, rate: 0 },
      ],
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.revenue.orderValue).toBe(2000);
    expect(pnl.warnings.join(' ')).toMatch(/E-Unpriced/);
    expect(pnl.warnings.join(' ')).toMatch(/revenue is understated/i);
  });

  test('margin on an order with no price is unknown, not minus one hundred percent', async () => {
    const e = await makeElastic('E-NoPrice');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 0 }] });
    const job = await makeJob(order);
    const emp = await makeEmployee('Ravi', 50);
    await makeShift(job, emp);

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.total).toBeGreaterThan(0);
    expect(pnl.totals.profit).toBeLessThan(0);
    expect(pnl.totals.marginPct).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('labour, from the shifts on the job', () => {
  test('charges the scheduled shift at the employee hourly rate', async () => {
    const e = await makeElastic('E-Lab');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const job = await makeJob(order);
    const emp = await makeEmployee('Ravi', 50);
    await makeShift(job, emp);                       // 12h × 50
    await makeShift(job, emp, { shift: 'NIGHT' });   // 12h × 50

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.labour).toBe(1200);
    expect(pnl.jobs[0].labour).toMatchObject({ amount: 1200, shifts: 2, hours: 24 });
  });

  // The whole point of the "scheduled shift" basis: idle loom time is
  // paid for, so it belongs to the job that held the machine.
  test('a shift that produced nothing still costs its full wage', async () => {
    const e = await makeElastic('E-Idle');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const job = await makeJob(order);
    const emp = await makeEmployee('Idle Op', 40);
    await makeShift(job, emp, { productionMeters: 0, timer: '00:00:00' });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.labour).toBe(480);
  });

  test('an open shift is not charged, and is counted in the warnings', async () => {
    const e = await makeElastic('E-Open');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const job = await makeJob(order);
    const emp = await makeEmployee('Planned Op', 50);
    await makeShift(job, emp, { status: 'open' });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.labour).toBe(0);
    expect(pnl.jobs[0].labour.openShifts).toBe(1);
    expect(pnl.warnings.join(' ')).toMatch(/still open and not yet costed/i);
  });

  test('an employee with no hourly rate is called out rather than costed silently at zero', async () => {
    const e = await makeElastic('E-NoRate');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const job = await makeJob(order);
    const emp = await makeEmployee('Unrated Op', 0);
    await makeShift(job, emp);

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.labour).toBe(0);
    expect(pnl.warnings.join(' ')).toMatch(/no hourly rate set/i);
  });

  test("another order's shifts never land on this order", async () => {
    const e = await makeElastic('E-Iso');
    const mine = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const theirs = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const emp = await makeEmployee('Shared Op', 100);
    await makeShift(await makeJob(mine), emp);
    await makeShift(await makeJob(theirs), emp);

    expect((await orderPnl(mine._id)).costs.labour).toBe(1200);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('yarn issued', () => {
  test('is valued at the price captured when it was issued', async () => {
    const e = await makeElastic('E-Yarn');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const rm = await M.RawMaterial.create({ name: 'Spandex 40D', category: 'spandex', price: 900 });

    await M.MaterialOutward.create({
      rawMaterial: rm._id, quantity: 10, order: order._id,
      type: 'ORDER_APPROVAL', unitPrice: 900,
    });
    // The price has since moved. The order was costed at what it paid.
    rm.price = 1200;
    await rm.save();

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.material).toBe(9000);
  });

  test('a reversed draw is refunded, not charged', async () => {
    const e = await makeElastic('E-Refund');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const rm = await M.RawMaterial.create({ name: 'Nylon', category: 'yarn', price: 500 });
    await M.MaterialOutward.create({
      rawMaterial: rm._id, quantity: 4, order: order._id,
      type: 'ORDER_APPROVAL', unitPrice: 500, reversed: true,
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.material).toBe(0);
  });

  test('material issued to the job counts too, alongside the order draw', async () => {
    const e = await makeElastic('E-Both');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const job = await makeJob(order);
    const rm = await M.RawMaterial.create({ name: 'Polyester', category: 'yarn', price: 200 });

    await M.MaterialOutward.create({
      rawMaterial: rm._id, quantity: 5, order: order._id, type: 'ORDER_APPROVAL', unitPrice: 200,
    });
    await M.MaterialOutward.create({
      rawMaterial: rm._id, quantity: 2, job: job._id, type: 'JOB_CONSUMPTION', unitPrice: 200,
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.material).toBe(1400);
  });

  test('yarn issued with no price recorded is named in the warnings', async () => {
    const e = await makeElastic('E-Free');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });
    const rm = await M.RawMaterial.create({ name: 'Mystery Yarn', category: 'yarn', price: 0 });
    await M.MaterialOutward.create({
      rawMaterial: rm._id, quantity: 8, order: order._id, type: 'ORDER_APPROVAL', unitPrice: 0,
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.material).toBe(0);
    expect(pnl.warnings.join(' ')).toMatch(/Mystery Yarn/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the conversion rate card', () => {
  const rateCard = () =>
    M.CostSettings.create({
      key: 'cost',
      finishingRatePerMeter: 2, checkingRatePerMeter: 1,
      packingRatePerMeter: 0.5, overheadRatePerMeter: 3,
    });

  async function producedOrder(meters) {
    const e = await makeElastic(`E-Rate-${++seq}`);
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: meters, rate: 20 }] });
    const job = await makeJob(order, {
      producedElastic: [{ elastic: e._id, quantity: meters }],
    });
    return { order, job, e };
  }

  test('charges each line at its rate × produced meters', async () => {
    await rateCard();
    const { order } = await producedOrder(1000);

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.finishing).toBe(2000);
    expect(pnl.costs.checking).toBe(1000);
    expect(pnl.costs.packing).toBe(500);
    expect(pnl.costs.overhead).toBe(3000);
  });

  test('a job override wins over the rate, and says which basis it used', async () => {
    await rateCard();
    const { order, job } = await producedOrder(1000);
    await M.JobOrder.updateOne({ _id: job._id }, { $set: { 'costOverrides.finishing': 3500 } });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.finishing).toBe(3500);
    expect(pnl.jobs[0].finishing).toEqual({ amount: 3500, basis: 'override' });
    // The lines with no override still come off the rate card.
    expect(pnl.jobs[0].checking).toEqual({ amount: 1000, basis: 'rate' });
  });

  // 0 and null are different answers to "what did finishing cost?" —
  // one is "nothing", the other is "nobody said".
  test('an override of zero is honoured, not treated as absent', async () => {
    await rateCard();
    const { order, job } = await producedOrder(1000);
    await M.JobOrder.updateOne({ _id: job._id }, { $set: { 'costOverrides.finishing': 0 } });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.finishing).toBe(0);
    expect(pnl.jobs[0].finishing.basis).toBe('override');
  });

  test('an unset rate card charges nothing and says so out loud', async () => {
    const { order } = await producedOrder(1000);

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.finishing + pnl.costs.checking + pnl.costs.packing + pnl.costs.overhead).toBe(0);
    expect(pnl.warnings.join(' ')).toMatch(/rate card has never been set/i);
  });

  test('no production means the rate card charges nothing, and says why', async () => {
    await rateCard();
    const e = await makeElastic('E-Nothing');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 500, rate: 20 }] });
    await makeJob(order);

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.finishing).toBe(0);
    expect(pnl.warnings.join(' ')).toMatch(/No production recorded/i);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('outsourced jobs', () => {
  test('bill job-work on the meters that came BACK, not what was sent', async () => {
    const e = await makeElastic('E-Vendor');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 1000, rate: 30 }] });
    await makeJob(order, {
      productionMode: 'outsource', outsourceVendor: 'Sunrise Weaving',
      outsourcing: { qtySentMeters: 1000, qtyReceivedMeters: 940, ratePerMeter: 12 },
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.jobWork).toBe(11280);   // 940 × 12, not 1000 × 12
    expect(pnl.costs.labour).toBe(0);        // no shifts run here
  });

  // Produced meters drive the whole rate card, and an outsourced job's
  // output never lands in producedElastic — so reading it from there
  // would cost the entire back half of the process at zero.
  test("count the vendor's returned meters as the job's production", async () => {
    await M.CostSettings.create({ key: 'cost', finishingRatePerMeter: 2, overheadRatePerMeter: 3 });
    const e = await makeElastic('E-VendorMeters');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 1000, rate: 30 }] });
    await makeJob(order, {
      productionMode: 'outsource', outsourceVendor: 'Sunrise Weaving',
      outsourcing: { qtySentMeters: 1000, qtyReceivedMeters: 940, ratePerMeter: 12 },
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.totals.producedMeters).toBe(940);
    expect(pnl.costs.finishing).toBe(1880);
    expect(pnl.costs.overhead).toBe(2820);
  });

  test('a vendor with no agreed rate is named rather than costed at zero', async () => {
    const e = await makeElastic('E-NoVendorRate');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 30 }] });
    await makeJob(order, {
      productionMode: 'outsource', outsourceVendor: 'Cheap Weaving',
      outsourcing: { qtySentMeters: 100, qtyReceivedMeters: 95 },
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.jobWork).toBe(0);
    expect(pnl.warnings.join(' ')).toMatch(/no rate per meter/i);
  });

  test('an in-house job is never charged job-work', async () => {
    const e = await makeElastic('E-InHouse');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 30 }] });
    await makeJob(order, {
      // Stray vendor figures on an in-house job must not become money.
      outsourcing: { qtyReceivedMeters: 100, ratePerMeter: 99 },
    });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.jobWork).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the bottom line', () => {
  test('adds up to profit and margin across every cost line', async () => {
    await M.CostSettings.create({
      key: 'cost', finishingRatePerMeter: 2, checkingRatePerMeter: 1,
      packingRatePerMeter: 0.5, overheadRatePerMeter: 3,
    });

    const e = await makeElastic('E-Total');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 1000, rate: 40 }] });
    const job = await makeJob(order, { producedElastic: [{ elastic: e._id, quantity: 1000 }] });

    const emp = await makeEmployee('Ravi', 50);
    await makeShift(job, emp);                      // 600
    await makeShift(job, emp, { shift: 'NIGHT' });  // 600

    const rm = await M.RawMaterial.create({ name: 'Spandex', category: 'spandex', price: 900 });
    await M.MaterialOutward.create({
      rawMaterial: rm._id, quantity: 10, order: order._id, type: 'ORDER_APPROVAL', unitPrice: 900,
    });                                             // 9000

    const pnl = await orderPnl(order._id);
    expect(pnl.costs).toMatchObject({
      material: 9000, labour: 1200, jobWork: 0,
      finishing: 2000, checking: 1000, packing: 500, overhead: 3000,
    });
    expect(pnl.costs.total).toBe(16700);
    expect(pnl.revenue.orderValue).toBe(40000);
    expect(pnl.totals.profit).toBe(23300);
    expect(pnl.totals.marginPct).toBe(58.25);
    expect(pnl.totals.costPerMeter).toBe(16.7);
  });

  test('an order with no jobs reports zero cost and says why', async () => {
    const e = await makeElastic('E-Empty');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 10 }] });

    const pnl = await orderPnl(order._id);
    expect(pnl.costs.total).toBe(0);
    expect(pnl.warnings.join(' ')).toMatch(/no jobs yet/i);
  });

  test('an unknown order id is null rather than an empty P&L', async () => {
    expect(await orderPnl(oid())).toBeNull();
    expect(await orderPnl('not-an-id')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the endpoints', () => {
  test('GET /pnl/order/:id returns the breakdown', async () => {
    const e = await makeElastic('E-Api');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 25 }] });

    const res = await getPnl(order._id);
    expect(res.status).toBe(200);
    expect(res.body.pnl.revenue.orderValue).toBe(2500);
  });

  test('GET /pnl/order/:id 404s on an unknown order', async () => {
    const res = await getPnl(oid());
    expect(res.status).toBe(404);
  });

  test('PUT /pnl/order/:id/rates prices the lines and the P&L follows', async () => {
    const a = await makeElastic('E-RateA');
    const b = await makeElastic('E-RateB');
    const order = await makeOrder({
      lines: [
        { elastic: a._id, quantity: 100, rate: 0 },
        { elastic: b._id, quantity: 200, rate: 0 },
      ],
    });

    const res = await request(app)
      .put(`/api/v2/pnl/order/${order._id}/rates`)
      .set('Cookie', adminCookie())
      .send({ rates: [{ elastic: String(a._id), rate: 10 }, { elastic: String(b._id), rate: 5 }] });

    expect(res.status).toBe(200);
    expect((await orderPnl(order._id)).revenue.orderValue).toBe(2000);
  });

  // Pricing is agreed late and corrected often; refusing it on an
  // in-progress order would leave the P&L reporting a made-up margin.
  test('rates can be set on an order that is already in progress', async () => {
    const e = await makeElastic('E-Late');
    const order = await makeOrder({
      lines: [{ elastic: e._id, quantity: 100, rate: 0 }], status: 'InProgress',
    });

    const res = await request(app)
      .put(`/api/v2/pnl/order/${order._id}/rates`)
      .set('Cookie', adminCookie())
      .send({ rates: [{ elastic: String(e._id), rate: 12 }] });

    expect(res.status).toBe(200);
    expect((await orderPnl(order._id)).revenue.orderValue).toBe(1200);
  });

  test('a rate for an elastic that is not on the order is refused, not silently dropped', async () => {
    const e = await makeElastic('E-Wrong');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 5 }] });

    const res = await request(app)
      .put(`/api/v2/pnl/order/${order._id}/rates`)
      .set('Cookie', adminCookie())
      .send({ rates: [{ elastic: String(oid()), rate: 99 }] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/are on this order/i);
  });

  test('a negative rate is refused', async () => {
    const e = await makeElastic('E-Neg');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 5 }] });

    const res = await request(app)
      .put(`/api/v2/pnl/order/${order._id}/rates`)
      .set('Cookie', adminCookie())
      .send({ rates: [{ elastic: String(e._id), rate: -1 }] });

    expect(res.status).toBe(400);
  });

  test('PUT /pnl/job/:id/cost-overrides sets and then clears an override', async () => {
    await M.CostSettings.create({ key: 'cost', finishingRatePerMeter: 2 });
    const e = await makeElastic('E-Ovr');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 1000, rate: 20 }] });
    const job = await makeJob(order, { producedElastic: [{ elastic: e._id, quantity: 1000 }] });

    const set = await request(app)
      .put(`/api/v2/pnl/job/${job._id}/cost-overrides`)
      .set('Cookie', adminCookie())
      .send({ finishing: 3500, notes: 'Rework on 200 m' });
    expect(set.status).toBe(200);
    expect((await orderPnl(order._id)).costs.finishing).toBe(3500);

    // null hands the line back to the rate card.
    const clear = await request(app)
      .put(`/api/v2/pnl/job/${job._id}/cost-overrides`)
      .set('Cookie', adminCookie())
      .send({ finishing: null });
    expect(clear.status).toBe(200);
    expect((await orderPnl(order._id)).costs.finishing).toBe(2000);
  });

  test('GET + PUT /pnl/settings round-trips the rate card', async () => {
    const before = await request(app).get('/api/v2/pnl/settings').set('Cookie', adminCookie());
    expect(before.status).toBe(200);
    expect(before.body.settings.configured).toBe(false);

    const put = await request(app)
      .put('/api/v2/pnl/settings')
      .set('Cookie', adminCookie())
      .send({ finishingRatePerMeter: 2.5, overheadRatePerMeter: 4 });
    expect(put.status).toBe(200);

    const after = await request(app).get('/api/v2/pnl/settings').set('Cookie', adminCookie());
    expect(after.body.settings).toMatchObject({
      finishingRatePerMeter: 2.5, overheadRatePerMeter: 4, configured: true,
    });
  });

  test('a negative rate card figure is refused', async () => {
    const res = await request(app)
      .put('/api/v2/pnl/settings')
      .set('Cookie', adminCookie())
      .send({ finishingRatePerMeter: -1 });
    expect(res.status).toBe(400);
  });

  test('GET /pnl/orders ranks by margin with unpriced orders last', async () => {
    const e = await makeElastic('E-List');
    const good = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 100 }] });
    const unpriced = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 0 }] });

    const res = await request(app)
      .get('/api/v2/pnl/orders?sort=margin&limit=50')
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    const ids = res.body.rows.map((r) => r.id);
    expect(ids).toContain(String(good._id));
    // Whatever else is in the list, a null margin never outranks a real one.
    const firstNull = res.body.rows.findIndex((r) => r.marginPct === null);
    const lastReal = res.body.rows.map((r) => r.marginPct).lastIndexOf(
      [...res.body.rows].reverse().find((r) => r.marginPct !== null)?.marginPct ?? null
    );
    if (firstNull !== -1) expect(firstNull).toBeGreaterThan(lastReal - 1);
    expect(ids).toContain(String(unpriced._id));
    // The sort only orders the page it fetched, and the response admits it.
    expect(res.body.sortScope).toBe('page');
  });

  test('GET /pnl/orders caps the page size rather than costing every order', async () => {
    const res = await request(app)
      .get('/api/v2/pnl/orders?limit=5000')
      .set('Cookie', adminCookie());
    expect(res.body.limit).toBe(50);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Margin is exactly the thing you grant to some people and not
//  others, so it gets its own feature key rather than riding on the
//  orders screen.
describe('the /order-pnl feature gate', () => {
  // Created through the admin route, which is where a real feature list
  // is assigned. /sign-up is not public.
  const mkUser = async (over) => {
    const res = await request(app)
      .post('/api/v2/user/manage/create')
      .set('Cookie', adminCookie())
      .send({ name: 'PnlUser', password: 'pass1234', department: 'finance', ...over });
    if (!res.body?.user?.id) {
      throw new Error(`user create failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return res;
  };

  test('a finance user without /order-pnl cannot read a P&L', async () => {
    const c = await mkUser({ email: 'pnl-no@t.co', features: ['/orders'] });
    const res = await request(app)
      .get(`/api/v2/pnl/orders`)
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).toBe(403);
  });

  test('a finance user with /order-pnl can', async () => {
    const c = await mkUser({ email: 'pnl-yes@t.co', features: ['/order-pnl'] });
    const res = await request(app)
      .get(`/api/v2/pnl/orders`)
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).toBe(200);
  });

  test('reading an order does not imply seeing its margin', async () => {
    const e = await makeElastic('E-Gate');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 50 }] });
    const c = await mkUser({ email: 'pnl-orders-only@t.co', features: ['/orders'] });

    const res = await request(app)
      .get(`/api/v2/pnl/order/${order._id}`)
      .set('Cookie', cookie(c.body.user.id, 'accounts'));
    expect(res.status).toBe(403);
  });

  test('writing a selling rate needs the feature too', async () => {
    const e = await makeElastic('E-GateWrite');
    const order = await makeOrder({ lines: [{ elastic: e._id, quantity: 100, rate: 0 }] });
    const c = await mkUser({ email: 'pnl-write-no@t.co', features: ['/orders'] });

    const res = await request(app)
      .put(`/api/v2/pnl/order/${order._id}/rates`)
      .set('Cookie', cookie(c.body.user.id, 'accounts'))
      .send({ rates: [{ elastic: String(e._id), rate: 10 }] });
    expect(res.status).toBe(403);
  });
});
