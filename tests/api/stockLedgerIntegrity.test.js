'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE LEDGER HAS TO RECONCILE
//
//  A stock ledger's one job is that the balances follow from the
//  quantities: every row's balance is the row before it plus this
//  row's quantity. Two write paths broke that, both the same way —
//  stock floors at zero, so a write-off of 50 against 30 on hand moves
//  30, and both of them recorded the 50 anyway. The row said −50 with a
//  balance of 0 beside a previous balance of 30, the MaterialOutward
//  row claimed 50 kg consumed straight into the order P&L, and the
//  lot draw asked for yarn the lot never held.
//
//  What these tests pin down:
//
//    • `quantity` is always what stock ACTUALLY moved by
//    • `requested` records the ask, and only when the two differ
//    • the ledger walks back to a consistent balance
//    • the outward row and the caller's response agree with it
//    • a write-off against nothing fails instead of quietly succeeding
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const { normaliseMovements } = require('../../utils/stockLedger');

let mongo, app;
let RawMaterial, MaterialOutward, YarnLot, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial     = require('../../models/RawMaterial');
  MaterialOutward = require('../../models/MaterialOut.cjs');
  YarnLot         = require('../../models/YarnLot');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'ledger@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 90_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeMaterial = (over = {}) =>
  RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 30, price: 300, avgCost: 330, ...over,
  });

const adjust = (adjustments) =>
  request(app).post('/api/v2/materials/bulk-adjust-stock')
    .set('Cookie', adminCookie()).send({ adjustments });

const ledger = async (m) =>
  (await RawMaterial.findById(m._id).select('+stockMovements').lean()).stockMovements;

// ══════════════════════════════════════════════════════════════════
//  A CLAMPED WRITE-OFF
// ══════════════════════════════════════════════════════════════════
describe('a write-off larger than what is on hand', () => {
  it('records what actually moved, not what was asked for', async () => {
    const m = await makeMaterial({ stock: 30 });

    const res = await adjust([{ _id: String(m._id), adjustment: -50, reason: 'Rack emptied' }]);
    expect(res.status).toBe(200);

    const rows = await ledger(m);
    expect(rows.at(-1)).toMatchObject({
      type: 'STOCK_ADJUST',
      quantity: -30,     // what moved
      requested: -50,    // what was typed
      balance: 0,
    });
    expect((await RawMaterial.findById(m._id).lean()).stock).toBe(0);
  });

  it('leaves the ledger reconcilable', async () => {
    // The whole point: previous balance + quantity === balance.
    const m = await makeMaterial({ stock: 30 });
    await adjust([{ _id: String(m._id), adjustment: -50, reason: 'Rack emptied' }]);

    const rows = await ledger(m);
    const row  = rows.at(-1);
    expect(30 + row.quantity).toBe(row.balance);
  });

  it('tells the caller how much it actually applied', async () => {
    const m = await makeMaterial({ stock: 30 });
    const res = await adjust([{ _id: String(m._id), adjustment: -50, reason: 'Rack emptied' }]);

    expect(res.body.updated[0]).toMatchObject({
      oldStock: 30, newStock: 0, adjustment: -30, requested: -50,
    });
  });

  it('does not over-state consumption on the outward row', async () => {
    // This row is what the order P&L reads. Claiming 50 kg left the
    // building when 30 did costs the difference, every time.
    const m = await makeMaterial({ stock: 30, avgCost: 330 });
    await adjust([{ _id: String(m._id), adjustment: -50, reason: 'Rack emptied' }]);

    const out = await MaterialOutward.findOne({ rawMaterial: m._id }).lean();
    expect(out.quantity).toBe(30);
    expect(out.unitPrice).toBe(330);
  });

  it('refuses a write-off against nothing rather than reporting success', async () => {
    const m = await makeMaterial({ stock: 0 });
    const res = await adjust([{ _id: String(m._id), adjustment: -20, reason: 'Rack emptied' }]);

    expect(res.body.updated).toHaveLength(0);
    expect(res.body.errors[0].error).toMatch(/nothing to adjust/i);
    expect(await MaterialOutward.countDocuments({ rawMaterial: m._id })).toBe(0);
  });
});

