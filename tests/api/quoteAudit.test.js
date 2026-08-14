'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE QUOTATION MODULE DOES NOT DEFEND
//
//  tests/api/quote.test.js covers what the module claims to do, and it
//  passes. These cover three things it claims but does not enforce.
//  They pin CURRENT behaviour, so each one fails the day it is fixed —
//  which is the point: none of them is a crash, and all three read as
//  ordinary output.
//
//    1. "Once a customer has ACCEPTED it, the price is the agreement"
//       — enforced on /update, and /status will walk the quote back to
//       draft with no reason recorded and no objection.
//
//    2. utils/money.js exists because "1e308 → a plausible figure with
//       nothing behind it" is worse than a crash. The quote router does
//       not use it, and a rate past the float range prices the yarn at
//       ZERO rather than refusing.
//
//    3. `expired` is in the status enum and nothing ever sets it. A
//       quote stays live past its own valid-till date.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Quote, User, admin;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app   = require('../../app.js');
  Quote = require('../../models/Quote');
  User  = require('../../models/User');
  admin = await User.create({
    name: 'Sales', email: 'audit@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const body = (over = {}) => ({
  customerName: 'Ravi Textiles',
  productName:  '20mm Woven Elastic',
  materials: [
    { label: 'Warp yarn',        weightGrams: 4.2, ratePerKg: 240 },
    { label: 'Spandex covering', weightGrams: 1.1, ratePerKg: 620 },
    { label: 'Warp spandex',     weightGrams: 0.8, ratePerKg: 900 },
    { label: 'Weft yarn',        weightGrams: 2.4, ratePerKg: 180 },
  ],
  conversionCost: 1.25,
  marginPercent: 20,
  gstPercent: 5,
  quantityMetres: 5000,
  ...over,
});

const create = (over) =>
  request(app).post('/api/v2/quote/create').set('Cookie', cookie()).send(body(over));

const setStatus = (id, status) =>
  request(app).patch('/api/v2/quote/status').set('Cookie', cookie()).send({ id, status });

// ══════════════════════════════════════════════════════════════════
describe('the settled-price guard on an accepted quote', () => {
  it('refuses a reprice head-on', async () => {
    const q = (await create()).body.quote;
    await setStatus(q._id, 'accepted');

    const res = await request(app).put('/api/v2/quote/update')
      .set('Cookie', cookie())
      .send({ id: q._id, auditReason: 'customer asked', marginPercent: 40 });

    expect(res.status).toBe(409);
  });

  it('is walked around by two calls, with no reason asked for', async () => {
    const q = (await create()).body.quote;
    expect(q.lines[0].rateBeforeTax).toBe(4.91);
    await setStatus(q._id, 'accepted');

    // /status takes any value in the enum from any other value. There is
    // no transition table and — unlike /update — no audit reason.
    const back = await setStatus(q._id, 'draft');
    expect(back.status).toBe(200);

    const res = await request(app).put('/api/v2/quote/update')
      .set('Cookie', cookie())
      .send({
        id: q._id, auditReason: 'customer asked',
        lines: [{ marginPercent: 40 }],
      });

    // The agreed price is now a different price.
    expect(res.status).toBe(200);
    expect(res.body.quote.lines[0].rateBeforeTax).toBe(5.73);   // was 4.91
  });

  it('leaves the walk-back visible on the fingerprint trail, at least', async () => {
    const q = (await create()).body.quote;
    await setStatus(q._id, 'accepted');
    await setStatus(q._id, 'draft');

    const doc = await Quote.findById(q._id).lean();
    const changes = doc.fingerprints.map((f) => f.meta?.change).filter(Boolean);
    expect(changes).toEqual(['status', 'status']);
  });
});

