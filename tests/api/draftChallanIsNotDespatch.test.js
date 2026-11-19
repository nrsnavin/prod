'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DRAFT CHALLAN HAS NOT LEFT THE BUILDING
//
//  Found reading api/orderMaterials.js and api/orderDetail.js line by
//  line, then following the same question through every place that
//  reads delivery challans.
//
//  A challan is made out as a draft, marked dispatched when the goods
//  leave, and delivered when the customer takes them. The challan
//  module's own figures, the dispatch report, the morning digest, the
//  customer portal, the invoice form and the complaint trail all hold
//  that a draft has not left ("paperwork sitting in a drawer"). Five
//  places counted it as gone:
//
//    • the order page — "delivered" per product, and the warning shown
//      before an order is completed ("1,000 of 1,000 delivered");
//    • the order's delivery-challan panel — "despatched";
//    • the order book report's on-time delivery — a draft scored, and
//      scored on time, with the moment it was keyed as its despatch;
//    • the order's costing — "invoiced so far";
//    • the evening report's deliveries, which did not look at the
//      status at all: a challan CANCELLED today was one of today's
//      deliveries, with its metres and its value.
//
//  The order page and panel now say what is on a draft challan
//  separately, so a challan made out is still seen.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'Customer', 'Elastic', 'DeliveryChallan']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'draft-dc@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
/** An order for 1,000 m of one elastic at ₹10, due on the 25th. */
async function scene() {
  seq += 1;
  const elastic = await M.Elastic.create({ name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const order = await M.Order.create({
    customer: customer._id, status: 'InProgress', po: `ACME-${seq}`, date: new Date('2026-11-01'), supplyDate: new Date('2026-11-25'),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
    pendingElastic: [{ elastic: elastic._id, quantity: 0 }],
    producedElastic: [{ elastic: elastic._id, quantity: 1000 }],
    packedElastic: [{ elastic: elastic._id, quantity: 1000 }],
  });
  return { elastic, customer, order };
}
/** A challan against the order, written as the app keeps one. */
const challan = (s, status, quantity, over = {}) => {
  seq += 1;
  return M.DeliveryChallan.collection.insertOne({
    dcNumber: `DC-T-${seq}`, type: 'elastic', financialYear: '26-27', sequence: seq,
    order: s.order._id, orderNo: s.order.orderNo, customerName: 'Acme', status,
    dispatchDate: new Date('2026-11-20T06:00:00Z'),
    items: [{ elastic: s.elastic._id, elasticName: '20mm', quantity, unit: 'm', rate: 10, amount: quantity * 10 }],
    totalQuantity: quantity, totalAmount: quantity * 10, totalBoxes: 0,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  });
};
const page = async (s) => {
  const res = await get(`/order/get-orderDetail?id=${s.order._id}`);
  if (res.status >= 400) throw new Error(`order detail failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.elastics[0];
};
const panel = async (s) => (await get(`/order/${s.order._id}/delivery-challans`)).body.data;

// ══════════════════════════════════════════════════════════════════
describe('the order page', () => {
  it('does not call goods on a draft challan delivered', async () => {
    const s = await scene();
    await challan(s, 'draft', 400);
    const row = await page(s);
    // Before: delivered 400, undelivered 600.
    expect(row).toMatchObject({ delivered: 0, undelivered: 1000, onDraftChallan: 400 });
  });

  it('counts what has been dispatched or delivered, and nothing cancelled', async () => {
    const s = await scene();
    await challan(s, 'dispatched', 300);
    await challan(s, 'delivered', 200.5);
    await challan(s, 'draft', 100);
    await challan(s, 'cancelled', 999);
    expect(await page(s)).toMatchObject({ delivered: 500.5, undelivered: 499.5, onDraftChallan: 100 });
  });
});

describe('the order\'s delivery-challan panel', () => {
  it('shows a draft as made out, not as despatched', async () => {
    const s = await scene();
    await challan(s, 'draft', 400);
    await challan(s, 'dispatched', 250);
    const data = await panel(s);

    // Before: dispatched 650.
    expect(data.lines[0]).toMatchObject({ ordered: 1000, dispatched: 250, drafted: 400, pending: 350 });
    expect(data.totals).toMatchObject({ count: 2, cancelled: 0, ordered: 1000, dispatched: 250, drafted: 400 });
    // Both notes are still listed, each with its status.
    expect(data.dcs.map((d) => d.status).sort()).toEqual(['dispatched', 'draft']);
  });

  it('adds decimals up as figures', async () => {
    const s = await scene();
    await challan(s, 'dispatched', 0.1);
    await challan(s, 'dispatched', 0.2);
    const data = await panel(s);
    // Before: 0.30000000000000004 on the line.
    expect(data.lines[0].dispatched).toBe(0.3);
    expect(data.totals.dispatched).toBe(0.3);
  });

  it('a cancelled note is listed and counts for nothing', async () => {
    const s = await scene();
    await challan(s, 'cancelled', 400);
    const data = await panel(s);
    expect(data.lines[0]).toMatchObject({ dispatched: 0, drafted: 0, pending: 1000 });
    expect(data.totals).toMatchObject({ count: 1, cancelled: 1 });
  });
});

describe('on-time delivery on the order book report', () => {
  // Required when used, not when the file is read: the server sets up
  // its models' shared fields as it starts (app.js), and a model loaded
  // before that is a different model.
  const report = () => require('../../services/reports/orderBookReport.js').orderBookReport({ from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z'), now: new Date('2026-11-21T05:00:00Z') });

  it('does not score a draft', async () => {
    const s = await scene();
    await challan(s, 'draft', 400);
    // Before: considered 1, 100% on time — a challan nobody had sent.
    expect((await report()).summary).toMatchObject({ otdConsidered: 0, onTimePct: null });
  });

  it('scores what was dispatched or delivered', async () => {
    const s = await scene();
    await challan(s, 'dispatched', 400);
    await challan(s, 'delivered', 100, { dispatchDate: new Date('2026-11-27T06:00:00Z') });   // two days late
    await challan(s, 'draft', 100);
    expect((await report()).summary).toMatchObject({ otdConsidered: 2, onTimePct: 50 });
  });
});

describe('the evening report\'s deliveries', () => {
  const buildEveningReportData = (now) => require('../../utils/eveningReport.js').buildEveningReportData(now);
  const NOW = new Date('2026-11-20T12:00:00Z');   // half past five in the evening, India

  it('are the challans that left today — not a draft, and not one cancelled', async () => {
    const s = await scene();
    await challan(s, 'dispatched', 300);
    await challan(s, 'delivered', 200);
    await challan(s, 'draft', 100);
    await challan(s, 'cancelled', 999);
    const d = await buildEveningReportData(NOW);
    // Before: 4 challans, 1,599 m, ₹15,990 — the cancelled one's 999 m among them.
    expect(d.deliveries).toMatchObject({ count: 2, totalQuantity: 500, totalAmount: 5000 });
    expect(d.deliveries.items.map((i) => i.totalQuantity).sort()).toEqual([200, 300]);
  });
});

describe('"invoiced so far" on the order\'s costing', () => {
  const orderPnl = (id) => require('../../services/orderPnl.js').orderPnl(id);

  it('is the value of what has left, not of a draft', async () => {
    const s = await scene();
    await challan(s, 'draft', 400);
    await challan(s, 'dispatched', 250);
    const pnl = await orderPnl(s.order._id);
    // Before: ₹6,500 on 2 challans.
    expect(pnl.revenue.invoiced).toMatchObject({ amount: 2500, quantity: 250, challans: 1 });
  });
});
