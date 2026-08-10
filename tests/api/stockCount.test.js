'use strict';
// ══════════════════════════════════════════════════════════════════
//  PHYSICAL STOCK COUNTS
//
//  Adjusting one material from a screen is a correction. A stock take
//  is a programme: snapshot what the system claims, count, review the
//  differences as a set, post them together. What these tests pin
//  down — in rough order of how expensive getting it wrong would be:
//
//    • an UNCOUNTED line is never written off. "Nobody has been to
//      that rack yet" and "there is nothing there" are different
//      facts, and confusing them writes off the warehouse.
//    • posting applies an INCREMENT, never sets stock to the counted
//      figure — otherwise a count posted after a shift's production
//      silently reverses it.
//    • a count changes quantity, never cost.
//    • posting twice does not apply twice.
//    • a large variance needs a reason before it can be posted.
//    • the corrections land on the material's own ledger and in
//      MaterialInward / MaterialOutward, not in a private set of books.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, StockCount, MaterialInward, MaterialOutward, Supplier, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial     = require('../../models/RawMaterial');
  StockCount      = require('../../models/StockCount');
  MaterialInward  = require('../../models/MaterialInward');
  MaterialOutward = require('../../models/MaterialOut.cjs');
  Supplier        = require('../../models/Supplier');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'count@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// ── helpers ───────────────────────────────────────────────────────
const makeMaterial = (over = {}) =>
  RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 100, price: 300, avgCost: 330, ...over,
  });

const open = (body = {}) =>
  request(app).post('/api/v2/stock-counts').set('Cookie', adminCookie())
    .send({ label: 'March count', scope: { kind: 'all' }, ...body });

const enter = (id, lines) =>
  request(app).patch(`/api/v2/stock-counts/${id}/lines`)
    .set('Cookie', adminCookie()).send({ lines });

const post = (id, body = {}) =>
  request(app).post(`/api/v2/stock-counts/${id}/post`)
    .set('Cookie', adminCookie()).send(body);

const lineFor = (count, material) =>
  count.lines.find((l) => l.rawMaterial === String(material._id));

// ══════════════════════════════════════════════════════════════════
//  OPENING
// ══════════════════════════════════════════════════════════════════
describe('opening a count', () => {
  it('snapshots what the system believes, per material', async () => {
    const a = await makeMaterial({ name: 'Nylon 70D',  stock: 100, avgCost: 330 });
    const b = await makeMaterial({ name: 'Spandex 40D', stock: 250, avgCost: 610 });

    const res = await open();
    expect(res.status).toBe(201);
    expect(res.body.count.lines).toHaveLength(2);

    expect(lineFor(res.body.count, a)).toMatchObject({
      systemQty: 100, unitCost: 330, countedQty: null, variance: null,
    });
    expect(lineFor(res.body.count, b)).toMatchObject({ systemQty: 250, unitCost: 610 });
  });

  it('values a material with no average yet at its latest price', async () => {
    const m = await makeMaterial({ stock: 100, price: 280, avgCost: 0 });
    const res = await open();
    expect(lineFor(res.body.count, m).unitCost).toBe(280);
  });

  it('scopes to a category', async () => {
    await makeMaterial({ name: 'Nylon 70D',  category: 'Yarn' });
    await makeMaterial({ name: 'Dye Powder', category: 'Chemical' });

    const res = await open({ scope: { kind: 'category', category: 'Chemical' } });
    expect(res.body.count.lines).toHaveLength(1);
    expect(res.body.count.lines[0].name).toBe('Dye Powder');
  });

  it('scopes to a named set of materials', async () => {
    const a = await makeMaterial({ name: 'Nylon 70D' });
    await makeMaterial({ name: 'Spandex 40D' });

    const res = await open({ scope: { kind: 'materials', materials: [String(a._id)] } });
    expect(res.body.count.lines).toHaveLength(1);
    expect(res.body.count.lines[0].name).toBe('Nylon 70D');
  });

  it('refuses a scope that matches nothing, rather than opening an empty sheet', async () => {
    await makeMaterial({ category: 'Yarn' });
    const res = await open({ scope: { kind: 'category', category: 'Nothing' } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/matched no materials/i);
  });

  it('starts in counting, with nothing counted', async () => {
    await makeMaterial();
    const res = await open();
    expect(res.body.count.status).toBe('counting');
    expect(res.body.count.totals).toMatchObject({ counted: 0, uncounted: 1, varied: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════
//  ENTERING COUNTS
// ══════════════════════════════════════════════════════════════════
describe('entering counted quantities', () => {
  it('computes the variance in quantity and in value', async () => {
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();

    const res = await enter(body.count._id, [
      { rawMaterial: String(m._id), countedQty: 94 },
    ]);

    expect(res.status).toBe(200);
    expect(lineFor(res.body.count, m)).toMatchObject({
      countedQty: 94, variance: -6, varianceValue: -1980,   // 6 × 330
    });
  });

  it('leaves lines it was not told about alone', async () => {
    // Two people count different racks; neither wipes the other's work.
    const a = await makeMaterial({ name: 'Nylon 70D',   stock: 100 });
    const b = await makeMaterial({ name: 'Spandex 40D', stock: 250 });
    const { body } = await open();

    await enter(body.count._id, [{ rawMaterial: String(a._id), countedQty: 98 }]);
    const res = await enter(body.count._id, [{ rawMaterial: String(b._id), countedQty: 250 }]);

    expect(lineFor(res.body.count, a).countedQty).toBe(98);
    expect(lineFor(res.body.count, b).countedQty).toBe(250);
  });

  it('moves the sheet to review once every line is counted', async () => {
    const m = await makeMaterial();
    const { body } = await open();
    const res = await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 100 }]);
    expect(res.body.status).toBe('review');
  });

  it('lets a mis-keyed line be cleared back to uncounted', async () => {
    const m = await makeMaterial({ stock: 100 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 10 }]);

    const res = await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: null }]);
    expect(lineFor(res.body.count, m).countedQty).toBeNull();
    expect(res.body.status).toBe('counting');
  });

  it('reports a material that is not on the sheet instead of inventing a line', async () => {
    const onSheet  = await makeMaterial({ name: 'Nylon 70D' });
    const offSheet = await makeMaterial({ name: 'Spandex 40D' });
    const { body } = await open({
      scope: { kind: 'materials', materials: [String(onSheet._id)] },
    });

    const res = await enter(body.count._id, [
      { rawMaterial: String(onSheet._id),  countedQty: 98 },
      { rawMaterial: String(offSheet._id), countedQty: 5 },
    ]);

    expect(res.body.applied).toHaveLength(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].error).toMatch(/not on this count sheet/i);
  });

  it('refuses a negative count', async () => {
    const m = await makeMaterial();
    const { body } = await open();
    const res = await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: -5 }]);
    expect(res.body.errors[0].error).toMatch(/zero or more/i);
  });
});

