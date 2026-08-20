'use strict';
// ══════════════════════════════════════════════════════════════════
//  SCANNING A JOB LABEL TO RAISE A CHALLAN
//
//  The challan is raised against an ORDER. The label taped to the
//  trolley names a JOB. /dc/job-order is that one hop, done on the
//  server so the phone never holds an order id it cannot resolve.
//
//  What these pin down, hardest first:
//
//    • the order that comes back is the scanned job's order, and it is
//      shaped exactly like /order-info — because the form fills itself
//      in from that shape and must not care which way it got there
//    • the job's own lines come back too, with what it PACKED, so the
//      form can open on the despatch rather than on the whole order
//    • every way this can fail says which failure it was, in words
//
//  The last one is the point. A label that reads perfectly and names a
//  job whose order was deleted looks, to the person holding the phone,
//  exactly like a camera that did not focus — unless the difference is
//  spelled out.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Order, Customer, Elastic, JobOrder, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order    = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic  = require('../../models/Elastic');
  JobOrder = require('../../models/JobOrder');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'dcscan@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;

const makeElastic = (name) =>
  Elastic.create({
    name: name ?? `20mm ${Math.random().toString(36).slice(2, 8)}`,
    weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12,
    noOfHook: 8, weight: 2.4, stock: 5000, reservedStock: 0,
  });

const makeCustomer = (over = {}) =>
  Customer.create({
    name: `Acme ${++seq}`, contactName: 'R. Nair', phoneNumber: '9000000001',
    gstin: '33AABCA1234A1Z5', ...over,
  });

async function makeOrder(customer, lines, over = {}) {
  return Order.create({
    customer: customer._id, status: 'Open', po: `PO-${++seq}`,
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: lines, rawMaterialRequired: [],
    ...over,
  });
}

const makeJob = (order, customer, over = {}) =>
  JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id,
    status: 'packing', elastics: [], packedElastic: [], ...over,
  });

const scan = (query) =>
  request(app).get('/api/v2/dc/job-order')
    .query(query).set('Cookie', adminCookie());