// ══════════════════════════════════════════════════════════════════
//  The reprice the router's own comment describes — "same products,
//  30% margin" — is the one shape it ignores.
//
//  The whole costing block is behind
//    if (Array.isArray(req.body.lines) || Array.isArray(req.body.materials))
//  so a body carrying only a margin falls straight past it. The route
//  answers 200 with the quote, stamps an "edited" fingerprint carrying
//  the operator's reason, and the price is exactly what it was.
// ══════════════════════════════════════════════════════════════════
describe('repricing by sending only the figure that changed', () => {
  const reprice = (id, patch) =>
    request(app).put('/api/v2/quote/update')
      .set('Cookie', cookie())
      .send({ id, auditReason: 'customer negotiated', ...patch });

  it('reports success', async () => {
    const q = (await create()).body.quote;
    const res = await reprice(q._id, { marginPercent: 40 });
    expect(res.status).toBe(200);
  });

  it('does not change the price', async () => {
    const q = (await create()).body.quote;
    const res = await reprice(q._id, { marginPercent: 40 });

    expect(res.body.quote.lines[0].marginPercent).toBe(20);     // not 40
    expect(res.body.quote.lines[0].rateBeforeTax).toBe(4.91);   // not 5.73
    expect(res.body.quote.grandTotal).toBe(25777.5);
  });

  it('ignores a changed quantity the same way', async () => {
    const q = (await create()).body.quote;
    const res = await reprice(q._id, { quantityMetres: 20000 });
    expect(res.body.quote.totalQuantityMetres).toBe(5000);
  });

  it('records an edit that did not happen', async () => {
    const q = (await create()).body.quote;
    await reprice(q._id, { marginPercent: 40 });

    const doc = await Quote.findById(q._id).lean();
    const edit = doc.fingerprints.at(-1);
    expect(edit.meta.auditReason).toBe('customer negotiated');
    // before and after are identical — the trail says a reason was given
    // for a change that was never applied.
    expect(edit.meta.after).toEqual(edit.meta.before);
  });

  it('DOES reprice once the same figure is wrapped in a lines array', async () => {
    const q = (await create()).body.quote;
    const res = await reprice(q._id, { lines: [{ marginPercent: 40 }] });
    expect(res.body.quote.lines[0].rateBeforeTax).toBe(5.73);
    // Same intent, same operator, two different outcomes — decided by
    // the shape of the request rather than by anything the user did.
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a yarn rate past the range a float can hold', () => {
  it('is accepted', async () => {
    const res = await create({
      materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 1e308 }],
    });
    expect(res.status).toBe(201);
  });

  it('prices the yarn at zero instead of refusing the figure', async () => {
    const res = await create({
      materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 1e308 }],
      conversionCost: 1.25,
      marginPercent: 20,
    });
    const line = res.body.quote.lines[0];

    // 4.2 g at 1e308/kg overflows to Infinity, and roundTo maps a
    // non-finite value to 0. So the material vanishes and the quote is
    // priced on the conversion cost alone.
    expect(line.materialCost).toBe(0);
    expect(line.totalCost).toBe(1.25);
    expect(line.rateBeforeTax).toBe(1.5);
  });

  it('sends the customer a document that reads perfectly normally', async () => {
    const res = await create({
      materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 1e308 }],
      quantityMetres: 50000,
    });
    const q = res.body.quote;

    // Rs 75,000 for 50,000 m of elastic, internally consistent to the
    // paise, and the yarn in it was never costed. Nothing in the
    // response, the PDF or the warnings says so.
    expect(q.subTotal).toBe(75000);
    expect(q.grandTotal).toBe(78750);
  });

  it('has no upper bound at all — a rate is taken as typed', async () => {
    // utils/money.js caps a per-unit rate at MAX_RATE (Rs 10,00,000)
    // precisely so a fat-fingered exponent is caught before it reaches a
    // money figure. The quote router never calls parseMoney.
    const res = await create({
      materials: [{ label: 'Warp yarn', weightGrams: 1000, ratePerKg: 9e9 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.quote.lines[0].materialCost).toBe(9e9);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a quote that has outlived its valid-till date', () => {
  it('is still sent, not expired', async () => {
    const past = new Date('2020-01-01T00:00:00Z');
    const res  = await create({
      date: past.toISOString(),
      validTill: new Date('2020-01-31T00:00:00Z').toISOString(),
    });
    const q = res.body.quote;
    await setStatus(q._id, 'sent');

    const doc = await Quote.findById(q._id).lean();
    expect(new Date(doc.validTill).getTime()).toBeLessThan(Date.now());
    expect(doc.status).toBe('sent');          // never becomes 'expired'
  });

  it('can still be accepted years later at the old yarn price', async () => {
    const res = await create({
      date: new Date('2020-01-01T00:00:00Z').toISOString(),
      validTill: new Date('2020-01-31T00:00:00Z').toISOString(),
    });
    const accepted = await setStatus(res.body.quote._id, 'accepted');
    expect(accepted.status).toBe(200);
    expect(accepted.body.quote.status).toBe('accepted');
  });

  it('appears in the open list with no marker on it', async () => {
    const res = await create({
      date: new Date('2020-01-01T00:00:00Z').toISOString(),
      validTill: new Date('2020-01-31T00:00:00Z').toISOString(),
    });
    await setStatus(res.body.quote._id, 'sent');

    const list = await request(app)
      .get('/api/v2/quote/list?status=sent')
      .set('Cookie', cookie());
    expect(list.body.quotes).toHaveLength(1);
  });
});
