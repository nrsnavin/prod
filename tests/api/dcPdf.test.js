'use strict';
// Delivery-challan PDF via the visual template engine (/dc/:id/pdf) and
// the dcToContext mapper. Renders with the starter layout by default and
// the saved template once it's enabled.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, DeliveryChallan, PdfTemplate, admin, dc;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

const asPdf = (r) => r.buffer(true).parse((res, cb) => {
  const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d)));
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  DeliveryChallan = require('../../models/DeliveryChallan.js');
  PdfTemplate = require('../../models/PdfTemplate.js');
  admin = await User.create({ name: 'Admin', email: 'a@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  dc = await DeliveryChallan.create({
    dcNumber: 'DC/2026/0042', type: 'elastic', financialYear: '2026-27', sequence: 42,
    customerName: 'Sunrise Garments', customerGstin: '33AAE9999F1Z2', customerAddress: 'Tiruppur',
    dispatchDate: new Date('2026-07-22'),
    items: [
      { elasticName: '3/4" Woven Elastic', unit: 'm', quantity: 500, rate: 42, amount: 21000 },
      { elasticName: '1" Knitted Elastic', unit: 'm', quantity: 450, rate: 55, amount: 24750 },
    ],
    totalQuantity: 950, totalAmount: 45750, status: 'dispatched',
  });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('dcToContext', () => {
  test('maps a DC + branding into fields + rows', () => {
    const { dcToContext } = require('../../services/pdf/dcContext.js');
    const ctx = dcToContext(dc.toObject(), { company: 'Balu Elastics', addressLines: ['Erode'], gstin: '33ABC', logo: '' });
    expect(ctx.fields.companyName).toBe('Balu Elastics');
    expect(ctx.fields.docNo).toBe('DC/2026/0042');
    expect(ctx.fields.partyName).toBe('Sunrise Garments');
    expect(ctx.fields.totalAmount).toBe('₹45,750');
    expect(ctx.rows).toHaveLength(2);
    expect(ctx.rows[0]).toMatchObject({ sno: 1, qty: 500, amount: 21000 });
  });
});

describe('GET /dc/:id/pdf', () => {
  test('renders a PDF with the starter template by default', async () => {
    const res = await asPdf(request(app).get(`/api/v2/dc/${dc._id}/pdf`).set('Cookie', cookie(admin)));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(res.body.length).toBeGreaterThan(500);
  });

  test('uses the saved template once enabled', async () => {
    await PdfTemplate.create({
      docType: 'delivery-challan', enabled: true,
      elements: [{ id: 'c', type: 'field', field: 'companyName', x: 40, y: 40, w: 300, h: 20, fontSize: 16, bold: true }],
    });
    const res = await asPdf(request(app).get(`/api/v2/dc/${dc._id}/pdf`).set('Cookie', cookie(admin)));
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('invalid id 400s', async () => {
    const res = await request(app).get('/api/v2/dc/notanid/pdf').set('Cookie', cookie(admin));
    expect(res.status).toBe(400);
  });

  test('missing DC 404s', async () => {
    const res = await request(app).get(`/api/v2/dc/${new mongoose.Types.ObjectId()}/pdf`).set('Cookie', cookie(admin));
    expect(res.status).toBe(404);
  });
});
