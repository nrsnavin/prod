'use strict';
// ══════════════════════════════════════════════════════════════════
//  BATCH-WISE STOCK, AND THE LEDGER BEHIND IT
//
//  A lot's balance was two running totals — receivedQty less
//  consumedQty. A running total cannot be audited: it says a lot has
//  40 kg left without saying when the rest went or who took it, so the
//  one figure the floor trusts for shade traceability was the one
//  figure nobody could check.
//
//  Every lot move goes through services/yarnLotService.js, so the
//  ledger is written there — there is no second path that moves a lot
//  without recording why. That is what these tests lean on: they drive
//  receipts, batch issues, cancellations and adjustments through the
//  real routes and then ask the lot to explain itself.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
// Inward, batch issue and lot adjust all run in transactions.
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let RawMaterial, Supplier, PurchaseOrder, YarnLot, WarpingBatch, Warping,
  JobOrder, Customer, Elastic, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial   = require('../../models/RawMaterial');
  Supplier      = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  YarnLot       = require('../../models/YarnLot');
  WarpingBatch  = require('../../models/WarpingBatch');
  Warping       = require('../../models/Warping');
  JobOrder      = require('../../models/JobOrder');
  Customer      = require('../../models/Customer');
  Elastic       = require('../../models/Elastic');
  User          = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seed() {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 300, supplier: supplier._id,
  });
  return { supplier, yarn };
}

/** Receive against a PO with a lot number — the normal way a lot opens. */
async function receive({ yarn, supplier }, { quantity = 100, lotNo = 'D-4471' } = {}) {
  const po = await PurchaseOrder.create({
    poNo: Math.floor(Math.random() * 100000), supplier: supplier._id, status: 'Open',
    items: [{ rawMaterial: yarn._id, quantity: 1000, price: 300, receivedQuantity: 0 }],
  });
  const res = await request(app).post('/api/v2/supplier/inward-stock')
    .set('Cookie', adminCookie())
    .send({
      poId: String(po._id),
      items: [{ rawMaterial: String(yarn._id), quantity, lotNo, shade: 'Ecru' }],
    });
  if (res.status >= 400) throw new Error(`inward failed: ${res.status} ${JSON.stringify(res.body)}`);
  return YarnLot.findOne({ rawMaterial: yarn._id, lotNo });
}

const lotDetail = async (lot) => {
  const res = await request(app)
    .get(`/api/v2/yarn-lots/${lot._id}`)
    .set('Cookie', adminCookie());
  if (res.status >= 400) throw new Error(`lot read failed: ${res.status}`);
  return res.body.lot;
};

const adjust = (lot, body) =>
  request(app).post(`/api/v2/yarn-lots/${lot._id}/adjust`)
    .set('Cookie', adminCookie())
    .send(body);

// ── Batch-wise stock ──────────────────────────────────────────────────

describe('a lot keeps its own balance', () => {
  it('opens with what was received', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    expect(lot.balance).toBe(100);
  });

  it('tops up rather than opening a rival lot on a second delivery', async () => {
    const s = await seed();
    await receive(s, { quantity: 60 });
    await receive(s, { quantity: 40 });

    const lots = await YarnLot.find({ rawMaterial: s.yarn._id });
    expect(lots).toHaveLength(1);
    expect(lots[0].balance).toBe(100);
  });
});

// ── The ledger behind it ──────────────────────────────────────────────