// ══════════════════════════════════════════════════════════════════
//  POSTING — the part that moves stock
// ══════════════════════════════════════════════════════════════════
describe('posting a count', () => {
  it('applies the difference and leaves the cost alone', async () => {
    // The rule the whole feature turns on: a count that finds 6 kg
    // missing has not changed what the remaining yarn cost.
    const m = await makeMaterial({ stock: 100, avgCost: 330, price: 300 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 94 }]);

    const res = await post(body.count._id);
    expect(res.status).toBe(200);

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(94);
    expect(after.avgCost).toBe(330);
  });

  it('never writes off a line nobody counted', async () => {
    // The most expensive mistake this feature could make.
    const counted   = await makeMaterial({ name: 'Nylon 70D',   stock: 100 });
    const untouched = await makeMaterial({ name: 'Spandex 40D', stock: 250 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(counted._id), countedQty: 98 }]);

    const res = await post(body.count._id, { force: true });
    expect(res.status).toBe(200);

    expect((await RawMaterial.findById(untouched._id).lean()).stock).toBe(250);
    expect((await RawMaterial.findById(counted._id).lean()).stock).toBe(98);
  });

  it('makes the caller say so before posting a half-finished sheet', async () => {
    const a = await makeMaterial({ name: 'Nylon 70D',   stock: 100 });
    await makeMaterial({ name: 'Spandex 40D', stock: 250 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(a._id), countedQty: 98 }]);

    const res = await post(body.count._id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/have not been counted/i);
    expect(res.body.message).toMatch(/not written off/i);
  });

  it('applies an increment, so production during the count is not reversed', async () => {
    // Frozen at 100. The counter finds 94 — a loss of 6. While the
    // sheet was open, 30 kg was received. Setting stock to 94 would
    // erase that receipt; incrementing by −6 gives 124.
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 94 }]);

    await RawMaterial.updateOne({ _id: m._id }, { $inc: { stock: 30 } });

    await post(body.count._id);

    const after = await RawMaterial.findById(m._id).lean();
    expect(after.stock).toBe(124);
    expect(after.stock).not.toBe(94);
  });

  it('flags the lines that moved while the count was open', async () => {
    const still  = await makeMaterial({ name: 'Nylon 70D',   stock: 100 });
    const moved  = await makeMaterial({ name: 'Spandex 40D', stock: 250 });
    const { body } = await open();
    await enter(body.count._id, [
      { rawMaterial: String(still._id), countedQty: 100 },
      { rawMaterial: String(moved._id), countedQty: 250 },
    ]);

    await RawMaterial.updateOne({ _id: moved._id }, { $inc: { stock: 15 } });
    const res = await post(body.count._id);

    expect(lineFor(res.body.count, moved).movedSinceFreeze).toBe(true);
    expect(lineFor(res.body.count, still).movedSinceFreeze).toBe(false);
    expect(res.body.count.postedSummary.linesMovedSinceFreeze).toBe(1);
  });

  it('records the correction on the material own ledger', async () => {
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [
      { rawMaterial: String(m._id), countedQty: 94, reason: 'Cones damaged in transit' },
    ]);
    await post(body.count._id);

    const doc = await RawMaterial.findById(m._id).select('+stockMovements').lean();
    const row = doc.stockMovements.at(-1);
    expect(row).toMatchObject({ type: 'STOCK_ADJUST', quantity: -6, balance: 94, unitCost: 330 });
    expect(row.reason).toMatch(/Count #/);
    expect(row.reason).toMatch(/damaged in transit/i);
  });

  it('writes the authoritative outward row, priced at the average', async () => {
    // What the stock-movements report and the order P&L actually read.
    const m = await makeMaterial({ stock: 100, avgCost: 330, price: 500 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 94 }]);
    await post(body.count._id);

    const out = await MaterialOutward.findOne({ rawMaterial: m._id }).lean();
    expect(out).toMatchObject({ quantity: 6, type: 'STOCK_ADJUST', unitPrice: 330 });
  });

  it('writes an inward row for a gain', async () => {
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 108 }]);
    await post(body.count._id);

    const inward = await MaterialInward.findOne({ rawMaterial: m._id }).lean();
    expect(inward).toMatchObject({ quantity: 8, unitPrice: 330 });
    expect((await RawMaterial.findById(m._id).lean()).avgCost).toBe(330);
  });

  it('totals the gains and losses in value', async () => {
    const a = await makeMaterial({ name: 'Nylon 70D',   stock: 100, avgCost: 330 });
    const b = await makeMaterial({ name: 'Spandex 40D', stock: 250, avgCost: 600 });
    const { body } = await open();
    await enter(body.count._id, [
      { rawMaterial: String(a._id), countedQty: 94 },     // −6  × 330 = −1980
      { rawMaterial: String(b._id), countedQty: 253 },    // +3  × 600 = +1800
    ]);

    const res = await post(body.count._id);
    expect(res.body.count.postedSummary).toMatchObject({
      linesCounted: 2, linesVaried: 2,
      gainQuantity: 3, lossQuantity: -6,
      gainValue: 1800, lossValue: -1980, netValue: -180,
    });
  });

  it('cannot be posted twice', async () => {
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 94 }]);

    await post(body.count._id);
    const again = await post(body.count._id);

    expect(again.status).toBe(409);
    expect((await RawMaterial.findById(m._id).lean()).stock).toBe(94);   // not 88
  });

  it('records only what stock could actually give back', async () => {
    // Stock still floors at zero. A loss of 40 against 25 on hand
    // moves 25, and the row says both figures rather than claiming 40.
    const m = await makeMaterial({ stock: 25, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [
      { rawMaterial: String(m._id), countedQty: 0, reason: 'rack found empty' },
    ]);
    await RawMaterial.updateOne({ _id: m._id }, { $set: { stock: 10 } });

    const res = await post(body.count._id);
    expect(lineFor(res.body.count, m).appliedDelta).toBe(-10);
    expect((await RawMaterial.findById(m._id).lean()).stock).toBe(0);
  });

  it('refuses to post a big variance with no reason', async () => {
    const m = await makeMaterial({ stock: 500, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 100 }]);

    const res = await post(body.count._id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reason/i);
    expect((await RawMaterial.findById(m._id).lean()).stock).toBe(500);
  });

  it('posts the same variance once a reason is given', async () => {
    const m = await makeMaterial({ stock: 500, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [
      { rawMaterial: String(m._id), countedQty: 100, reason: 'Rack B was double counted in January' },
    ]);

    const res = await post(body.count._id);
    expect(res.status).toBe(200);
    expect((await RawMaterial.findById(m._id).lean()).stock).toBe(100);
  });

  it('lets a small variance through without one', async () => {
    // Finding a large difference is the point of counting. Demanding
    // an essay for 2 kg just teaches people to type "adjustment".
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 98 }]);
    expect((await post(body.count._id)).status).toBe(200);
  });

  it('does nothing at all when everything matched', async () => {
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 100 }]);
    const res = await post(body.count._id);

    expect(res.body.count.postedSummary).toMatchObject({ linesVaried: 0, netValue: 0 });
    expect(await MaterialOutward.countDocuments({ rawMaterial: m._id })).toBe(0);
    expect((await RawMaterial.findById(m._id).lean()).stock).toBe(100);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE VARIANCE REPORT
