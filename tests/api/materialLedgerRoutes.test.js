'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE LEDGER ROUTES
//
//  services/materialLedger.js is tested on its own; this drives the two
//  routes through the real app, because that is where the failures the
//  service tests cannot see actually live:
//
//    • route ORDER — /ledger is registered last, and a `/:id` route
//      added ahead of it later would swallow both of these silently;
//    • the ERROR PATH — parseRange throws synchronously inside an async
//      handler, and that only becomes a 400 rather than a crashed
//      request because catchAsyncErrors wraps it;
//    • the PDF actually being a PDF, with headers a browser will open
//      rather than download as ledger.pdf.htm.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, MaterialInward, MaterialOutward, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  MaterialInward = require('../../models/MaterialInward');
  MaterialOutward = require('../../models/MaterialOut.cjs');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'ledger@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  await Promise.all([
    RawMaterial.deleteMany({}),
    MaterialInward.deleteMany({}),
    MaterialOutward.deleteMany({}),
  ]);
});

const seed = async () => {
  const m = await RawMaterial.create({
    name: 'Nylon 40D', category: 'Yarn', unit: 'kg', stock: 60, price: 100,
  });
  await MaterialInward.create({
    rawMaterial: m._id, quantity: 100, inwardDate: new Date('2025-03-10T10:00:00Z'),
  });
  await MaterialOutward.create({
    rawMaterial: m._id, quantity: 40, type: 'ORDER_APPROVAL',
    outwardDate: new Date('2025-03-12T10:00:00Z'),
  });
  return m;
};

describe('GET /materials/ledger', () => {
  it('is reachable — no earlier route swallows it', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger').query({ id: String(m._id) })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.rows).toHaveLength(2);
  });

  it('returns the balances and the totals, not just the rows', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger')
      .query({ id: String(m._id), from: '2025-03-01', to: '2025-03-31' })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.opening).toBe(0);
    expect(res.body.closing).toBe(60);
    expect(res.body.totals).toMatchObject({ received: 100, issued: 40 });
  });

  it('narrows to the range it was asked for', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger')
      .query({ id: String(m._id), from: '2025-03-11', to: '2025-03-31' })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].label).toBe('Order approval');
  });

  it('answers 400 rather than crashing on a backwards range', async () => {
    // parseRange throws synchronously inside an async handler. Without
    // catchAsyncErrors around it this is an unhandled rejection, not a
    // status code.
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger')
      .query({ id: String(m._id), from: '2025-03-31', to: '2025-03-01' })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(400);
  });

  it('answers 400 for a date it cannot parse', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger')
      .query({ id: String(m._id), from: 'last tuesday' })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(400);
  });

  it('answers 400 for a missing id', async () => {
    const res = await request(app)
      .get('/api/v2/materials/ledger').set('Cookie', adminCookie());
    expect(res.status).toBe(400);
  });

  it('answers 400 for an id that is not an ObjectId', async () => {
    // Passed through, this is a mongoose CastError and a 500.
    const res = await request(app)
      .get('/api/v2/materials/ledger').query({ id: 'not-an-id' })
      .set('Cookie', adminCookie());
    expect(res.status).toBe(400);
  });

  it('answers 404 for a material that does not exist', async () => {
    const res = await request(app)
      .get('/api/v2/materials/ledger')
      .query({ id: String(new mongoose.Types.ObjectId()) })
      .set('Cookie', adminCookie());
    expect(res.status).toBe(404);
  });
});

describe('GET /materials/ledger.pdf', () => {
  it('sends a PDF a browser will open', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger.pdf')
      .query({ id: String(m._id), from: '2025-03-01', to: '2025-03-31' })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('names the file for the material and the period', async () => {
    // These are saved in a folder and opened weeks later. "download.pdf"
    // for every material and every month is not a filename.
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger.pdf')
      .query({ id: String(m._id), from: '2025-03-01', to: '2025-03-31' })
      .set('Cookie', adminCookie());

    expect(res.headers['content-disposition']).toMatch(/Nylon-40D/);
    expect(res.headers['content-disposition']).toMatch(/2025-03-01_to_2025-03-31/);
  });

  it('names an open range without leaving the filename half-built', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger.pdf').query({ id: String(m._id) })
      .set('Cookie', adminCookie());

    expect(res.headers['content-disposition']).toMatch(/start_to_today/);
  });

  it('renders a period in which nothing moved', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger.pdf')
      .query({ id: String(m._id), from: '2025-01-01', to: '2025-01-31' })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('answers 400 on a backwards range rather than an empty PDF', async () => {
    const m = await seed();
    const res = await request(app)
      .get('/api/v2/materials/ledger.pdf')
      .query({ id: String(m._id), from: '2025-03-31', to: '2025-03-01' })
      .set('Cookie', adminCookie());

    expect(res.status).toBe(400);
  });
});