describe('the lot ledger', () => {
  it('records the receipt that opened it', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });

    const { movements } = await lotDetail(lot);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: 'INWARD', typeLabel: 'Received', quantity: 100, balance: 100,
    });
  });

  it('records a second delivery as its own row', async () => {
    const s = await seed();
    await receive(s, { quantity: 60 });
    const lot = await receive(s, { quantity: 40 });

    const { movements } = await lotDetail(lot);
    expect(movements).toHaveLength(2);
    // Newest first, and the balances tell the story in order.
    expect(movements.map((m) => m.balance)).toEqual([100, 60]);
  });

  it('records a batch issue against the batch that drew it', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });

    const customer = await Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9000000002' });
    const elastic = await Elastic.create({
      name: '20mm', weaveType: '8', spandexEnds: 40, yarnEnds: 120,
      pick: 12, noOfHook: 8, weight: 2.4,
    });
    const job = await JobOrder.create({
      date: new Date(), order: new mongoose.Types.ObjectId(), customer: customer._id,
      status: 'preparatory', elastics: [{ elastic: elastic._id, quantity: 500 }],
    });
    const warping = await Warping.create({ date: new Date(), job: job._id, status: 'in_progress' });
    const batch = await WarpingBatch.create({
      batchNo: 'WB-0009', warping: warping._id, job: job._id, beamNos: [1],
      status: 'planned',
      allocations: [{
        rawMaterial: s.yarn._id, yarnLot: lot._id, lotNo: 'D-4471',
        materialName: 'Nylon 70D', quantity: 30,
      }],
    });

    const res = await request(app).post(`/api/v2/warping/batch/${batch._id}/issue`)
      .set('Cookie', adminCookie()).send({});
    expect(res.status).toBeLessThan(400);

    const { movements, balance } = await lotDetail(lot);
    expect(balance).toBe(70);
    const issued = movements.find((m) => m.type === 'BATCH_ISSUE');
    expect(issued).toMatchObject({
      typeLabel: 'Issued to warping',
      // Negative: a draw reduces the lot. Same sign rule as the raw
      // material ledger, deliberately.
      quantity: -30,
      balance: 70,
      reference: 'WB-0009',
    });
  });

  it('records the yarn coming back when a batch is cancelled', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    const job = await JobOrder.create({
      date: new Date(), order: new mongoose.Types.ObjectId(),
      customer: new mongoose.Types.ObjectId(), status: 'preparatory',
    });
    const warping = await Warping.create({ date: new Date(), job: job._id, status: 'in_progress' });
    const batch = await WarpingBatch.create({
      batchNo: 'WB-0010', warping: warping._id, job: job._id,
      status: 'planned',
      allocations: [{
        rawMaterial: s.yarn._id, yarnLot: lot._id, lotNo: 'D-4471',
        materialName: 'Nylon 70D', quantity: 25,
      }],
    });
    await request(app).post(`/api/v2/warping/batch/${batch._id}/issue`)
      .set('Cookie', adminCookie()).send({});
    const res = await request(app).patch(`/api/v2/warping/batch/${batch._id}/cancel`)
      .set('Cookie', adminCookie()).send({ reason: 'wrong beam' });
    expect(res.status).toBeLessThan(400);

    const { movements, balance } = await lotDetail(lot);
    expect(balance).toBe(100);
    expect(movements.find((m) => m.type === 'BATCH_RETURN')).toMatchObject({
      typeLabel: 'Returned from warping', quantity: 25, balance: 100,
    });
  });

  it('explains the balance without anyone adding the rows up', async () => {
    // The point of the whole ledger: the number on the rack and the
    // number in the system have to be reconcilable.
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    await adjust(lot, { delta: -12, reason: 'spillage' });

    const { movements, balance } = await lotDetail(lot);
    const sum = movements.reduce((t, m) => t + m.quantity, 0);
    expect(sum).toBe(balance);
  });
});

// ── Batch-wise adjustment ─────────────────────────────────────────────