describe('an ordinary adjustment', () => {
  it('records no `requested`, because nothing was clamped', async () => {
    // The exceptional field stays absent on the ordinary case, so its
    // presence is a signal rather than noise.
    const m = await makeMaterial({ stock: 100 });
    await adjust([{ _id: String(m._id), adjustment: -6, reason: 'Damaged cones' }]);

    const row = (await ledger(m)).at(-1);
    expect(row.quantity).toBe(-6);
    expect(row.requested).toBeUndefined();
  });

  it('carries its full amount through to the outward row', async () => {
    const m = await makeMaterial({ stock: 100 });
    await adjust([{ _id: String(m._id), adjustment: -6, reason: 'Damaged cones' }]);
    expect((await MaterialOutward.findOne({ rawMaterial: m._id }).lean()).quantity).toBe(6);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE SAME FAULT ON THE LOT PATH
// ══════════════════════════════════════════════════════════════════
describe('a yarn lot correction', () => {
  it('moves the aggregate by what it could, and says so', async () => {
    // The lot holds 40 and the aggregate only 25 — they have drifted,
    // which is exactly the situation someone corrects a lot in. The
    // aggregate can only give back 25.
    const m = await makeMaterial({ stock: 25 });
    const lot = await YarnLot.create({
      rawMaterial: m._id, lotNo: 'D-4471', shade: 'Ecru', receivedQty: 40,
    });

    const res = await request(app)
      .post(`/api/v2/yarn-lots/${lot._id}/adjust`)
      .set('Cookie', adminCookie())
      .send({ delta: -40, reason: 'lot found empty at the count' });

    expect(res.status).toBeLessThan(400);

    const row = (await ledger(m)).at(-1);
    expect(row).toMatchObject({ type: 'STOCK_ADJUST', quantity: -25, requested: -40, balance: 0 });
    expect(25 + row.quantity).toBe(row.balance);
  });

  it('records no `requested` when the aggregate could take it all', async () => {
    const m = await makeMaterial({ stock: 100 });
    const lot = await YarnLot.create({
      rawMaterial: m._id, lotNo: 'D-4472', shade: 'Ecru', receivedQty: 40,
    });

    await request(app)
      .post(`/api/v2/yarn-lots/${lot._id}/adjust`)
      .set('Cookie', adminCookie())
      .send({ delta: -10, reason: 'short on recount' });

    const row = (await ledger(m)).at(-1);
    expect(row.quantity).toBe(-10);
    expect(row.requested).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  HOW IT READS
// ══════════════════════════════════════════════════════════════════
describe('normaliseMovements', () => {
  it('values a movement from the cost recorded on it', async () => {
    // Never from the material's cost today: the average moves with
    // every receipt, so pricing an old movement at it would value the
    // yarn at a cost it never had.
    const [row] = normaliseMovements(
      [{ type: 'ORDER_APPROVAL', quantity: -40, balance: 60, unitCost: 330 }], 60
    );
    expect(row.value).toBe(13200);
  });

  it('leaves the value null when no cost was recorded', async () => {
    // A row from before costs were stamped. Guessing one would be
    // inventing a fact to fill a column.
    const [row] = normaliseMovements(
      [{ type: 'ORDER_APPROVAL', quantity: -40, balance: 60 }], 60
    );
    expect(row.value).toBeNull();
  });

  it('reports the shortfall on a clamped row', async () => {
    const [row] = normaliseMovements(
      [{ type: 'STOCK_ADJUST', quantity: -30, requested: -50, balance: 0 }], 0
    );
    expect(row.shortfall).toBe(-20);
  });

  it('reports no shortfall on an ordinary row', async () => {
    const [row] = normaliseMovements(
      [{ type: 'STOCK_ADJUST', quantity: -6, balance: 94 }], 94
    );
    expect(row.shortfall).toBeNull();
  });

  it('still walks the balances back correctly', async () => {
    // Newest first. 100 now; the newest row took 6, the one before
    // added 40.
    const rows = normaliseMovements([
      { type: 'STOCK_ADJUST', quantity: -6 },
      { type: 'PO_INWARD',    quantity: 40 },
    ], 100);
    expect(rows[0].balance).toBe(100);
    expect(rows[1].balance).toBe(106);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE MATERIAL PAGE
// ══════════════════════════════════════════════════════════════════
describe('the material detail response', () => {
  it('says what the shelf is worth, at the average', async () => {
    const m = await makeMaterial({ stock: 100, price: 500, avgCost: 330 });
    const res = await request(app)
      .get(`/api/v2/materials/get-raw-material-detail?id=${m._id}`)
      .set('Cookie', adminCookie());

    expect(res.status).toBe(200);
    expect(res.body.material).toMatchObject({ unitCost: 330, stockValue: 33000 });
  });
});
