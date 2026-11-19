'use strict';
// ══════════════════════════════════════════════════════════════════
//  CHALLANS: DECIMAL METRES, ONE ELASTIC ON TWO LINES, AND A CHALLAN
//  THAT IS ON AN INVOICE
//
//  Found reading api/deliveryChallan.js, api/invoice.js and
//  utils/elasticStock.js line by line.
//
//  1. DECIMAL METRES. The forms take a quantity to two places. Stock
//     was moved with plain floating-point sums, so 2,224.3 − 36.1 left
//     2,188.2000000000003 on the shelf and the movement read
//     36.09999999999991 — less than the 36.1 asked for. The challan
//     took that for a shortfall: "Not enough in stock — shipping 36.1,
//     36.09999999999991 in stock", with two thousand metres on the
//     shelf. About one decimal despatch in seven.
//
//  2. ONE ELASTIC ON TWO LINES (the same product in two box sizes).
//     Undoing the challan undoes it line by line, but the ledger rows it
//     reads are per elastic. The first line gave back everything; the
//     second found the ledger square, fell back on the line's own note
//     of what it had taken from the order's reservation, and gave that
//     back again. An order for 1,000 ended up holding 1,300.
//
//  3. ON AN INVOICE. An invoice bills the customer for what its challans
//     carried, and nothing on an issued invoice is edited. But the
//     challan under it could still be cancelled — goods back on the
//     shelf, invoice and the customer's account unchanged — or have its
//     quantity changed, which only its boxes followed.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Customer, Elastic, Order, DeliveryChallan, StockMovement, Invoice, factoryDay, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post  = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put   = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const patch = (url, body) => request(app).patch(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const del   = (url) => request(app).delete(`/api/v2${url}`).set('Cookie', cookie());
const get   = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  Order = require('../../models/Order');
  DeliveryChallan = require('../../models/DeliveryChallan');
  StockMovement = require('../../models/StockMovement');
  Invoice = require('../../models/Invoice');
  factoryDay = require('../../utils/factoryDay');
  admin = await User.create({ name: 'Owner', email: 'dcstock@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
const makeElastic = (stock = 0, over = {}) => Elastic.create({
  name: `20mm Knitted ${++seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  stock, reservedStock: 0, ...over,
});
const makeCustomer = () => Customer.create({
  name: `Sunrise Garments ${++seq}`, contactName: 'Ravi', phoneNumber: '9000000001', gstin: '33AAEPS1111F1Z2',
  address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604',
});
const line = (e, quantity, over = {}) => ({ elastic: String(e._id), quantity, rate: 12, ...over });
const cut = (items, over = {}) => post('/dc/create', { type: 'elastic', customerName: 'Sunrise Garments', items, ...over });
const fresh = (e) => Elastic.findById(e._id).lean();
const heldFor = async (order, e) => ((await Order.findById(order._id).lean()).reservations || [])
  .filter((r) => String(r.elastic) === String(e._id)).reduce((s, r) => s + r.quantity, 0);

/** An approved order reserving `qty` of the elastic. */
async function approvedOrder(elastic, customer, qty) {
  const order = await Order.create({
    customer: customer._id, status: 'Open', po: `PO-${++seq}`, date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: qty, rate: 12.5 }], rawMaterialRequired: [],
  });
  const res = await post('/order/approve', { orderId: String(order._id) });
  if (res.status >= 400) throw new Error(`approve failed: ${JSON.stringify(res.body)}`);
  return Order.findById(order._id);
}

// ══════════════════════════════════════════════════════════════════
describe('a challan in decimal metres', () => {
  it.each([
    [2224.3, 36.1], [394.42, 31.82], [2645.05, 166.27], [1737.9, 198.8], [3507.42, 841.222],
  ])('ships %s m less %s m without being called short', async (stock, qty) => {
    const e = await makeElastic(stock);
    const res = await cut([line(e, qty)]);
    expect(res.status).toBe(201);
    expect(res.body.dc.stockShortfall).toBeUndefined();
    expect((await fresh(e)).stock).toBe(Math.round((stock - qty) * 1000) / 1000);
  });

  it('keeps the shelf and the ledger clean figures over a run of them', async () => {
    const e = await makeElastic(1);
    for (const q of [0.1, 0.2]) expect((await cut([line(e, q)])).status).toBe(201);
    // 1 − 0.1 − 0.2 is 0.7000000000000001 in floating point.
    expect((await fresh(e)).stock).toBe(0.7);
    const rows = await StockMovement.find({ elastic: e._id }).sort({ createdAt: 1 }).lean();
    expect(rows.map((r) => [r.applied, r.balance])).toEqual([[-0.1, 0.9], [-0.2, 0.7]]);
  });

  it('an edit in decimals is not called short either', async () => {
    const e = await makeElastic(2224.3);
    const dc = (await cut([line(e, 36.1)])).body.dc;
    const res = await put('/dc/update', { id: dc._id, auditReason: 'weighed again', items: [line(e, 40.2)] });
    expect(res.status).toBe(200);
    expect(res.body.dc.stockShortfall).toBeUndefined();
    expect((await fresh(e)).stock).toBe(2184.1);
  });

  it('still refuses a real shortfall, and says by how much', async () => {
    const e = await makeElastic(100.5);
    const res = await cut([line(e, 100.6)]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DC_STOCK_SHORT');
    expect(res.body.details.shortfalls[0]).toMatchObject({ shipping: 100.6, onHand: 100.5, short: 0.1 });
    expect((await fresh(e)).stock).toBe(100.5);
    expect(await DeliveryChallan.countDocuments()).toBe(0);
  });

  it('and one found only as the goods are taken (an edit upwards)', async () => {
    const e = await makeElastic(100.5);
    const dc = (await cut([line(e, 50)])).body.dc;
    const res = await put('/dc/update', { id: dc._id, auditReason: 'more on the lorry', items: [line(e, 100.6)] });
    expect(res.status).toBe(409);
    expect(res.body.details.shortfalls[0]).toMatchObject({ shipping: 100.6, onHand: 100.5, short: 0.1 });
    // Refused whole: the 50 is still out.
    expect((await fresh(e)).stock).toBe(50.5);
  });

  it("leaves the order's reservation a clean figure, and none once it is all sent", async () => {
    const e = await makeElastic(2000.5);
    const order = await approvedOrder(e, await makeCustomer(), 1000.3);
    expect((await cut([line(e, 36.1)], { orderId: String(order._id) })).status).toBe(201);
    expect(await heldFor(order, e)).toBe(964.2);
    expect((await fresh(e)).reservedStock).toBe(964.2);

    expect((await cut([line(e, 964.2)], { orderId: String(order._id) })).status).toBe(201);
    // Nothing left of it: not a sliver of a millimetre still "reserved".
    expect((await Order.findById(order._id).lean()).reservations).toEqual([]);
    expect(await fresh(e)).toMatchObject({ stock: 1000.2, reservedStock: 0 });
  });

  it('keeps the value to the paisa and the total quantity to the millimetre', async () => {
    const e = await makeElastic(5000);
    const dc = (await cut([line(e, 1234.5, { rate: 0.07 }), line(e, 0.1, { rate: 3 }), line(e, 0.2, { rate: 3 })])).body.dc;
    expect(dc.items.map((i) => i.amount)).toEqual([86.42, 0.3, 0.6]);
    expect(dc.totalAmount).toBe(87.32);
    expect(dc.totalQuantity).toBe(1234.8);
  });

  it('the stock check finds no drift after decimal movements', async () => {
    const e = await makeElastic(0);
    for (const delta of [2224.3, -36.1, 0.1, 0.2, -1737.9, 394.42, -31.82, 0.07]) {
      const res = await post(`/elastic/${e._id}/adjust-stock`, { delta, reason: 'recount', force: true });
      expect(res.status).toBe(200);
    }
    const res = await get('/elastic/reconcile');
    expect(res.status).toBe(200);
    expect(res.body.drifts).toEqual([]);
    expect((await fresh(e)).stock).toBe(813.27);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('one elastic on two lines of a challan', () => {
  /** An order for 1,000; a challan of 400 + 300 of it. */
  async function scene() {
    const e = await makeElastic(5000);
    const order = await approvedOrder(e, await makeCustomer(), 1000);
    const res = await cut([line(e, 400, { boxes: 4 }), line(e, 300, { boxes: 3 })], { orderId: String(order._id) });
    expect(res.status).toBe(201);
    expect(await fresh(e)).toMatchObject({ stock: 4300, reservedStock: 300 });
    expect(await heldFor(order, e)).toBe(300);
    return { e, order, dc: res.body.dc };
  }

  it('cancelled: the goods and the promise come back once', async () => {
    const { e, order, dc } = await scene();
    expect((await patch('/dc/update-status', { id: dc._id, status: 'cancelled' })).status).toBe(200);
    // Before: reservedStock 1,300, and the order holding 1,300 of the 1,000 it ordered.
    expect(await fresh(e)).toMatchObject({ stock: 5000, reservedStock: 1000 });
    expect(await heldFor(order, e)).toBe(1000);
  });

  it('edited: the new lines are taken from what the order really holds', async () => {
    const { e, order, dc } = await scene();
    const res = await put('/dc/update', {
      id: dc._id, auditReason: 'one roll short', items: [line(e, 400, { boxes: 4 }), line(e, 250, { boxes: 3 })],
    });
    expect(res.status).toBe(200);
    expect(await fresh(e)).toMatchObject({ stock: 4350, reservedStock: 350 });
    expect(await heldFor(order, e)).toBe(350);
  });

  it('deleted as a draft: the same', async () => {
    const { e, order, dc } = await scene();
    expect((await del(`/dc/delete?id=${dc._id}`)).status).toBe(200);
    expect(await fresh(e)).toMatchObject({ stock: 5000, reservedStock: 1000 });
    expect(await heldFor(order, e)).toBe(1000);
  });

  it('a challan from before the ledger kept the promise gives back what both lines took', async () => {
    const { e, order, dc } = await scene();
    // As those rows were written: the goods, and nothing about the reservation.
    await StockMovement.collection.updateMany(
      { refId: new mongoose.Types.ObjectId(String(dc._id)) },
      { $unset: { reservedRequested: '', reservedApplied: '', reservedBalance: '' } },
    );
    expect((await patch('/dc/update-status', { id: dc._id, status: 'cancelled' })).status).toBe(200);
    expect(await fresh(e)).toMatchObject({ stock: 5000, reservedStock: 1000 });
    expect(await heldFor(order, e)).toBe(1000);
  });

  it('two different elastics are each undone, as before', async () => {
    const a = await makeElastic(1000);
    const b = await makeElastic(1000);
    const dc = (await cut([line(a, 100), line(b, 200)])).body.dc;
    expect((await patch('/dc/update-status', { id: dc._id, status: 'cancelled' })).status).toBe(200);
    expect((await fresh(a)).stock).toBe(1000);
    expect((await fresh(b)).stock).toBe(1000);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a challan that is on an invoice', () => {
  async function invoiced() {
    const e = await makeElastic(5000);
    const customer = await makeCustomer();
    const order = await Order.create({
      customer: customer._id, po: 'PO-9', date: new Date(), supplyDate: new Date(), status: 'InProgress',
      elasticOrdered: [{ elastic: e._id, quantity: 1000, rate: 12.5 }],
    });
    const dc = (await cut([line(e, 600, { boxes: 6 })], { orderId: String(order._id) })).body.dc;
    expect((await patch('/dc/update-status', { id: dc._id, status: 'dispatched' })).status).toBe(200);
    const raised = await post('/invoice/create', { orderId: String(order._id), dcIds: [dc._id], invoiceDate: factoryDay.ymd() });
    expect(raised.status).toBe(201);
    return { e, order, dc, invoice: raised.body.invoice };
  }

  it('is not cancelled while the invoice stands', async () => {
    const { e, dc, invoice } = await invoiced();
    const res = await patch('/dc/update-status', { id: dc._id, status: 'cancelled' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DC_ON_INVOICE');
    expect(res.body.message).toContain(invoice.invoiceNumber);
    expect(res.body.details).toMatchObject({ invoiceNumber: invoice.invoiceNumber, invoice: String(invoice._id) });
    expect((await DeliveryChallan.findById(dc._id).lean()).status).toBe('dispatched');
    expect((await fresh(e)).stock).toBe(4400);
  });

  it('does not have its goods changed while the invoice stands', async () => {
    const { e, dc, invoice } = await invoiced();
    const res = await put('/dc/update', { id: dc._id, auditReason: 'one box short', items: [line(e, 500, { boxes: 6 })] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DC_ON_INVOICE');
    expect(res.body.message).toContain(invoice.invoiceNumber);
    expect((await fresh(e)).stock).toBe(4400);
    expect((await DeliveryChallan.findById(dc._id).lean()).items[0].quantity).toBe(600);
    expect((await Invoice.findById(invoice._id).lean()).lines[0].quantity).toBe(600);
  });

  it('still takes a recount of its boxes and a corrected vehicle number', async () => {
    const { e, dc, invoice } = await invoiced();
    const boxes = await put('/dc/update', { id: dc._id, auditReason: 'recounted at the gate', items: [line(e, 600, { boxes: 7 })] });
    expect(boxes.status).toBe(200);
    expect((await Invoice.findById(invoice._id).lean()).totalBoxes).toBe(7);
    const vehicle = await put('/dc/update', { id: dc._id, auditReason: 'wrong lorry typed', vehicleNo: 'TN 39 AB 1234' });
    expect(vehicle.status).toBe(200);
    expect(vehicle.body.dc.vehicleNo).toBe('TN 39 AB 1234');
  });

  it('is free again once the invoice is cancelled', async () => {
    const { e, dc, invoice } = await invoiced();
    expect((await post(`/invoice/${invoice._id}/cancel`, { reason: 'raised against the wrong challan' })).status).toBe(200);
    expect((await patch('/dc/update-status', { id: dc._id, status: 'cancelled' })).status).toBe(200);
    expect((await fresh(e)).stock).toBe(5000);
  });

  it('says which invoice it is on', async () => {
    const { dc, invoice } = await invoiced();
    expect((await get(`/dc/detail?id=${dc._id}`)).body.dc.invoice).toEqual({ _id: String(invoice._id), invoiceNumber: invoice.invoiceNumber });
    const loose = (await cut([line(await makeElastic(100), 10)])).body.dc;
    expect((await get(`/dc/detail?id=${loose._id}`)).body.dc.invoice).toBeNull();
  });

  it('an invoice is not raised on a challan that changed while it was being raised', async () => {
    const e = await makeElastic(5000);
    const customer = await makeCustomer();
    const order = await Order.create({
      customer: customer._id, po: 'PO-10', date: new Date(), supplyDate: new Date(), status: 'InProgress',
      elasticOrdered: [{ elastic: e._id, quantity: 1000, rate: 12.5 }],
    });
    const dc = (await cut([line(e, 600)], { orderId: String(order._id) })).body.dc;
    await patch('/dc/update-status', { id: dc._id, status: 'dispatched' });

    // The challan is cancelled in the moment between the invoice listing
    // the order's challans and writing itself.
    let cancelled = false;
    const realFind = DeliveryChallan.find.bind(DeliveryChallan);
    const listSpy = jest.spyOn(DeliveryChallan, 'find').mockImplementation((...args) => {
      const query = realFind(...args);
      const realLean = query.lean.bind(query);
      query.lean = async (...a) => {
        const rows = await realLean(...a);
        if (!cancelled && rows.some((r) => String(r._id) === String(dc._id))) {
          cancelled = true;
          await DeliveryChallan.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(String(dc._id)) },
            { $set: { status: 'cancelled', updatedAt: new Date(Date.now() + 1000) } },
          );
        }
        return rows;
      };
      return query;
    });
    const res = await post('/invoice/create', { orderId: String(order._id), dcIds: [dc._id], invoiceDate: factoryDay.ymd() });
    listSpy.mockRestore();
    expect(cancelled).toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/changed while the invoice was being raised/);
    expect(await Invoice.countDocuments()).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the challan list', () => {
  it('finds a challan by a number typed with spaces round it', async () => {
    const e = await makeElastic(100);
    const dc = (await cut([line(e, 10)])).body.dc;
    const res = await get(`/dc/list?search=${encodeURIComponent(`  ${dc.dcNumber}  `)}`);
    expect(res.body.dcs.map((d) => d.dcNumber)).toEqual([dc.dcNumber]);
  });
});
