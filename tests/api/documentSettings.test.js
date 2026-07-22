'use strict';
// Document/branding settings API + service.
//  - GET auto-creates the singleton with defaults
//  - PUT (admin) updates whitelisted fields, rejects a bad hex colour
//    and a non-image logo, and can only ever have ONE settings row
//  - the service cache reflects writes after invalidate()
//  - a non-admin cannot write

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, DocumentSettings, service, admin, worker;

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  DocumentSettings = require('../../models/DocumentSettings.js');
  service = require('../../services/documentSettings.js');
  admin  = await User.create({ name: 'Admin', email: 'a@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  worker = await User.create({ name: 'Weaver', email: 'w@t.co', password: 'pass1234', role: 'production', department: 'weaving' });
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('GET /settings/document', () => {
  test('auto-creates the singleton with defaults for any authed user', async () => {
    const res = await request(app).get('/api/v2/settings/document').set('Cookie', cookie(worker));
    expect(res.status).toBe(200);
    expect(res.body.settings.companyName).toBe('Balu Elastics');
    expect(res.body.settings.accentColor).toBe('#1D6FEB');
    expect(await DocumentSettings.countDocuments()).toBe(1);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/v2/settings/document');
    expect(res.status).toBe(401);
  });
});

describe('PUT /settings/document', () => {
  test('admin updates whitelisted fields', async () => {
    const res = await request(app)
      .put('/api/v2/settings/document')
      .set('Cookie', cookie(admin))
      .send({
        companyName: 'Balu Elastics Pvt Ltd',
        gstin: '33ABCDE1234F1Z5',
        addressLines: ['12 Mill Road', 'Erode, Tamil Nadu'],
        accentColor: '#E23744',
        key: 'hacked', // must be ignored (not whitelisted)
      });
    expect(res.status).toBe(200);
    expect(res.body.settings.companyName).toBe('Balu Elastics Pvt Ltd');
    expect(res.body.settings.accentColor).toBe('#E23744');
    expect(res.body.settings.key).toBe('document'); // unchanged
    // still exactly one row
    expect(await DocumentSettings.countDocuments()).toBe(1);
  });

  test('service returns the updated branding after a write', async () => {
    const branding = await service.getPdfBranding();
    expect(branding.company).toBe('Balu Elastics Pvt Ltd');
    expect(branding.accent).toBe('#E23744');
  });

  test('rejects a bad hex colour', async () => {
    const res = await request(app)
      .put('/api/v2/settings/document')
      .set('Cookie', cookie(admin))
      .send({ accentColor: 'red' });
    expect(res.status).toBe(400);
  });

  test('rejects a non-image logo data URL', async () => {
    const res = await request(app)
      .put('/api/v2/settings/document')
      .set('Cookie', cookie(admin))
      .send({ logo: 'data:text/html;base64,PHNjcmlwdD4=' });
    expect(res.status).toBe(400);
  });

  test('a non-admin cannot write', async () => {
    const res = await request(app)
      .put('/api/v2/settings/document')
      .set('Cookie', cookie(worker))
      .send({ companyName: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('PDF generators consume the branding', () => {
  test('reportPdf renders a buffer with a custom accent', async () => {
    const { renderReportPdf } = require('../../services/reports/reportPdf.js');
    const buf = await renderReportPdf({
      title: 'Test', rangeLabel: 'x', company: 'ACME', accent: '#E23744',
      columns: [{ key: 'a', header: 'A', format: 'text' }], rows: [{ a: '1' }],
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });

  test('shiftSheetPdf renders a buffer with branding', async () => {
    const { buildShiftSheetPdf } = require('../../utils/shiftSheetPdf.js');
    const buf = await buildShiftSheetPdf({
      dateLabel: '01-JAN-2026', shift: 'DAY', planNo: 'SP-1',
      rows: [{ sdId: 'a1b2c3', machine: 'M1', operator: 'Ravi', job: 'J-1' }],
      branding: { company: 'ACME', tagline: 'Tapes', accent: '#E23744' },
    });
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});
