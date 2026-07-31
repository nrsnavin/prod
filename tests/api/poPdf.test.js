'use strict';
// Purchase-order PDF via the visual template engine (/supplier/po/:id/pdf)
// and the poToContext mapper.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, Supplier, RawMaterial, PurchaseOrder, PdfTemplate, admin, po;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const asPdf = (r) => r.buffer(true).parse((res, cb) => {
  const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d)));
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Supplier = require('../../models/Supplier.js');
  RawMaterial = require('../../models/RawMaterial.js');
  PurchaseOrder = require('../../models/PurchaseOrder.js');
  PdfTemplate = require('../../models/PdfTemplate.js');
  admin = await User.create({ name: 'Admin', email: 'a@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const sup = await Supplier.create({ name: 'Yarn Traders', gstin: '33ABCDE1234F1Z5', address: 'Coimbatore', phoneNumber: '9000000000' });
  const m1 = await RawMaterial.create({ name: 'Nylon Yarn 40D', unit: 'kg', category: 'warp' });
  const m2 = await RawMaterial.create({ name: 'Rubber Thread', unit: 'kg', category: 'Rubber' });
  po = await PurchaseOrder.create({
    supplier: sup._id, poNo: 1042, status: 'Open', date: new Date('2026-07-22'),
    items: [
      { rawMaterial: m1._id, price: 320, quantity: 100 },
      { rawMaterial: m2._id, price: 210, quantity: 50 },
    ],
  });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('poToContext', () => {
  test('maps a PO + branding into fields + rows with computed amounts', async () => {
    const { poToContext } = require('../../services/pdf/poContext.js');
    const doc = await PurchaseOrder.findById(po._id)
      .populate('supplier', 'name gstin address')
      .populate('items.rawMaterial', 'name unit').lean();
    const ctx = poToContext(doc, { company: 'Balu Elastics', gstin: '33ABC' });
    expect(ctx.fields.docTitle).toBe('PURCHASE ORDER');
    expect(ctx.fields.docNo).toBe('PO #1042');
    expect(ctx.fields.partyName).toBe('Yarn Traders');
    // 100*320 + 50*210 = 32000 + 10500 = 42500
    // "Rs." not ₹ — pdfkit's built-in Helvetica is WinAnsi-only and rendered
    // the rupee sign as a stray "¹" in every currency cell.
    expect(ctx.fields.totalAmount).toBe('Rs. 42,500');
    expect(ctx.rows[0]).toMatchObject({ sno: 1, description: 'Nylon Yarn 40D', qty: 100, rate: 320, amount: 32000 });
  });
});

describe('GET /supplier/po/:id/pdf', () => {
  test('renders a PDF with the starter template by default', async () => {
    const res = await asPdf(request(app).get(`/api/v2/supplier/po/${po._id}/pdf`).set('Cookie', cookie(admin)));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('uses the saved template once enabled', async () => {
    await PdfTemplate.create({
      docType: 'purchase-order', enabled: true,
      elements: [{ id: 'c', type: 'field', field: 'companyName', x: 40, y: 40, w: 300, h: 20, bold: true }],
    });
    const res = await asPdf(request(app).get(`/api/v2/supplier/po/${po._id}/pdf`).set('Cookie', cookie(admin)));
    expect(res.status).toBe(200);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('invalid id 400s', async () => {
    const res = await request(app).get('/api/v2/supplier/po/xyz/pdf').set('Cookie', cookie(admin));
    expect(res.status).toBe(400);
  });

  test('missing PO 404s', async () => {
    const res = await request(app).get(`/api/v2/supplier/po/${new mongoose.Types.ObjectId()}/pdf`).set('Cookie', cookie(admin));
    expect(res.status).toBe(404);
  });
});

describe('purchase-order template', () => {
  const { getDocType, starterTemplate } = require('../../services/pdf/docTypes.js');

  test('keeps rate and amount — a PO commits the company to a price', () => {
    const cols = getDocType('purchase-order').columns.map((c) => c.field);
    expect(cols).toEqual(['sno', 'description', 'unit', 'qty', 'rate', 'amount']);
    expect(getDocType('purchase-order').fields.map((f) => f.key)).toContain('totalAmount');
  });

  test('binds nothing the context does not provide', () => {
    const { elements } = starterTemplate('purchase-order');
    const bound = elements.filter((e) => e.type === 'field').map((e) => e.field);
    const available = new Set(getDocType('purchase-order').fields.map((f) => f.key));
    expect(bound.filter((b) => !available.has(b))).toEqual([]);
  });

  test('offers bare values for the labelled boxes as well as the prefixed ones', () => {
    const { poToContext } = require('../../services/pdf/poContext.js');
    const ctx = poToContext(
      { poNo: 1042, expectedDate: new Date('2026-08-05'), items: [] },
      {}
    );
    // The box supplies the label, so "Expected: 05-Aug-2026" inside a box
    // headed EXPECTED DELIVERY would read twice. Both are kept so a saved
    // template binding the old keys is unaffected.
    expect(ctx.fields.poNumber).toBe('1042');
    expect(ctx.fields.expectedDelivery).toBe('05 Aug 2026');
    expect(ctx.fields.docNo).toBe('PO #1042');
    expect(ctx.fields.expectedDate).toBe('Expected: 05 Aug 2026');
  });

  test('no rendered money carries a glyph the built-in font cannot encode', () => {
    const { poToContext } = require('../../services/pdf/poContext.js');
    const ctx = poToContext(
      { poNo: 1, items: [{ name: 'Yarn', quantity: 2, price: 50 }] },
      {}
    );
    for (const v of Object.values(ctx.fields)) {
      expect(String(v)).not.toContain('\u20B9');
    }
  });
});
