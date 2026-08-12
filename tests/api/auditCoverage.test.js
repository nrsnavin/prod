'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE AUDIT TRAIL ACTUALLY SHOWS
//
//  Every aggregate stamps a fingerprint onto itself, and the trail is
//  assembled by reading those stamps ACROSS collections. Which means a
//  document type can stamp a perfect record and still be invisible,
//  simply by not being on the list this route reads.
//
//  That is what happened to quotations and stock counts: both write a
//  full trail, neither was read. An audit trail that silently omits a
//  document type is worse than no audit trail, because it reads as
//  complete — somebody checking who changed a price would find nothing
//  and conclude nobody had.
//
//  The last test is the guard for the class: every model that CAN hold
//  fingerprints must be one the trail reads.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, admin;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app  = require('../../app.js');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'aud@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const quoteBody = {
  customerName: 'Ravi Textiles',
  productName: '20mm Woven Elastic',
  materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240 }],
  conversionCost: 1.25,
  marginPercent: 20,
  gstPercent: 5,
};

const trail = () =>
  request(app).get('/api/v2/audit/recent').set('Cookie', cookie());

describe('a quotation', () => {
  it('appears on the audit trail the moment it is raised', async () => {
    const created = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send(quoteBody);
    expect(created.status).toBe(201);

    const res = await trail();
    expect(res.status).toBe(200);
    const mine = res.body.entries.filter((e) => e.entityType === 'Quote');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].code).toBe('QUOTE_CREATED');
  });

  it('carries the quote number, so the entry names the document', async () => {
    const created = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send(quoteBody);

    const res = await trail();
    const entry = res.body.entries.find((e) => e.entityType === 'Quote');
    expect(String(entry.entityNo)).toBe(created.body.quote.quoteNo);
  });

  it('records a reprice as a second entry, not a replacement', async () => {
    const created = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send(quoteBody);
    await request(app).put('/api/v2/quote/update').set('Cookie', cookie())
      .send({ id: created.body.quote._id, auditReason: 'Yarn moved', marginPercent: 30,
              materials: quoteBody.materials, conversionCost: 1.25, gstPercent: 5 });

    const res = await trail();
    const codes = res.body.entries.filter((e) => e.entityType === 'Quote').map((e) => e.code);
    expect(codes).toContain('QUOTE_CREATED');
    expect(codes).toContain('QUOTE_UPDATED');
  });

  it('names the PERSON who raised it, not "System"', async () => {
    // buildFingerprint takes { entityId, actor, meta }. Spreading the
    // actor across the options instead left `actor` undefined, and every
    // quotation recorded System as its author — an audit trail that
    // cannot name anybody is a log, not an audit.
    await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send(quoteBody);
    const res = await trail();
    const entry = res.body.entries.find((e) => e.entityType === 'Quote');

    expect(entry.actor).toBeTruthy();
    expect(entry.actor.id).not.toBe('system');
    expect(entry.actor.name).toBe('Owner');
    expect(String(entry.actor.id)).toBe(String(admin._id));
  });

  it('carries the reason given for a reprice', async () => {
    const created = await request(app).post('/api/v2/quote/create')
      .set('Cookie', cookie()).send(quoteBody);
    await request(app).put('/api/v2/quote/update').set('Cookie', cookie())
      .send({ id: created.body.quote._id, auditReason: 'Nylon went up 8%',
              materials: quoteBody.materials, conversionCost: 1.25,
              marginPercent: 30, gstPercent: 5 });

    const res = await trail();
    const updated = res.body.entries.find((e) => e.code === 'QUOTE_UPDATED');
    expect(updated.reason).toBe('Nylon went up 8%');
  });
});

describe('every collection that keeps a trail is read', () => {
  it('reads all six document types', async () => {
    // Adding a model with a `fingerprints` field and forgetting this
    // route is the exact fault that hid quotations. Listed by name so
    // the next addition has to be deliberate.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../../api/audit.js'), 'utf8'
    );
    for (const model of ['Order', 'JobOrder', 'PurchaseOrder',
                         'DeliveryChallan', 'Quote', 'StockCount']) {
      expect(src).toContain(`recentFrom(${model},`);
    }
  });

  it('every model with a fingerprints field is on that list', async () => {
    const fs   = require('fs');
    const path = require('path');
    const dir  = path.join(__dirname, '../../models');
    const audit = fs.readFileSync(path.join(dir, '../api/audit.js'), 'utf8');

    const stamped = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js') || f.endsWith('.cjs'))
      .filter((f) => /fingerprints\s*:/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
      .map((f) => f.replace(/\.(js|cjs)$/, ''));

    const missing = stamped.filter((m) => !audit.includes(`models/${m}"`));
    expect(missing).toEqual([]);
  });
});
