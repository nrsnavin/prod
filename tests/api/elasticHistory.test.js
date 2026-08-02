'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHERE AN ELASTIC HAS BEEN
//
//  The elastic detail page could say how much of a product is on the
//  shelf and nothing at all about who buys it or when it was last run.
//  These two lists answer that: the orders that asked for it and the
//  jobs that made it, both paginated, because a product in the
//  catalogue for years has hundreds of each.
//
//  The trap throughout is the shared document. An order carries four
//  products and a job two; every quantity reported here has to be THIS
//  elastic's line, never the order's total. That mistake reads as a
//  plausible number, which is why it is asked for repeatedly below.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Elastic, Customer, Order, JobOrder, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Elastic  = require('../../models/Elastic');
  Customer = require('../../models/Customer');
  Order    = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  User     = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeElastic = (name) =>
  Elastic.create({
    name, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });

const makeCustomer = (name) =>
  Customer.create({ name, contactName: 'R', phoneNumber: '9000000001' });

const makeOrder = (customer, lines, over = {}) =>
  Order.create({
    orderNo: Math.floor(Math.random() * 1000000),
    customer: customer._id, status: 'Approved', po: 'PO-1',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: lines.ordered,
    producedElastic: lines.produced || [],
    packedElastic: lines.packed || [],
    ...over,
  });

const makeJob = (order, customer, lines, over = {}) =>
  JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: lines.planned,
    producedElastic: lines.produced || [],
    packedElastic: lines.packed || [],
    wastageElastic: lines.wastage || [],
    ...over,
  });

const orders = (elastic, query = '') =>
  request(app).get(`/api/v2/elastic/${elastic._id}/orders${query}`).set('Cookie', adminCookie());
const jobs = (elastic, query = '') =>
  request(app).get(`/api/v2/elastic/${elastic._id}/jobs${query}`).set('Cookie', adminCookie());

// ── Orders ────────────────────────────────────────────────────────────

