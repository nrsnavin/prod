'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A CUSTOMER SEES IN THE PORTAL, AND ONLY THAT
//
//  api/portal/data.js: a signed-in customer reads their own orders,
//  dispatches, invoices, account and test certificates. Held here:
//
//    • nothing of another customer's, by list or by id (a 404, as if it
//      did not exist), and nothing without the portal's own cookie;
//    • a deleted order, a challan in draft or cancelled, and a cancelled
//      invoice are not there;
//    • an order says what was ordered, woven and dispatched, never its
//      rates, machines or operators;
//    • money (invoices, the statement) is for the buyer and the
//      accountant, not for a login with the viewer role;
//    • the challan, invoice and statement come as the office's PDFs, and
//      a certificate is the latest passing test of each elastic.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, M;
const ids = {};

const portalCookie = (u) => [`portalToken=${jwt.sign(
  { id: u._id, role: 'customer', v: u.tokenVersion ?? 0 },
  process.env.PORTAL_JWT_SECRET_KEY || process.env.JWT_SECRET_KEY,
  { audience: 'portal', algorithm: 'HS256', expiresIn: '1h' },
)}`];
const asPdf = (r) => r.buffer(true).parse((res, cb) => {
  const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d)));
});
const as = (who) => ({
  get: (url) => request(app).get(`/api/v3/portal${url}`).set('Cookie', portalCookie(ids[who])),
  pdf: (url) => asPdf(request(app).get(`/api/v3/portal${url}`).set('Cookie', portalCookie(ids[who]))),
});

async function invoice(customer, n, { grand = 10500, status = 'issued', paid = 0 } = {}) {
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n,
    invoiceDate: new Date('2026-07-01'), dueDate: new Date('2026-07-31'),
    order: new mongoose.Types.ObjectId(), orderNo: 900 + n, customer: customer._id,
    seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road', city: 'Tiruppur', pincode: '641601', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, address: '4 Market St', city: 'Erode', pincode: '638001', stateCode: '33' },
    supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand },
    paidAmount: paid, status,
  });
  if (status === 'issued') {
    await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand });
  }
  return inv;
}

