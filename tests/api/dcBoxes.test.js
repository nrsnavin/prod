'use strict';
// ══════════════════════════════════════════════════════════════════
//  BOXES: COUNTED ON THE CHALLAN, CARRIED TO THE INVOICE
//
//  Each challan line says how many boxes it went out in, and the
//  challan adds them up. The invoice raised against challans is not
//  asked again: each of its lines carries that elastic's boxes on the
//  challans, and its total is every box on them.
//
//    • a challan keeps each line's boxes and their total; part of a box
//      is refused, a blank is none
//    • correcting only the boxes moves no stock; changing the goods
//      still does, and the total follows either way
//    • the invoice's boxes are its challans', whatever the form sends
//    • a challan recounted after it was invoiced puts the new count on
//      the invoice, and nothing taxed moves
//    • the printed challan has a Boxes column and its total, and none
//      when the lines carry no boxes
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.PDF_IN_THREAD = '1';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, User, Customer, Elastic, Order, DeliveryChallan, StockMovement, Invoice, PdfTemplate, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const asPdf = (r) => r.buffer(true).parse((res, cb) => {
  const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d)));
});

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
  PdfTemplate = require('../../models/PdfTemplate');
  admin = await User.create({ name: 'Owner', email: 'boxes@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
const makeElastic = (over = {}) => Elastic.create({
  name: `20mm Knitted ${++seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 50000, reservedStock: 0, ...over,
});
const makeCustomer = () => Customer.create({
  name: `Sunrise Garments ${++seq}`, contactName: 'Ravi', phoneNumber: '9000000001', gstin: '33AAEPS1111F1Z2',
  address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604',
});

/** A challan cut through the real route. */
async function cutDc(customer, items, over = {}) {
  const res = await post('/dc/create', { type: 'elastic', customerName: customer.name, items, ...over });
  if (res.status >= 400) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.dc;
}
const editDc = (dc, body) => put('/dc/update', { id: String(dc._id), auditReason: 'recounted at the gate', ...body });

describe('a challan keeps its boxes', () => {
  it('on each line, and their total on the challan', async () => {
    const a = await makeElastic();
    const b = await makeElastic();
    const customer = await makeCustomer();
    const dc = await cutDc(customer, [
      { elastic: String(a._id), quantity: 4000, rate: 4, boxes: 16 },
      { elastic: String(b._id), quantity: 1000, rate: 5, boxes: 4 },
    ]);
    expect(dc.items.map((i) => i.boxes)).toEqual([16, 4]);
    expect(dc.totalBoxes).toBe(20);
    expect(dc.fingerprints[0].meta.totalBoxes).toBe(20);
  });

  it('takes a blank as none, and refuses part of a box or a negative count', async () => {
    const a = await makeElastic();
    const customer = await makeCustomer();
    const dc = await cutDc(customer, [{ elastic: String(a._id), quantity: 500, rate: 4, boxes: '' }]);
    expect(dc.items[0].boxes).toBe(0);
    expect(dc.totalBoxes).toBe(0);

    const half = await post('/dc/create', { type: 'elastic', customerName: customer.name, items: [{ elastic: String(a._id), quantity: 500, boxes: 2.5 }] });
    expect(half.status).toBe(400);
    expect(half.body.message).toMatch(/Line 1: boxes must be a whole number/);
    const negative = await post('/dc/create', { type: 'elastic', customerName: customer.name, items: [{ elastic: String(a._id), quantity: 500, boxes: -1 }] });
    expect(negative.status).toBe(400);
    // Neither burnt a challan.
    expect(await DeliveryChallan.countDocuments()).toBe(1);
  });
});

describe('correcting a challan', () => {
  it('a recount of boxes alone moves no stock, and the total follows', async () => {
    const a = await makeElastic({ stock: 1000 });
    const customer = await makeCustomer();
    const dc = await cutDc(customer, [{ elastic: String(a._id), quantity: 400, rate: 12, boxes: 8 }]);
    expect((await Elastic.findById(a._id).lean()).stock).toBe(600);
    const movesBefore = await StockMovement.countDocuments({ elastic: a._id });

    const res = await editDc(dc, { items: [{ elastic: String(a._id), quantity: 400, rate: 12, boxes: 10 }] });
    expect(res.status).toBe(200);
    expect(res.body.dc.items[0].boxes).toBe(10);
    expect(res.body.dc.totalBoxes).toBe(10);
    expect(await StockMovement.countDocuments({ elastic: a._id })).toBe(movesBefore);
    expect((await Elastic.findById(a._id).lean()).stock).toBe(600);
    // The audit trail says what the count was and what it is.
    const fp = res.body.dc.fingerprints.at(-1);
    expect(fp.meta.before.totalBoxes).toBe(8);
    expect(fp.meta.after.totalBoxes).toBe(10);
  });

  it('a change of goods still moves stock, and carries the new boxes', async () => {
    const a = await makeElastic({ stock: 1000 });
    const customer = await makeCustomer();
    const dc = await cutDc(customer, [{ elastic: String(a._id), quantity: 400, rate: 12, boxes: 8 }]);
    const res = await editDc(dc, { items: [{ elastic: String(a._id), quantity: 250, rate: 12, boxes: 5 }] });
    expect(res.status).toBe(200);
    expect((await Elastic.findById(a._id).lean()).stock).toBe(750);
    expect(res.body.dc.totalBoxes).toBe(5);
    expect(res.body.dc.totalQuantity).toBe(250);
  });
});

// The invoice side: an order with two priced elastics and two challans out.
async function invoiceScene() {
  await put('/settings/document', {
    companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road', 'Perundurai'], phone: '9876543210',
    invoice: { city: 'Erode', pincode: '638052', defaultHsn: '5806', defaultGstPercent: 5 },
  });
  const customer = await makeCustomer();
  const a = await makeElastic();
  const b = await makeElastic();
  const order = await Order.create({
    customer: customer._id, po: 'PO-77', date: new Date(), supplyDate: new Date(), status: 'InProgress',
    elasticOrdered: [{ elastic: a._id, quantity: 1000, rate: 12.5 }, { elastic: b._id, quantity: 300, rate: 40 }],
  });
  let n = 0;
  const dc = (items) => DeliveryChallan.create({
    dcNumber: `E-26/27-90${++n}`, type: 'elastic', financialYear: '26/27', sequence: 900 + n,
    order: order._id, orderNo: order.orderNo, customerName: customer.name, status: 'dispatched', dispatchDate: new Date('2026-07-10'),
    items: items.map(([e, quantity, boxes]) => ({ elastic: e._id, elasticName: e.name, unit: 'm', quantity, rate: 0, boxes })),
    totalQuantity: items.reduce((s, [, q]) => s + q, 0), totalBoxes: items.reduce((s, [, , x]) => s + x, 0),
  });
  const dc1 = await dc([[a, 600, 6]]);
  const dc2 = await dc([[a, 400, 4], [b, 300, 3]]);
  return { customer, a, b, order, dc1, dc2 };
}

describe("an invoice's boxes are its challans'", () => {
  it('the form is told each challan\'s boxes and each line\'s', async () => {
    const { order, a, b, dc1, dc2 } = await invoiceScene();
    const res = await get(`/invoice/order-info?id=${order._id}`);
    expect(res.status).toBe(200);
    const dcs = Object.fromEntries(res.body.dcs.map((d) => [d.dcNumber, d]));
    expect(dcs[dc1.dcNumber].totalBoxes).toBe(6);
    expect(dcs[dc2.dcNumber].totalBoxes).toBe(7);
    expect(dcs[dc2.dcNumber].items.map((i) => i.boxes)).toEqual([4, 3]);
    const lines = Object.fromEntries(res.body.lines.map((l) => [String(l.elastic), l]));
    expect(lines[String(a._id)].boxes).toBe(10);
    expect(lines[String(b._id)].boxes).toBe(3);
  });

  it('raising one carries them, whatever boxes the form sends', async () => {
    const { order, a, b, dc1, dc2 } = await invoiceScene();
    const res = await post('/invoice/create', {
      orderId: order._id, dcIds: [dc1._id, dc2._id], invoiceDate: '2026-07-12',
      lines: [{ elastic: a._id, boxes: 99 }, { elastic: b._id, boxes: 1 }],
    });
    expect(res.status).toBe(201);
    const inv = res.body.invoice;
    expect(inv.totalBoxes).toBe(13);
    expect(inv.lines.find((l) => String(l.elastic) === String(a._id)).boxes).toBe(10);
    expect(inv.lines.find((l) => String(l.elastic) === String(b._id)).boxes).toBe(3);
  });

  it('only the ticked challans count', async () => {
    const { order, dc1 } = await invoiceScene();
    const res = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id], invoiceDate: '2026-07-12' });
    expect(res.status).toBe(201);
    expect(res.body.invoice.totalBoxes).toBe(6);
  });

  it('a challan recounted after it was invoiced puts the new count on the invoice, and nothing taxed moves', async () => {
    const { order, a, b, dc1, dc2 } = await invoiceScene();
    const raised = (await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id, dc2._id], invoiceDate: '2026-07-12' })).body.invoice;
    const res = await editDc(dc2, { items: [
      { elastic: String(a._id), quantity: 400, rate: 0, boxes: 5 },
      { elastic: String(b._id), quantity: 300, rate: 0, boxes: 3 },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.invoiceBoxesUpdated).toEqual([raised.invoiceNumber]);
    const inv = await Invoice.findById(raised._id).lean();
    expect(inv.totalBoxes).toBe(14);
    expect(inv.lines.find((l) => String(l.elastic) === String(a._id)).boxes).toBe(11);
    expect(inv.totals.grand).toBe(raised.totals.grand);
    expect(inv.lines.map((l) => l.quantity)).toEqual(raised.lines.map((l) => l.quantity));
  });

  it('a cancelled invoice is left as it was', async () => {
    const { order, a, dc1 } = await invoiceScene();
    const raised = (await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id], invoiceDate: '2026-07-12' })).body.invoice;
    await Invoice.updateOne({ _id: raised._id }, { $set: { status: 'cancelled' } });
    await editDc(dc1, { items: [{ elastic: String(a._id), quantity: 600, rate: 0, boxes: 9 }] });
    expect((await Invoice.findById(raised._id).lean()).totalBoxes).toBe(6);
  });
});

describe('the printed challan', () => {
  beforeEach(() => PdfTemplate.deleteMany({}));

  it('has a Boxes column and the total', async () => {
    const a = await makeElastic({ name: 'Boxed Elastic 25mm' });
    const customer = await makeCustomer();
    const dc = await cutDc(customer, [{ elastic: String(a._id), quantity: 4000, rate: 4, boxes: 16 }]);
    const text = pdfText((await asPdf(get(`/dc/${dc._id}/pdf`))).body);
    expect(text).toMatch(/Boxes/);
    expect(text).toMatch(/16/);
  });

  it('has no Boxes column when the lines carry none', async () => {
    const a = await makeElastic({ name: 'Loose Elastic 25mm' });
    const customer = await makeCustomer();
    const dc = await cutDc(customer, [{ elastic: String(a._id), quantity: 4000, rate: 4 }]);
    const text = pdfText((await asPdf(get(`/dc/${dc._id}/pdf`))).body);
    expect(text).not.toMatch(/Boxes/);
  });

  it('the designer offers the total and the starter layout prints it', () => {
    const { getDocType, starterTemplate } = require('../../services/pdf/docTypes');
    const { dcToContext } = require('../../services/pdf/dcContext');
    expect(getDocType('delivery-challan').fields.map((f) => f.key)).toContain('totalBoxes');
    const starter = starterTemplate('delivery-challan');
    expect(JSON.stringify(starter)).toContain('"field":"totalBoxes"');
    const ctx = dcToContext({ items: [{ elasticName: 'x', quantity: 10, boxes: 2 }, { elasticName: 'y', quantity: 5 }] });
    expect(ctx.fields.totalBoxes).toBe('2');
    expect(ctx.rows.map((r) => r.boxes)).toEqual([2, '']);
  });
});