// ══════════════════════════════════════════════════════════════════
describe('the variance report', () => {
  it('shows the lines that differ, worst loss first', async () => {
    const a = await makeMaterial({ name: 'Nylon 70D',   stock: 100, avgCost: 330 });
    const b = await makeMaterial({ name: 'Spandex 40D', stock: 250, avgCost: 600 });
    const c = await makeMaterial({ name: 'Cotton 20s',  stock: 60,  avgCost: 120 });
    const { body } = await open();
    await enter(body.count._id, [
      { rawMaterial: String(a._id), countedQty: 94 },    // −1980
      { rawMaterial: String(b._id), countedQty: 250 },   // matched
      { rawMaterial: String(c._id), countedQty: 40, reason: 'written off after flood' }, // −2400
    ]);

    const res = await request(app)
      .get(`/api/v2/stock-counts/${body.count._id}/variance`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.lines.map((l) => l.name)).toEqual(['Cotton 20s', 'Nylon 70D']);
    expect(res.body.totals).toMatchObject({ counted: 3, varied: 2, lossValue: -4380 });
  });

  it('shows everything when asked', async () => {
    const m = await makeMaterial({ stock: 100 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 100 }]);

    const res = await request(app)
      .get(`/api/v2/stock-counts/${body.count._id}/variance?only=all`)
      .set('Cookie', adminCookie());
    expect(res.body.lines).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  CANCELLING
// ══════════════════════════════════════════════════════════════════
describe('cancelling a count', () => {
  it('abandons it without touching stock', async () => {
    const m = await makeMaterial({ stock: 100 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 40 }]);

    const res = await request(app)
      .post(`/api/v2/stock-counts/${body.count._id}/cancel`)
      .set('Cookie', adminCookie())
      .send({ reason: 'counted the wrong rack' });

    expect(res.status).toBe(200);
    expect(res.body.count.status).toBe('cancelled');
    expect((await RawMaterial.findById(m._id).lean()).stock).toBe(100);
  });

  it('wants a reason', async () => {
    await makeMaterial();
    const { body } = await open();
    const res = await request(app)
      .post(`/api/v2/stock-counts/${body.count._id}/cancel`)
      .set('Cookie', adminCookie()).send({ reason: 'x' });
    expect(res.status).toBe(400);
  });

  it('refuses to cancel one that has already moved stock', async () => {
    // Undoing a posted count is a new count, not a status change —
    // otherwise the ledger keeps adjustments no document explains.
    const m = await makeMaterial({ stock: 100, avgCost: 330 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 94 }]);
    await post(body.count._id);

    const res = await request(app)
      .post(`/api/v2/stock-counts/${body.count._id}/cancel`)
      .set('Cookie', adminCookie()).send({ reason: 'changed my mind' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/open a new count/i);
  });

  it('will not take new counts once it is closed', async () => {
    const m = await makeMaterial({ stock: 100 });
    const { body } = await open();
    await request(app)
      .post(`/api/v2/stock-counts/${body.count._id}/cancel`)
      .set('Cookie', adminCookie()).send({ reason: 'counted the wrong rack' });

    const res = await enter(body.count._id, [{ rawMaterial: String(m._id), countedQty: 5 }]);
    expect(res.status).toBe(409);
  });
});

// ══════════════════════════════════════════════════════════════════
//  LISTING
// ══════════════════════════════════════════════════════════════════
describe('listing counts', () => {
  it('reports progress without loading every line', async () => {
    const a = await makeMaterial({ name: 'Nylon 70D',   stock: 100 });
    await makeMaterial({ name: 'Spandex 40D', stock: 250 });
    const { body } = await open();
    await enter(body.count._id, [{ rawMaterial: String(a._id), countedQty: 98 }]);

    const res = await request(app).get('/api/v2/stock-counts').set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.counts[0]).toMatchObject({ lines: 2, counted: 1, status: 'counting' });
  });

  it('filters by status', async () => {
    await makeMaterial();
    const first = await open();
    await request(app)
      .post(`/api/v2/stock-counts/${first.body.count._id}/cancel`)
      .set('Cookie', adminCookie()).send({ reason: 'wrong scope' });
    await open();

    const res = await request(app)
      .get('/api/v2/stock-counts?status=cancelled').set('Cookie', adminCookie());
    expect(res.body.counts).toHaveLength(1);
  });
});