const dc = (order, n, over = {}) => M.DeliveryChallan.create({
  dcNumber: `DC/2026/${String(n).padStart(4, '0')}`, type: 'elastic', financialYear: '2026-27', sequence: n,
  customerName: 'x', dispatchDate: new Date(`2026-07-${10 + n}`),
  order: order._id, orderNo: order.orderNo,
  items: [{ elastic: ids.e20._id, elasticName: '20mm', unit: 'm', quantity: 300, rate: 9, amount: 2700 }],
  totalQuantity: 300, totalAmount: 2700, status: 'dispatched', vehicleNo: 'TN 33 BX 4417', lrNumber: 'LR-1',
  ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {
    Customer: require('../../models/Customer.js'),
    CustomerUser: require('../../models/CustomerUser.js'),
    Elastic: require('../../models/Elastic.js'),
    Order: require('../../models/Order.js'),
    DeliveryChallan: require('../../models/DeliveryChallan.js'),
    Invoice: require('../../models/Invoice.js'),
    JobOrder: require('../../models/JobOrder.js'),
    QcRecord: require('../../models/QcRecord.js'),
    Employee: require('../../models/Employee.js'),
    User: require('../../models/User.js'),
  };
  ids.staff = await M.User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  ids.acme = await M.Customer.create({ name: 'Acme Garments', gstin: '33AAAAA0000A1Z5', contactName: 'B', phoneNumber: '9000000001' });
  ids.other = await M.Customer.create({ name: 'Other Mills', gstin: '33BBBBB0000B1Z5', contactName: 'C', phoneNumber: '9000000002' });
  ids.buyer = await M.CustomerUser.create({ customer: ids.acme._id, name: 'Buyer', email: 'buyer@acme.test', password: 'cotton-reel-7', role: 'buyer' });
  ids.viewer = await M.CustomerUser.create({ customer: ids.acme._id, name: 'Looker', email: 'look@acme.test', password: 'cotton-reel-7', role: 'viewer' });
  ids.otherBuyer = await M.CustomerUser.create({ customer: ids.other._id, name: 'Rival', email: 'rival@other.test', password: 'cotton-reel-7', role: 'buyer' });

  const spec = { weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 };
  ids.e20 = await M.Elastic.create({ name: '20mm', ...spec });
  ids.e25 = await M.Elastic.create({ name: '25mm', ...spec });

  const order = (customer, over = {}) => M.Order.create({
    date: new Date('2026-07-01'), po: 'PO-77', customer: customer._id, supplyDate: new Date('2026-07-20'),
    elasticOrdered: [{ elastic: ids.e20._id, quantity: 1000, rate: 11 }, { elastic: ids.e25._id, quantity: 500, rate: 13 }],
    producedElastic: [{ elastic: ids.e20._id, quantity: 800 }],
    status: 'InProgress', ...over,
  });
  ids.order = await order(ids.acme);
  ids.deleted = await order(ids.acme, { status: 'Deleted', po: 'PO-GONE' });
  ids.otherOrder = await order(ids.other, { po: 'PO-RIVAL' });

  ids.dc = await dc(ids.order, 1);
  ids.dcDraft = await dc(ids.order, 2, { status: 'draft' });
  ids.dcCancelled = await dc(ids.order, 3, { status: 'cancelled' });
  ids.dcOther = await dc(ids.otherOrder, 4);

  // A job on the order, tested twice for 20mm (the later one is certified)
  // and failed once for 25mm (nothing to certify).
  const job = await M.JobOrder.collection.insertOne({ jobOrderNo: 41, order: ids.order._id, customer: ids.acme._id, status: 'weaving' });
  const inspector = await M.Employee.create({ name: 'Kavya', hourlyRate: 100 });
  const qc = (elastic, result, when, measured) => M.QcRecord.collection.insertOne({
    job: job.insertedId, elastic, checkedBy: inspector._id, overallResult: result, createdAt: new Date(when),
    results: [{ parameter: 'Width', expected: '20 mm', measured, pass: result === 'pass' }],
  });
  await qc(ids.e20._id, 'pass', '2026-07-05', '19.8 mm');
  await qc(ids.e20._id, 'pass', '2026-07-08', '20.1 mm');
  await qc(ids.e25._id, 'fail', '2026-07-08', '23 mm');

  ids.inv = await invoice(ids.acme, 1, { paid: 4000 });
  ids.invCancelled = await invoice(ids.acme, 2, { status: 'cancelled' });
  ids.invOther = await invoice(ids.other, 3);
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('who can read', () => {
  it('nobody without the portal cookie, and not with a staff one', async () => {
    expect((await request(app).get('/api/v3/portal/orders')).status).toBe(401);
    const staff = [`token=${jwt.sign({ id: ids.staff._id, role: 'admin', v: 0 }, process.env.JWT_SECRET_KEY)}`];
    expect((await request(app).get('/api/v3/portal/orders').set('Cookie', staff)).status).toBe(401);
  });

  it('a switched-off login is refused at once', async () => {
    const temp = await M.CustomerUser.create({ customer: ids.acme._id, name: 'Temp', email: 'temp@acme.test', password: 'cotton-reel-7' });
    ids.temp = temp;
    expect((await as('temp').get('/summary')).status).toBe(200);
    await M.CustomerUser.updateOne({ _id: temp._id }, { $set: { status: 'disabled' } });
    expect((await as('temp').get('/summary')).status).toBe(401);
  });
});

describe('the home page', () => {
  it('counts open orders and shows what is owed, to a buyer', async () => {
    const res = await as('buyer').get('/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      customer: { name: 'Acme Garments' }, user: { name: 'Buyer', role: 'buyer' },
      orders: { open: 1 }, canSeeMoney: true,
      lastDispatch: { dcNumber: 'DC/2026/0001' },
      money: { owed: 6500, invoices: 1 },
    });
  });

  it('shows a viewer no money', async () => {
    const res = await as('viewer').get('/summary');
    expect(res.body.canSeeMoney).toBe(false);
    expect(res.body.money).toBeUndefined();
  });
});

describe('orders', () => {
  it('lists only the customer\'s own, deleted ones left out, with what has left on live challans', async () => {
    const res = await as('buyer').get('/orders');
    expect(res.status).toBe(200);
    expect(res.body.orders.map((o) => o.po)).toEqual(['PO-77']);
    expect(res.body.orders[0]).toMatchObject({ stage: 'in_production', ordered: 1500, produced: 800, dispatched: 300 });
    expect((await as('buyer').get('/orders?status=closed')).body.orders).toEqual([]);
  });

  it('one order: each elastic ordered, woven and dispatched, and no rate, machine or operator', async () => {
    const res = await as('buyer').get(`/orders/${ids.order._id}`);
    expect(res.status).toBe(200);
    const o = res.body.order;
    expect(o.lines).toEqual([
      expect.objectContaining({ name: '20mm', ordered: 1000, produced: 800, dispatched: 300, toCome: 700 }),
      expect.objectContaining({ name: '25mm', ordered: 500, produced: 0, dispatched: 0, toCome: 500 }),
    ]);
    expect(o.totals).toEqual({ ordered: 1500, produced: 800, dispatched: 300, toCome: 1200 });
    expect(o.dispatches.map((d) => d.dcNumber)).toEqual(['DC/2026/0001']);
    expect(o.hasCertificates).toBe(true);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/"rate"|"amount"|machine|operator|Kavya/i);
  });

  it('another customer\'s order, a deleted one, or a bad id is not found', async () => {
    for (const id of [ids.otherOrder._id, ids.deleted._id, 'not-an-id']) {
      expect((await as('buyer').get(`/orders/${id}`)).status).toBe(404);
    }
    expect((await as('otherBuyer').get(`/orders/${ids.order._id}`)).status).toBe(404);
  });

  it('its certificates: the latest passing test of each elastic, nothing failed', async () => {
    const res = await as('buyer').get(`/orders/${ids.order._id}/certificates`);
    expect(res.status).toBe(200);
    expect(res.body.certificates).toEqual([expect.objectContaining({
      name: '20mm', job: 'J-41', checkedBy: 'Kavya',
      results: [{ parameter: 'Width', expected: '20 mm', measured: '20.1 mm', pass: true }],
    })]);
  });
});