// ══════════════════════════════════════════════════════════════════
//  THE HOP
// ══════════════════════════════════════════════════════════════════
describe('a scanned job resolves to its order', () => {
  it('returns the order the job belongs to', async () => {
    const customer = await makeCustomer({ name: 'Vasanth Tapes' });
    const elastic  = await makeElastic();
    const order    = await makeOrder(customer, [{ elastic: elastic._id, quantity: 900 }]);
    const job      = await makeJob(order, customer);

    const res = await scan({ jobId: String(job._id) });

    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe(String(order._id));
    expect(res.body.orderNo).toBe(order.orderNo);
    expect(res.body.job.jobOrderNo).toBe(job.jobOrderNo);
  });

  it('carries the customer, so the form fills itself in', async () => {
    const customer = await makeCustomer({
      name: 'Vasanth Tapes', phoneNumber: '9876500011',
      gstin: '33ZZZZZ9999Z1Z9', contactName: 'Meera',
    });
    const elastic = await makeElastic();
    const order   = await makeOrder(customer, [{ elastic: elastic._id, quantity: 900 }]);
    const job     = await makeJob(order, customer);

    const { body } = await scan({ jobId: String(job._id) });

    expect(body.customer.name).toBe('Vasanth Tapes');
    expect(body.customer.phone).toBe('9876500011');
    expect(body.customer.gstin).toBe('33ZZZZZ9999Z1Z9');
    expect(body.customer.contact).toBe('Meera');
  });

  it('returns the SAME shape /order-info does', async () => {
    // The form is written against one shape. If these two ever drift,
    // a challan raised by scanning fills in differently from one
    // raised by searching — and nobody finds out until a field that
    // only the other path supplies goes out blank on a printed
    // challan.
    const customer = await makeCustomer();
    const elastic  = await makeElastic();
    const order    = await makeOrder(customer, [{ elastic: elastic._id, quantity: 900 }]);
    const job      = await makeJob(order, customer);

    const viaSearch = await request(app).get('/api/v2/dc/order-info')
      .query({ id: String(order._id) }).set('Cookie', adminCookie());
    const viaScan = await scan({ jobId: String(job._id) });

    for (const key of Object.keys(viaSearch.body)) {
      expect(viaScan.body[key]).toEqual(viaSearch.body[key]);
    }
  });

  it('resolves a hand-typed job number too', async () => {
    // The number is printed under the code precisely so a smudged
    // label is still usable.
    const customer = await makeCustomer();
    const elastic  = await makeElastic();
    const order    = await makeOrder(customer, [{ elastic: elastic._id, quantity: 900 }]);
    const job      = await makeJob(order, customer);

    const res = await scan({ jobNo: String(job.jobOrderNo) });

    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe(String(order._id));
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE JOB'S OWN LINES
// ══════════════════════════════════════════════════════════════════
describe('what the trolley actually holds', () => {
  it('returns the job lines with what it packed', async () => {
    const customer = await makeCustomer();
    const a = await makeElastic('Tape A');
    const b = await makeElastic('Tape B');
    const order = await makeOrder(customer, [
      { elastic: a._id, quantity: 900 },
      { elastic: b._id, quantity: 400 },
    ]);
    const job = await makeJob(order, customer, {
      elastics:      [{ elastic: a._id, quantity: 500 }],
      packedElastic: [{ elastic: a._id, quantity: 480 }],
    });

    const { body } = await scan({ jobId: String(job._id) });

    expect(body.jobLines).toHaveLength(1);
    expect(body.jobLines[0].elasticId).toBe(String(a._id));
    expect(body.jobLines[0].plannedQty).toBe(500);
    // 480, not the 900 the ORDER wants and not the 500 the job planned.
    expect(body.jobLines[0].packedQty).toBe(480);
  });

  it('CONTROL: the order still carries every line, not just the job\'s', async () => {
    // Without this, jobLines could be filtering `elastics` itself and
    // the test above would pass while the form lost the other half of
    // the order.
    const customer = await makeCustomer();
    const a = await makeElastic('Tape A');
    const b = await makeElastic('Tape B');
    const order = await makeOrder(customer, [
      { elastic: a._id, quantity: 900 },
      { elastic: b._id, quantity: 400 },
    ]);
    const job = await makeJob(order, customer, {
      elastics: [{ elastic: a._id, quantity: 500 }],
    });

    const { body } = await scan({ jobId: String(job._id) });

    expect(body.elastics).toHaveLength(2);
    expect(body.elastics.map((e) => e.orderedQty).sort()).toEqual([400, 900]);
  });

  it('reports zero packed for a job that has not reached packing', async () => {
    // A real answer, not a missing one. The form has to be able to
    // tell "packed nothing yet" from "no figure", because prefilling
    // a 0 that looks typed puts a zero-quantity line on a challan.
    const customer = await makeCustomer();
    const elastic  = await makeElastic();
    const order    = await makeOrder(customer, [{ elastic: elastic._id, quantity: 900 }]);
    const job      = await makeJob(order, customer, {
      status: 'weaving',
      elastics: [{ elastic: elastic._id, quantity: 500 }],
      packedElastic: [],
    });

    const { body } = await scan({ jobId: String(job._id) });

    expect(body.jobLines[0].packedQty).toBe(0);
    expect(body.job.status).toBe('weaving');
  });
});

// ══════════════════════════════════════════════════════════════════
//  SAYING WHICH FAILURE IT WAS
// ══════════════════════════════════════════════════════════════════
describe('when the scan does not resolve', () => {
  it('404s a well-formed id that names no job', async () => {
    const res = await scan({ jobId: String(new mongoose.Types.ObjectId()) });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/no job/i);
  });

  it('400s an id that is not an id', async () => {
    const res = await scan({ jobId: 'https://example.com/jobs/nope' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid job id/i);
  });

  it('404s a job number nobody has', async () => {
    const res = await scan({ jobNo: '99999' });
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/99999/);
  });

  it('refuses a request that means two things', async () => {
    const customer = await makeCustomer();
    const elastic  = await makeElastic();
    const order    = await makeOrder(customer, [{ elastic: elastic._id, quantity: 9 }]);
    const job      = await makeJob(order, customer);

    // Both given: resolving by parameter order would silently pick one.
    const both = await scan({ jobId: String(job._id), jobNo: '1' });
    expect(both.status).toBe(400);

    const neither = await scan({});
    expect(neither.status).toBe(400);
  });

  it('names the job when its order has been deleted', async () => {
    // The label is fine and the job is fine. Reporting this as "not
    // found" would send somebody to clean a camera lens.
    const customer = await makeCustomer();
    const elastic  = await makeElastic();
    const order    = await makeOrder(customer, [{ elastic: elastic._id, quantity: 900 }]);
    const job      = await makeJob(order, customer);
    await Order.deleteOne({ _id: order._id });

    const res = await scan({ jobId: String(job._id) });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(new RegExp(`#${job.jobOrderNo}\\b`));
    expect(res.body.message).toMatch(/no longer exists/i);
  });

  it('asks rather than guesses when two jobs share a number', async () => {
    // jobOrderNo is auto-incremented, so this means the data has been
    // through surgery. Picking one could put a different customer's
    // order onto the challan.
    const customer = await makeCustomer();
    const elastic  = await makeElastic();
    const o1 = await makeOrder(customer, [{ elastic: elastic._id, quantity: 900 }]);
    const o2 = await makeOrder(customer, [{ elastic: elastic._id, quantity: 100 }]);
    const j1 = await makeJob(o1, customer);
    await makeJob(o2, customer);
    // Force the collision the auto-increment would never produce.
    await JobOrder.collection.updateMany({}, { $set: { jobOrderNo: j1.jobOrderNo } });

    const res = await scan({ jobNo: String(j1.jobOrderNo) });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/more than one/i);
  });

  it('requires a login', async () => {
    const res = await request(app).get('/api/v2/dc/job-order')
      .query({ jobNo: '1' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

// ══════════════════════════════════════════════════════════════════
//  A CLOSED ORDER STILL DESPATCHES — BUT SAYS SO
// ══════════════════════════════════════════════════════════════════
describe('the order status comes back', () => {
  it('reports the status rather than refusing', async () => {
    // /create deliberately allows a DC against a closed order: the
    // goods still leave, there is simply no reservation to discharge.
    // So this must not gate — it must report, so the screen can warn.
    const customer = await makeCustomer();
    const elastic  = await makeElastic();
    const order    = await makeOrder(customer,
      [{ elastic: elastic._id, quantity: 900 }], { status: 'Completed' });
    const job      = await makeJob(order, customer);

    const res = await scan({ jobId: String(job._id) });

    expect(res.status).toBe(200);
    expect(res.body.orderStatus).toBe('Completed');
  });
});
