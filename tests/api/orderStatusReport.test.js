'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDER STATUS REPORT
//
//  One order answered end to end: what was ordered, what each job has
//  reached, what the floor actually recorded, and what is still owed.
//
//  The two things worth guarding hardest:
//    • "pending" and "not yet planned" are different quantities and must
//      not be conflated — one is unfinished work, the other is work
//      nobody has started to plan
//    • a job whose back-reference on the order was never written still
//      appears, because that gap is what the report should surface
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const { buildOrderStatusPdf } = require('../../utils/orderStatusPdf');

let mongo, app, Order, JobOrder, Customer, Elastic, Machine, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  JobOrder = require('../../models/JobOrder');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  Machine = require('../../models/Machine');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const days = (n) => new Date(Date.now() + n * 86_400_000);

async function makeOrder(over = {}) {
  const customer = await Customer.create({
    name: 'Aravind Garments', contactName: 'Aravind', phoneNumber: '9111111111',
    address: 'Tiruppur', email: 'a@t.co', gstin: '33ABCDE1234F1Z5',
  });
  const elastic = await Elastic.create({
    name: '25mm Woven', weight: 5, noOfHook: 24, pick: 40, spandexEnds: 8,
  });
  const order = await Order.create({
    customer: customer._id, po: 'PO-9001', date: new Date(), supplyDate: days(20),
    elasticOrdered: [{ elastic: elastic._id, quantity: 5000 }],
    pendingElastic: [{ elastic: elastic._id, quantity: 5000 }],
    ...over,
  });
  return { order, customer, elastic };
}

const report = (id) =>
  request(app).get(`/api/v2/order/${id}/status-report`).set('Cookie', adminCookie());

describe('the order lines', () => {
  it('reports ordered, produced, packed and pending per elastic', async () => {
    const { order, elastic } = await makeOrder();
    await Order.updateOne({ _id: order._id }, {
      producedElastic: [{ elastic: elastic._id, quantity: 3000 }],
      packedElastic: [{ elastic: elastic._id, quantity: 2000 }],
      pendingElastic: [{ elastic: elastic._id, quantity: 2000 }],
    });

    const res = await report(order._id);
    expect(res.status).toBe(200);

    const [line] = res.body.data.lines;
    expect(line).toMatchObject({
      name: '25mm Woven', ordered: 5000, produced: 3000, packed: 2000, pending: 2000,
    });
    // Packed percentage is against what was ORDERED, so the columns on
    // the sheet add up rather than each using its own denominator.
    expect(line.packedPct).toBe(40);
  });

  it('treats an order with no jobs as wholly pending', async () => {
    const { order } = await makeOrder();
    const res = await report(order._id);
    expect(res.body.data.totals).toMatchObject({ ordered: 5000, pending: 5000, packed: 0 });
  });

  it('names an elastic whose master was deleted rather than dropping the line', async () => {
    const { order, elastic } = await makeOrder();
    await Elastic.deleteOne({ _id: elastic._id });

    const res = await report(order._id);
    expect(res.body.data.lines).toHaveLength(1);
    expect(res.body.data.lines[0].name).toBe('Unknown elastic');
    expect(res.body.data.lines[0].ordered).toBe(5000);
  });

  it('totals every line', async () => {
    const { order, elastic } = await makeOrder();
    const second = await Elastic.create({
      name: '32mm', weight: 6, noOfHook: 28, pick: 42, spandexEnds: 10,
    });
    await Order.updateOne({ _id: order._id }, {
      elasticOrdered: [
        { elastic: elastic._id, quantity: 5000 },
        { elastic: second._id, quantity: 3000 },
      ],
      pendingElastic: [
        { elastic: elastic._id, quantity: 1000 },
        { elastic: second._id, quantity: 3000 },
      ],
    });

    const res = await report(order._id);
    expect(res.body.data.totals.ordered).toBe(8000);
    expect(res.body.data.totals.pending).toBe(4000);
  });
});

describe('the job rows', () => {
  it('carries each job with its stage, machine and programme states', async () => {
    const { order, customer, elastic } = await makeOrder();
    const machine = await Machine.create({
      ID: 'M-01', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24,
    });
    await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      status: 'weaving', machine: machine._id,
      elastics: [{ elastic: elastic._id, quantity: 3000 }],
      producedElastic: [{ elastic: elastic._id, quantity: 1200 }],
    });

    const res = await report(order._id);
    const [job] = res.body.data.jobs;
    expect(job).toMatchObject({
      status: 'weaving', machine: 'M-01', planned: 3000, produced: 1200,
    });
    expect(job.jobNo).toMatch(/^J-\d+$/);
  });

  it('finds a job the order never back-referenced', async () => {
    // order.jobs[] is written separately from the job's own `order` ref.
    // Reading through the order would hide exactly the inconsistency this
    // report exists to show.
    const { order, customer, elastic } = await makeOrder();
    await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      elastics: [{ elastic: elastic._id, quantity: 2000 }],
    });
    expect((await Order.findById(order._id)).jobs).toHaveLength(0);

    const res = await report(order._id);
    expect(res.body.data.jobs).toHaveLength(1);
  });

  it('totals planned, produced and packed across jobs', async () => {
    const { order, customer, elastic } = await makeOrder();
    for (const q of [2000, 1500]) {
      await JobOrder.create({
        order: order._id, customer: customer._id, date: new Date(),
        elastics: [{ elastic: elastic._id, quantity: q }],
        producedElastic: [{ elastic: elastic._id, quantity: q / 2 }],
      });
    }

    const res = await report(order._id);
    expect(res.body.data.jobTotals).toMatchObject({ planned: 3500, produced: 1750 });
  });
});