describe('dispatches', () => {
  it('lists the challans that have left against the customer\'s orders, and only those', async () => {
    const res = await as('buyer').get('/dispatches');
    expect(res.status).toBe(200);
    expect(res.body.dispatches.map((d) => d.dcNumber)).toEqual(['DC/2026/0001']);
    expect(res.body.dispatches[0]).toMatchObject({ order: { po: 'PO-77' }, quantity: 300, items: [expect.objectContaining({ name: '20mm', quantity: 300 })] });
  });

  it('one challan, its PDF and its certificates; a draft, a cancelled one or another customer\'s are not found', async () => {
    const one = await as('buyer').get(`/dispatches/${ids.dc._id}`);
    expect(one.status).toBe(200);
    expect(one.body.dispatch).toMatchObject({ dcNumber: 'DC/2026/0001', vehicleNo: 'TN 33 BX 4417', lrNumber: 'LR-1' });

    const pdf = await as('buyer').pdf(`/dispatches/${ids.dc._id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');

    const certs = await as('buyer').get(`/dispatches/${ids.dc._id}/certificates`);
    expect(certs.body.certificates.map((c) => c.name)).toEqual(['20mm']);

    for (const id of [ids.dcDraft._id, ids.dcCancelled._id, ids.dcOther._id]) {
      expect((await as('buyer').get(`/dispatches/${id}`)).status).toBe(404);
      expect((await as('buyer').get(`/dispatches/${id}/pdf`)).status).toBe(404);
    }
  });
});

describe('money', () => {
  it('invoices: the customer\'s issued ones, with what is paid and owed', async () => {
    const res = await as('buyer').get('/invoices');
    expect(res.status).toBe(200);
    expect(res.body.invoices).toEqual([expect.objectContaining({
      invoiceNumber: 'INV/2026-27/0001', total: 10500, paid: 4000, owed: 6500,
    })]);
    expect(res.body.totals.owed).toBe(6500);
  });

  it('an invoice PDF for the customer\'s own; another customer\'s or a cancelled one is not found', async () => {
    const pdf = await as('buyer').pdf(`/invoices/${ids.inv._id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    for (const id of [ids.invOther._id, ids.invCancelled._id]) {
      expect((await as('buyer').get(`/invoices/${id}/pdf`)).status).toBe(404);
    }
  });

  it('the statement, and its PDF', async () => {
    const res = await as('buyer').get('/statement');
    expect(res.status).toBe(200);
    expect(res.body.party.name).toBe('Acme Garments');
    expect(res.body.rows.map((r) => r.number)).toContain('INV/2026-27/0001');
    expect(res.body.rows.map((r) => r.number)).not.toContain('INV/2026-27/0003');
    const pdf = await as('buyer').pdf('/statement/pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('none of it for a viewer', async () => {
    for (const url of ['/invoices', `/invoices/${ids.inv._id}/pdf`, '/statement', '/statement/pdf']) {
      expect((await as('viewer').get(url)).status).toBe(403);
    }
  });
});
