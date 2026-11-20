'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PORTAL: NOTHING IS "STILL TO COME" ON A CANCELLED ORDER
//
//  Found reading api/portal/data.js line by line.
//
//  An order's page tells the customer what is still to come: ordered
//  less dispatched, line by line. It said so whatever the order's state,
//  so a cancelled order read "This order was cancelled" under "Still to
//  come 1,500 m" — a promise the page itself had just withdrawn.
//
//  On a cancelled order nothing is to come. What had not been supplied
//  when it was cancelled is said as that.
//
//  A COMPLETED order is left as it was, on purpose. "Completed" here is
//  the day its last job finished (services/orderLifecycle.js), which is
//  often before the last lorry: a challan can be raised against a
//  completed order and usually is. Its remainder may be boxes waiting to
//  go, or metres that were never made — the order does not say which.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, M, buyer, e20, e25;
const cookie = () => [`portalToken=${jwt.sign({ id: buyer._id, role: 'customer', v: buyer.tokenVersion ?? 0 }, process.env.PORTAL_JWT_SECRET_KEY || process.env.JWT_SECRET_KEY, { audience: 'portal', algorithm: 'HS256', expiresIn: '1h' })}`];
const get = (url) => request(app).get(`/api/v3/portal${url}`).set('Cookie', cookie());
let n = 0;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const x of ['Customer', 'CustomerUser', 'Elastic', 'Order', 'DeliveryChallan']) M[x] = require(`../../models/${x}.js`);
  const acme = await M.Customer.create({ name: 'Acme Garments', gstin: '33AAAAA0000A1Z5', contactName: 'B', phoneNumber: '9000000001' });
  buyer = await M.CustomerUser.create({ customer: acme._id, name: 'Buyer', email: 'buyer@acme.test', password: 'cotton-reel-7', role: 'buyer' });
  const spec = { weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 };
  e20 = await M.Elastic.create({ name: '20mm', ...spec });
  e25 = await M.Elastic.create({ name: '25mm', ...spec });
  M.acme = acme;
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const order = async (status, sent20 = 0) => {
  n += 1;
  const o = await M.Order.create({
    date: new Date('2026-07-01'), po: `PO-${n}`, customer: M.acme._id, supplyDate: new Date('2026-07-20'), status,
    elasticOrdered: [{ elastic: e20._id, quantity: 1000, rate: 11 }, { elastic: e25._id, quantity: 500, rate: 13 }],
    producedElastic: [{ elastic: e20._id, quantity: sent20 }],
  });
  if (sent20) {
    await M.DeliveryChallan.create({
      dcNumber: `DC/2026/${String(n).padStart(4, '0')}`, type: 'elastic', financialYear: '2026-27', sequence: n, customerName: 'Acme Garments',
      dispatchDate: new Date('2026-07-12'), order: o._id, orderNo: o.orderNo, status: 'dispatched',
      items: [{ elastic: e20._id, elasticName: '20mm', unit: 'm', quantity: sent20, rate: 11, amount: sent20 * 11 }], totalQuantity: sent20, totalAmount: sent20 * 11,
    });
  }
  return o;
};
const page = async (o) => (await get(`/orders/${o._id}`)).body.order;

describe('what is still to come on an order', () => {
  it('is nothing on a cancelled order: what was not supplied is said as that', async () => {
    const o = await page(await order('Cancelled'));
    expect(o.stage).toBe('cancelled');
    // Before: toCome 1000 and 500 — 1,500 m "still to come" on a cancelled order.
    expect(o.lines.map((l) => [l.name, l.toCome, l.notSupplied])).toEqual([['20mm', 0, 1000], ['25mm', 0, 500]]);
    expect(o.totals).toEqual({ ordered: 1500, produced: 0, dispatched: 0, toCome: 0 });
    expect(o.notSupplied).toBe(1500);
  });

  it('cancelled after part of it had left: what left stays, the rest was not supplied', async () => {
    const o = await page(await order('Cancelled', 300));
    expect(o.lines.map((l) => [l.name, l.dispatched, l.toCome, l.notSupplied])).toEqual([['20mm', 300, 0, 700], ['25mm', 0, 0, 500]]);
    expect(o.totals).toEqual({ ordered: 1500, produced: 300, dispatched: 300, toCome: 0 });
    expect(o.notSupplied).toBe(1200);
    expect(o.dispatches).toHaveLength(1);
  });

  it('a completed order keeps its remainder as to come: its boxes may be waiting for the lorry', async () => {
    const o = await page(await order('Completed', 300));
    expect(o.stage).toBe('completed');
    expect(o.lines.map((l) => [l.name, l.toCome, l.notSupplied])).toEqual([['20mm', 700, 0], ['25mm', 500, 0]]);
    expect(o.totals.toCome).toBe(1200);
    expect(o.notSupplied).toBe(0);
  });

  it('a completed order supplied in full has nothing left either way', async () => {
    const full = await order('Completed', 1000);
    await M.DeliveryChallan.create({
      dcNumber: 'DC/2026/9001', type: 'elastic', financialYear: '2026-27', sequence: 9001, customerName: 'Acme Garments', dispatchDate: new Date('2026-07-13'),
      order: full._id, orderNo: full.orderNo, status: 'delivered',
      items: [{ elastic: e25._id, elasticName: '25mm', unit: 'm', quantity: 500, rate: 13, amount: 6500 }], totalQuantity: 500, totalAmount: 6500,
    });
    const o = await page(full);
    expect(o.totals).toEqual({ ordered: 1500, produced: 1000, dispatched: 1500, toCome: 0 });
    expect(o.notSupplied).toBe(0);
  });

  it('is ordered less dispatched while the order is open (unchanged)', async () => {
    for (const status of ['Open', 'Approved', 'InProgress']) {
      const o = await page(await order(status, 300));
      expect(o.lines.map((l) => [l.toCome, l.notSupplied])).toEqual([[700, 0], [500, 0]]);
      expect(o.totals.toCome).toBe(1200);
      expect(o.notSupplied).toBe(0);
    }
  });
});
