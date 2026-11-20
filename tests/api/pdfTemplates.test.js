'use strict';
// Visual PDF template designer: doc-type registry, template CRUD, the
// template renderer engine, and the live preview endpoint.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, admin, worker;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  admin  = await User.create({ name: 'Admin', email: 'a@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  worker = await User.create({ name: 'Weaver', email: 'w@t.co', password: 'pass1234', role: 'production', department: 'weaving' });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('renderer engine', () => {
  test('renders a valid PDF from a template + context', async () => {
    const { renderTemplatePdf } = require('../../services/pdf/templateRenderer.js');
    const { starterTemplate, getDocType } = require('../../services/pdf/docTypes.js');
    const tpl = starterTemplate('delivery-challan');
    const ctx = getDocType('delivery-challan').sample();
    const buf = await renderTemplatePdf(tpl, ctx);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(500);
  });

  test('paginates a large table without throwing', async () => {
    const { renderTemplatePdf } = require('../../services/pdf/templateRenderer.js');
    const { starterTemplate } = require('../../services/pdf/docTypes.js');
    const tpl = starterTemplate('delivery-challan');
    const rows = Array.from({ length: 120 }, (_, i) => ({ sno: i + 1, description: `Item ${i}`, qty: i, rate: 10, amount: i * 10 }));
    const buf = await renderTemplatePdf(tpl, { fields: { companyName: 'X' }, rows });
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('a broken image data URL does not break the PDF', async () => {
    const { renderTemplatePdf } = require('../../services/pdf/templateRenderer.js');
    const tpl = { pageSize: 'A4', orientation: 'portrait', elements: [{ id: 'l', type: 'image', x: 10, y: 10, w: 50, h: 50 }] };
    const buf = await renderTemplatePdf(tpl, { logo: 'data:image/png;base64,notreallybase64!!!' });
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe('GET /pdf-templates/doc-types', () => {
  test('lists registered doc types with field catalogs', async () => {
    const res = await request(app).get('/api/v2/pdf-templates/doc-types').set('Cookie', cookie(worker));
    expect(res.status).toBe(200);
    const ids = res.body.docTypes.map((d) => d.id);
    expect(ids).toContain('delivery-challan');
    const dc = res.body.docTypes.find((d) => d.id === 'delivery-challan');
    expect(dc.fields.some((f) => f.key === 'partyName')).toBe(true);
  });
});

describe('GET/PUT /pdf-templates/:docType', () => {
  test('GET returns the starter template when none is saved', async () => {
    const res = await request(app).get('/api/v2/pdf-templates/delivery-challan').set('Cookie', cookie(admin));
    expect(res.status).toBe(200);
    expect(res.body.template.docType).toBe('delivery-challan');
    expect(res.body.template.elements.length).toBeGreaterThan(0);
  });

  test('unknown doc type 404s', async () => {
    const res = await request(app).get('/api/v2/pdf-templates/nope').set('Cookie', cookie(admin));
    expect(res.status).toBe(404);
  });

  test('admin can save a template', async () => {
    const res = await request(app)
      .put('/api/v2/pdf-templates/delivery-challan')
      .set('Cookie', cookie(admin))
      .send({ enabled: true, elements: [{ id: 't', type: 'text', text: 'Hi', x: 10, y: 10, w: 100, h: 20 }] });
    expect(res.status).toBe(200);
    expect(res.body.template.enabled).toBe(true);
    expect(res.body.template.elements[0].text).toBe('Hi');
  });

  test('rejects two table elements', async () => {
    const res = await request(app)
      .put('/api/v2/pdf-templates/delivery-challan')
      .set('Cookie', cookie(admin))
      .send({ elements: [{ id: 'a', type: 'table' }, { id: 'b', type: 'table' }] });
    expect(res.status).toBe(400);
  });

  test('a non-admin cannot save', async () => {
    const res = await request(app)
      .put('/api/v2/pdf-templates/delivery-challan')
      .set('Cookie', cookie(worker))
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });
});

describe('POST /pdf-templates/:docType/preview', () => {
  test('renders a PDF from the posted draft', async () => {
    const { starterTemplate } = require('../../services/pdf/docTypes.js');
    const res = await request(app)
      .post('/api/v2/pdf-templates/delivery-challan/preview')
      .set('Cookie', cookie(admin))
      .send(starterTemplate('delivery-challan'))
      .buffer(true)
      .parse((r, cb) => { const d = []; r.on('data', (c) => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Found reading services/pdf line by line.
//
//  The designer opens on the built-in layout and saves back the whole
//  thing. The model that stores it had fallen behind the layouts: no
//  "pageNumber" element, no "currency2" (paise) column, and none of the
//  table's ruled-form settings. So switching the built-in layout on was
//  refused outright — and had it been let through, the copy kept would
//  have lost its page numbers, its column rules and its header text
//  (white, on the light grey band the layouts use).
// ══════════════════════════════════════════════════════════════════
describe('the built-in layouts can be saved as they are', () => {
  const { pdfText, pdfPageCount } = require('../helpers/pdfText');
  const asPdf = (r) => r.buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });

  test.each(['delivery-challan', 'purchase-order', 'quotation'])('%s: opened, switched on and saved', async (docType) => {
    const PdfTemplate = require('../../models/PdfTemplate.js');
    await PdfTemplate.deleteMany({ docType });
    const opened = (await request(app).get(`/api/v2/pdf-templates/${docType}`).set('Cookie', cookie(admin))).body.template;
    const res = await request(app).put(`/api/v2/pdf-templates/${docType}`).set('Cookie', cookie(admin)).send({ ...opened, enabled: true });
    expect(res.status).toBe(200);

    // What was kept is what was sent: every element, and the table as designed.
    const kept = res.body.template;
    expect(kept.elements.map((e) => `${e.id}:${e.type}`)).toEqual(opened.elements.map((e) => `${e.id}:${e.type}`));
    const [was, now] = [opened, kept].map((t) => t.elements.find((e) => e.type === 'table'));
    expect(now).toMatchObject({ grid: true, zebra: false, headerBg: was.headerBg, headerColor: was.headerColor, bodyColor: was.bodyColor, gridColor: was.gridColor });
    expect(now.columns.map((c) => c.format)).toEqual(was.columns.map((c) => c.format));
    const page = kept.elements.find((e) => e.type === 'pageNumber');
    expect(page.text).toBe('Page {{n}} of {{total}}');

    // And it prints as the built-in one does.
    const pdf = (await asPdf(request(app).post(`/api/v2/pdf-templates/${docType}/preview`).set('Cookie', cookie(admin)).send(kept))).body;
    expect(pdfPageCount(pdf)).toBe(1);
    const text = await pdfText(pdf);
    expect(text).toContain('Page 1 of 1');
    if (docType === 'quotation') expect(text).toContain('Rs. 4.91');   // a rate per metre, to the paisa
    await PdfTemplate.deleteMany({ docType });
  });

  test('the designer is told what a line of each document can show', async () => {
    const { docTypes } = (await request(app).get('/api/v2/pdf-templates/doc-types').set('Cookie', cookie(admin))).body;
    const rows = Object.fromEntries(docTypes.map((d) => [d.id, d.rowFields.map((f) => f.key)]));
    // A challan: unit and boxes, and no rate or amount to bind.
    expect(rows['delivery-challan']).toEqual(['sno', 'description', 'unit', 'boxes', 'qty']);
    expect(rows['purchase-order']).toEqual(['sno', 'description', 'unit', 'qty', 'rate', 'amount']);
    // And a name every object has is not a document type.
    expect((await request(app).get('/api/v2/pdf-templates/constructor').set('Cookie', cookie(admin))).status).toBe(404);
  });

  test('a made-up element type or column format is still refused', async () => {
    const bad = (body) => request(app).put('/api/v2/pdf-templates/delivery-challan').set('Cookie', cookie(admin)).send(body);
    expect((await bad({ elements: [{ id: 'x', type: 'script', x: 1, y: 1 }] })).status).toBe(400);
    expect((await bad({ elements: [{ id: 't', type: 'table', columns: [{ field: 'qty', format: 'html' }] }] })).status).toBe(400);
    expect((await bad({ elements: [{ id: 't', type: 'table', gridColor: 'red; drop' }] })).status).toBe(400);
  });
});