describe("the orders that asked for an elastic", () => {
  it('lists an order that carries it, with the customer who wanted it', async () => {
    const e = await makeElastic('20mm');
    const c = await makeCustomer('Acme');
    await makeOrder(c, { ordered: [{ elastic: e._id, quantity: 1000 }] });

    const { body } = await orders(e);
    expect(body.total).toBe(1);
    expect(body.orders[0]).toMatchObject({ customerName: 'Acme', ordered: 1000 });
  });

  it('leaves out an order that does not carry it', async () => {
    const [mine, theirs] = [await makeElastic('20mm'), await makeElastic('30mm')];
    const c = await makeCustomer('Acme');
    await makeOrder(c, { ordered: [{ elastic: theirs._id, quantity: 800 }] });

    const { body } = await orders(mine);
    expect(body.total).toBe(0);
    expect(body.orders).toEqual([]);
  });

  it("reports this elastic's line, not the order's total", async () => {
    // The failure this guards is quiet: 1,800 is a believable number for
    // an order, and nothing about it says it belongs to two products.
    const [mine, other] = [await makeElastic('20mm'), await makeElastic('30mm')];
    const c = await makeCustomer('Acme');
    await makeOrder(c, {
      ordered: [
        { elastic: mine._id, quantity: 600 },
        { elastic: other._id, quantity: 1200 },
      ],
      produced: [
        { elastic: mine._id, quantity: 200 },
        { elastic: other._id, quantity: 900 },
      ],
      packed: [{ elastic: other._id, quantity: 900 }],
    });

    const { body } = await orders(mine);
    expect(body.orders[0]).toMatchObject({ ordered: 600, produced: 200, packed: 0 });
  });

  it('hides a deleted order unless asked for it', async () => {
    const e = await makeElastic('20mm');
    const c = await makeCustomer('Acme');
    await makeOrder(c, { ordered: [{ elastic: e._id, quantity: 500 }] }, { status: 'Deleted' });

    expect((await orders(e)).body.total).toBe(0);
    expect((await orders(e, '?includeDeleted=true')).body.total).toBe(1);
  });

  it('pages, newest first, and says whether there is more', async () => {
    const e = await makeElastic('20mm');
    const c = await makeCustomer('Acme');
    for (let i = 0; i < 5; i += 1) {
      await makeOrder(c, { ordered: [{ elastic: e._id, quantity: 100 * (i + 1) }] },
        { date: new Date(2026, 0, i + 1) });
    }

    const first = (await orders(e, '?page=1&limit=2')).body;
    expect(first.orders).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(first.hasMore).toBe(true);
    // Newest first: the 5th order was placed last.
    expect(first.orders[0].ordered).toBe(500);

    const last = (await orders(e, '?page=3&limit=2')).body;
    expect(last.orders).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it('refuses a limit big enough to be a denial of service', async () => {
    const e = await makeElastic('20mm');
    const { body } = await orders(e, '?limit=100000');
    expect(body.limit).toBe(100);
  });
});

// ── Jobs ──────────────────────────────────────────────────────────────

describe('the jobs that made an elastic', () => {
  it('lists a job with what it planned, made, packed and wasted', async () => {
    const e = await makeElastic('20mm');
    const c = await makeCustomer('Acme');
    const o = await makeOrder(c, { ordered: [{ elastic: e._id, quantity: 1000 }] });
    await makeJob(o, c, {
      planned: [{ elastic: e._id, quantity: 400 }],
      produced: [{ elastic: e._id, quantity: 380 }],
      packed: [{ elastic: e._id, quantity: 350 }],
      wastage: [{ elastic: e._id, quantity: 20 }],
    });

    const { body } = await jobs(e);
    expect(body.jobs[0]).toMatchObject({
      planned: 400, produced: 380, packed: 350, wastage: 20,
    });
  });

  it('names the order the job was raised against', async () => {
    // Without it the list is a row of job numbers with no way back to
    // why any of them exists.
    const e = await makeElastic('20mm');
    const c = await makeCustomer('Acme');
    const o = await makeOrder(c, { ordered: [{ elastic: e._id, quantity: 1000 }] });
    await makeJob(o, c, { planned: [{ elastic: e._id, quantity: 400 }] });

    const { body } = await jobs(e);
    expect(body.jobs[0].orderNo).toBe(o.orderNo);
    expect(body.jobs[0].orderId).toBe(String(o._id));
    expect(body.jobs[0].jobNo).toMatch(/^J-\d+$/);
  });

  it("reports this elastic's line on a job that carries two", async () => {
    const [mine, other] = [await makeElastic('20mm'), await makeElastic('30mm')];
    const c = await makeCustomer('Acme');
    const o = await makeOrder(c, { ordered: [{ elastic: mine._id, quantity: 1000 }] });
    await makeJob(o, c, {
      planned: [
        { elastic: mine._id, quantity: 300 },
        { elastic: other._id, quantity: 700 },
      ],
      produced: [{ elastic: other._id, quantity: 700 }],
    });

    const { body } = await jobs(mine);
    expect(body.jobs[0]).toMatchObject({ planned: 300, produced: 0 });
  });

  it('hides a cancelled job unless asked for it', async () => {
    const e = await makeElastic('20mm');
    const c = await makeCustomer('Acme');
    const o = await makeOrder(c, { ordered: [{ elastic: e._id, quantity: 1000 }] });
    await makeJob(o, c, { planned: [{ elastic: e._id, quantity: 400 }] }, { status: 'cancelled' });

    expect((await jobs(e)).body.total).toBe(0);
    expect((await jobs(e, '?includeCancelled=true')).body.total).toBe(1);
  });

  it('pages the same way the orders do', async () => {
    const e = await makeElastic('20mm');
    const c = await makeCustomer('Acme');
    const o = await makeOrder(c, { ordered: [{ elastic: e._id, quantity: 5000 }] });
    for (let i = 0; i < 4; i += 1) {
      await makeJob(o, c, { planned: [{ elastic: e._id, quantity: 100 }] },
        { date: new Date(2026, 0, i + 1) });
    }

    const { body } = await jobs(e, '?page=2&limit=3');
    expect(body.jobs).toHaveLength(1);
    expect(body.total).toBe(4);
    expect(body.hasMore).toBe(false);
  });
});

describe('the bad inputs', () => {
  it('rejects an id that is not one', async () => {
    const res = await request(app).get('/api/v2/elastic/not-an-id/orders').set('Cookie', adminCookie());
    expect(res.status).toBe(400);
  });

  it('404s for an elastic that does not exist', async () => {
    const res = await request(app)
      .get(`/api/v2/elastic/${new mongoose.Types.ObjectId()}/jobs`)
      .set('Cookie', adminCookie());
    expect(res.status).toBe(404);
  });
});