describe('adjusting one lot', () => {
  it('takes the shortfall off the lot and off the material together', async () => {
    // Lot balances are a subdivision of stock. Moving one without the
    // other puts the two permanently out of step and nothing afterwards
    // can say which is right.
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    expect((await RawMaterial.findById(s.yarn._id)).stock).toBe(100);

    const res = await adjust(lot, { delta: -12, reason: 'recount short' });
    expect(res.status).toBeLessThan(400);

    expect((await YarnLot.findById(lot._id)).balance).toBe(88);
    expect((await RawMaterial.findById(s.yarn._id)).stock).toBe(88);
  });

  it('adds a gain to both as well', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });

    await adjust(lot, { delta: 5, reason: 'found a bag behind the rack' });

    expect((await YarnLot.findById(lot._id)).balance).toBe(105);
    expect((await RawMaterial.findById(s.yarn._id)).stock).toBe(105);
  });

  it('keeps the reason on both ledgers', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    await adjust(lot, { delta: -12, reason: 'spillage on the floor' });

    const { movements } = await lotDetail(lot);
    expect(movements.find((m) => m.type === 'ADJUST')).toMatchObject({
      typeLabel: 'Manual adjustment', quantity: -12, reason: 'spillage on the floor',
    });

    const material = await RawMaterial.findById(s.yarn._id).select('+stockMovements');
    const row = material.stockMovements.find((m) => m.type === 'STOCK_ADJUST');
    // Which lot it came off, on the aggregate's ledger too.
    expect(row.reason).toMatch(/D-4471/);
    expect(row.reason).toMatch(/spillage/);
  });

  it('refuses to take more off a lot than it holds', async () => {
    // Driving a lot negative would make the shade trail claim yarn that
    // was never there.
    const s = await seed();
    const lot = await receive(s, { quantity: 20 });

    const res = await adjust(lot, { delta: -50, reason: 'recount' });
    expect(res.status).toBe(409);
    expect((await YarnLot.findById(lot._id)).balance).toBe(20);
    // And the material is untouched — the two move together or not at all.
    expect((await RawMaterial.findById(s.yarn._id)).stock).toBe(20);
  });

  it('insists on a reason', async () => {
    // An adjustment has no document behind it, so without a reason the
    // ledger row is a number nobody can explain.
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });

    expect((await adjust(lot, { delta: -5 })).status).toBe(400);
    expect((await adjust(lot, { delta: -5, reason: 'x' })).status).toBe(400);
  });

  it('refuses a zero adjustment', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    expect((await adjust(lot, { delta: 0, reason: 'nothing' })).status).toBe(400);
  });

  it('exhausts a lot adjusted down to nothing, and reopens it on a gain', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 30 });

    await adjust(lot, { delta: -30, reason: 'all of it went' });
    expect((await YarnLot.findById(lot._id)).status).toBe('exhausted');

    await adjust(lot, { delta: 10, reason: 'miscounted, some left' });
    expect((await YarnLot.findById(lot._id)).status).toBe('open');
  });
});

// ── Ageing ────────────────────────────────────────────────────────────

describe('how long a lot has been on the rack', () => {
  it('reports its age in days', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    await YarnLot.updateOne(
      { _id: lot._id },
      { receivedDate: new Date(Date.now() - 45 * 86_400_000) }
    );

    const detail = await lotDetail(lot);
    expect(detail.ageDays).toBe(45);
  });

  it('buckets it, so the old ones can be found without arithmetic', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });

    for (const [days, bucket] of [[5, 'fresh'], [60, 'watch'], [120, 'late'], [400, 'critical']]) {
      await YarnLot.updateOne(
        { _id: lot._id },
        { receivedDate: new Date(Date.now() - days * 86_400_000) }
      );
      const detail = await lotDetail(lot);
      expect({ days, bucket: detail.ageBucket }).toEqual({ days, bucket });
    }
  });

  it('does not age a lot that holds nothing', async () => {
    // An exhausted lot's age is history, not something to act on, and
    // listing it as "critical" would bury the lots that matter.
    const s = await seed();
    const lot = await receive(s, { quantity: 30 });
    await adjust(lot, { delta: -30, reason: 'used up' });
    await YarnLot.updateOne(
      { _id: lot._id },
      { receivedDate: new Date(Date.now() - 400 * 86_400_000) }
    );

    const detail = await lotDetail(lot);
    expect(detail.ageBucket).toBeNull();
    expect(detail.ageDays).toBe(400);
  });

  it('carries the age on the list too, not only the detail', async () => {
    const s = await seed();
    const lot = await receive(s, { quantity: 100 });
    await YarnLot.updateOne(
      { _id: lot._id },
      { receivedDate: new Date(Date.now() - 200 * 86_400_000) }
    );

    const res = await request(app).get('/api/v2/yarn-lots/list')
      .query({ material: String(s.yarn._id), status: 'all' })
      .set('Cookie', adminCookie());
    const row = res.body.lots.find((l) => String(l._id) === String(lot._id));
    expect(row.ageDays).toBe(200);
    expect(row.ageBucket).toBe('critical');
  });
});