describe('pending against not-yet-planned', () => {
  it('keeps them apart', async () => {
    // 5000 ordered, one job planned for 2000 — 3000 has no job at all.
    // Folding that into "pending" would hide which of the two needs a
    // decision from a person.
    const { order, customer, elastic } = await makeOrder();
    await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      elastics: [{ elastic: elastic._id, quantity: 2000 }],
    });

    const res = await report(order._id);
    expect(res.body.data.unplanned).toBe(3000);
    expect(res.body.data.totals.pending).toBe(5000);
  });

  it('reports nothing unplanned once every metre is on a job', async () => {
    const { order, customer, elastic } = await makeOrder();
    await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      elastics: [{ elastic: elastic._id, quantity: 5000 }],
    });

    const res = await report(order._id);
    expect(res.body.data.unplanned).toBe(0);
  });
});

describe('the delivery position', () => {
  it('flags an open order past its supply date', async () => {
    const { order } = await makeOrder({ supplyDate: days(-3), status: 'InProgress' });
    const res = await report(order._id);
    expect(res.body.data.overdue).toBe(true);
    expect(res.body.data.daysToSupply).toBe(-3);
  });

  it('flags one due within the week', async () => {
    const { order } = await makeOrder({ supplyDate: days(4), status: 'InProgress' });
    const res = await report(order._id);
    expect(res.body.data.dueSoon).toBe(true);
    expect(res.body.data.overdue).toBe(false);
  });

  it('does not call a completed order overdue', async () => {
    // Its date passing is not a problem once the work is done.
    const { order } = await makeOrder({ supplyDate: days(-30), status: 'Completed' });
    const res = await report(order._id);
    expect(res.body.data.overdue).toBe(false);
  });

  it('says nothing when there is no supply date', async () => {
    const { order } = await makeOrder();
    await Order.collection.updateOne({ _id: order._id }, { $unset: { supplyDate: '' } });
    const res = await report(order._id);
    expect(res.body.data.daysToSupply).toBeNull();
    expect(res.body.data.overdue).toBe(false);
  });
});

describe('the printed sheet', () => {
  it('renders a PDF for a real order', async () => {
    const { order, customer, elastic } = await makeOrder();
    await JobOrder.create({
      order: order._id, customer: customer._id, date: new Date(),
      elastics: [{ elastic: elastic._id, quantity: 2000 }],
    });

    const res = await request(app)
      .get(`/api/v2/order/${order._id}/status-report.pdf`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('renders from a bare object, with no database behind it', async () => {
    // The renderer is pure over the report data — worth keeping so the
    // layout can be exercised without standing a database up.
    const pdf = await buildOrderStatusPdf({
      orderNo: 1042, customerPo: 'PO-9001', customerName: 'Aravind Garments',
      orderDate: '01 Jul 2026', supplyDate: '20 Jul 2026', status: 'InProgress',
      lines: [], totals: { ordered: 0, produced: 0, packed: 0, pending: 0, packedPct: 0 },
      jobs: [], jobTotals: { planned: 0, produced: 0, packed: 0, shiftMeters: 0 },
      unplanned: 0, daysToSupply: 5, overdue: false, dueSoon: true,
    });
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });

  it('paginates a long order without falling over', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      jobNo: `J-${i + 1}`, date: '01 Jul 2026', status: 'weaving', machine: 'M-01',
      warping: 'completed', covering: 'open', planned: 1000, produced: 500, packed: 200,
      elastics: '25mm Woven', shiftCount: 3, shiftMeters: 480, productionMode: 'in_house',
      outsourceVendor: '',
    }));
    const pdf = await buildOrderStatusPdf({
      orderNo: 7, customerName: 'Aravind', status: 'InProgress',
      lines: [], totals: { ordered: 0, produced: 0, packed: 0, pending: 0, packedPct: 0 },
      jobs: many, jobTotals: { planned: 60000, produced: 30000, packed: 12000, shiftMeters: 28800 },
      unplanned: 0, daysToSupply: 3, overdue: false, dueSoon: true,
    });
    expect(pdf.length).toBeGreaterThan(4000);
  });

  it('404s for an order that does not exist', async () => {
    const res = await request(app)
      .get(`/api/v2/order/${new mongoose.Types.ObjectId()}/status-report.pdf`)
      .set('Cookie', adminCookie());
    expect(res.status).toBe(404);
  });

  it('rejects a malformed id rather than throwing', async () => {
    const res = await request(app)
      .get('/api/v2/order/not-an-id/status-report')
      .set('Cookie', adminCookie());
    expect(res.status).toBe(404);
  });
});
