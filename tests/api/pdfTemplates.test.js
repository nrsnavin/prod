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
