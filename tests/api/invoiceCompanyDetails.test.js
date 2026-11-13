'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE COMPANY'S DETAILS ON AN INVOICE
//
//  An invoice copies the company's details from Settings when it is
//  raised. One raised before they were filled in keeps the blanks, and
//  the e-invoice portal would refuse it. Until it is registered there it
//  can take the details Settings now hold; its number, lines and amounts
//  stay as they are.
//
//    • blanks filled from Settings: the portal's complaints about them go
//    • the PDF prints the new details
//    • refused once registered, when cancelled, and when the new details
//      would move the tax between CGST + SGST and IGST
//    • nothing to change is said, not recorded
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.PDF_IN_THREAD = '1';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, Order, Customer, Elastic, DeliveryChallan, Invoice, User, DocumentSettings, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const asPdf = (r) => r.buffer(true).parse((res, cb) => {
  const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d)));
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  DeliveryChallan = require('../../models/DeliveryChallan');
  Invoice = require('../../models/Invoice');
  User = require('../../models/User');
  DocumentSettings = require('../../models/DocumentSettings');
  admin = await User.create({ name: 'Owner', email: 'cd@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users'].includes(c.collectionName)) await c.deleteMany({});
  }
  require('../../services/documentSettings').invalidate();
});

/** An invoice raised while Settings held only the company's name. */
async function raisedWithBlanks() {
  await put('/settings/document', { companyName: 'Balu Elastics' });
  const customer = await Customer.create({
    name: 'Sunrise Garments', contactName: 'Ravi', phoneNumber: '9000000001', gstin: '33AAEPS1111F1Z2',
    address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604',
  });
  const e = await Elastic.create({ name: '20mm Knitted', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 5000 });
  const order = await Order.create({ customer: customer._id, po: 'PO-77', date: new Date(), supplyDate: new Date(), status: 'InProgress', elasticOrdered: [{ elastic: e._id, quantity: 1000, rate: 12.5 }] });
  const dc = await DeliveryChallan.create({
    dcNumber: 'E-26/27-0001', type: 'elastic', financialYear: '26/27', sequence: 1, order: order._id, orderNo: order.orderNo,
    customerName: customer.name, status: 'dispatched', dispatchDate: new Date('2026-07-10'),
    items: [{ elastic: e._id, elasticName: e.name, unit: 'm', quantity: 1000, rate: 0, boxes: 10 }], totalQuantity: 1000,
  });
  const res = await post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: '2026-07-12' });
  expect(res.status).toBe(201);
  return res.body.invoice;
}

const fillSettings = (over = {}) => put('/settings/document', {
  companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road', 'Perundurai'], phone: '9876543210',
  invoice: { city: 'Erode', pincode: '638052' }, ...over,
});

describe("an invoice takes the company's current details", () => {
  it('until it is registered: the blanks are filled, the amounts stay, and it is recorded', async () => {
    const inv = await raisedWithBlanks();
    expect(inv.einvoiceProblems).toEqual(expect.arrayContaining([expect.stringMatching(/^Your GSTIN/), expect.stringMatching(/^Your PIN code/)]));

    await fillSettings();
    const res = await post(`/invoice/${inv._id}/company-details`, {});
    expect(res.status).toBe(200);
    const after = res.body.invoice;
    expect(after.seller).toMatchObject({ name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road, Perundurai', city: 'Erode', pincode: '638052', stateCode: '33' });
    expect(after.einvoiceProblems.filter((p) => p.startsWith('Your '))).toEqual([]);
    expect(after.invoiceNumber).toBe(inv.invoiceNumber);
    expect(after.totals).toEqual(inv.totals);
    expect(after.supplyType).toBe('intra');
    const fp = after.fingerprints.at(-1);
    expect(fp.code).toBe('INVOICE_SELLER_UPDATED');
    expect(fp.meta.changed).toEqual(expect.arrayContaining(['gstin', 'pincode', 'city', 'address']));

    // The PDF prints them.
    const text = pdfText((await asPdf(request(app).get(`/api/v2/invoice/${inv._id}/pdf`).set('Cookie', cookie()))).body);
    expect(text).toMatch(/33AAECB1234F1Z5/);
    expect(text).toMatch(/12 Mill Road, Perundurai/);
  });

  it('says so when there is nothing to change, and records nothing', async () => {
    const inv = await raisedWithBlanks();
    await fillSettings();
    expect((await post(`/invoice/${inv._id}/company-details`, {})).body.unchanged).toBeUndefined();
    const again = await post(`/invoice/${inv._id}/company-details`, {});
    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(true);
    const fps = (await Invoice.findById(inv._id).lean()).fingerprints.filter((f) => f.code === 'INVOICE_SELLER_UPDATED');
    expect(fps).toHaveLength(1);
  });

  it('not once it is registered with the e-invoice portal', async () => {
    const inv = await raisedWithBlanks();
    await Invoice.updateOne({ _id: inv._id }, { $set: { 'einvoice.status': 'registered', 'einvoice.irn': 'a'.repeat(64) } });
    await fillSettings();
    const res = await post(`/invoice/${inv._id}/company-details`, {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/registered with the e-invoice portal/);
  });

  it('not when it is cancelled', async () => {
    const inv = await raisedWithBlanks();
    await Invoice.updateOne({ _id: inv._id }, { $set: { status: 'cancelled' } });
    await fillSettings();
    const res = await post(`/invoice/${inv._id}/company-details`, {});
    expect(res.status).toBe(409);
  });

  it('not when the new details would change the tax from CGST + SGST to IGST', async () => {
    const inv = await raisedWithBlanks();
    // A Karnataka GSTIN against a Tamil Nadu customer: inter-state, a different tax.
    await fillSettings({ gstin: '29AAECB1234F1Z5' });
    const res = await post(`/invoice/${inv._id}/company-details`, {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/would be IGST instead of CGST \+ SGST/);
    expect((await Invoice.findById(inv._id).lean()).seller.gstin).toBe('');
  });
});
