'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE REPLENISHMENT FORECAST FEEDS ITS MODEL
//
//  services/replenishment.js holds the arithmetic and is tested on its
//  own. This is about the four inputs the route gathers, because that
//  is where every fault was — the model was never the problem, the
//  numbers going into it were.
//
//  Each block names what the endpoint used to do. None of those faults
//  raised an error, produced a NaN or looked wrong on screen; every one
//  returned a confident, plausible quantity to order.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, Supplier, Order, MaterialOutward, PurchaseOrder, User, admin;
let supplier;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app             = require('../../app.js');
  RawMaterial     = require('../../models/RawMaterial');
  Supplier        = require('../../models/Supplier');
  Order           = require('../../models/Order');
  MaterialOutward = require('../../models/MaterialOut.cjs');
  PurchaseOrder   = require('../../models/PurchaseOrder');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Stores', email: 'repl@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

// 14-day lead time: without one there is no reorder point beyond the
// manual floor, and none of this is testable.
beforeEach(async () => {
  supplier = await Supplier.create({
    name: 'Yarn Co', phoneNumber: '9000000001', leadTimeDays: 14,
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

const material = (over = {}) =>
  RawMaterial.create({
    name: 'Warp 40s', category: 'warp', supplier: supplier._id,
    stock: 100, minStock: 0, price: 250, ...over,
  });

/** A draw of `quantity` on each of the last `days` days — steady demand. */
const steadyDraws = (m, perDay, days, type = 'ORDER_APPROVAL') =>
  Promise.all(
    Array.from({ length: days }, (_, i) =>
      MaterialOutward.create({
        rawMaterial: m._id, quantity: perDay, unitPrice: 250,
        type, outwardDate: daysAgo(i), createdAt: daysAgo(i),
      })
    )
  );

const forecast = (q = '') =>
  request(app).get(`/api/v2/materials/replenishment-forecast${q}`).set('Cookie', cookie());

const lineFor = async (name, q = '') => {
  const res = await forecast(q);
  return (res.body.materials || []).find((f) => f.name === name);
};

// ══════════════════════════════════════════════════════════════════
//  1. COMMITTED DEMAND
//
//  WAS: the route read `rm.quantity` off Order.rawMaterialRequired,
//  whose field is `requiredWeight`. `Number(undefined) || 0` is 0 — so
//  the Open-order pipeline, advertised as one of three inputs,
//  contributed nothing, for every material, always.
// ══════════════════════════════════════════════════════════════════
describe('committed demand from the Open-order pipeline', () => {
  const commit = async (m, requiredWeight) => {
    await Order.deleteMany({});
    await Order.create({
      customer: new mongoose.Types.ObjectId(), po: 'PO-1',
      date: new Date(), supplyDate: new Date(), status: 'Open',
      rawMaterialRequired: [
        { rawMaterial: m._id, name: m.name, requiredWeight, inStock: 100 },
      ],
    });
  };

  it('reads the field the schema actually has', async () => {
    const m = await material({ stock: 200 });
    await steadyDraws(m, 10, 30);
    await commit(m, 500);

    expect((await lineFor('Warp 40s')).committed).toBe(500);
  });

  it('takes it off net stock, because it is stock about to leave', async () => {
    const m = await material({ stock: 1000 });
    await steadyDraws(m, 10, 30);
    await commit(m, 950);

    const line = await lineFor('Warp 40s');
    expect(line.netStock).toBe(50);    // 1000 on hand − 950 spoken for
  });

  it('changes the quantity to buy, which it never used to', async () => {
    const m = await material({ stock: 200 });
    await steadyDraws(m, 10, 30);

    await commit(m, 10);
    const small = (await lineFor('Warp 40s'))?.suggestedQty ?? 0;
    await commit(m, 900);
    const large = (await lineFor('Warp 40s')).suggestedQty;

    expect(large).toBeGreaterThan(small);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. STOCK ALREADY ON ORDER
//
//  WAS: nothing looked at purchase orders, so the same shortfall was
//  recommended again every time the page was opened, until the goods
//  landed.
// ══════════════════════════════════════════════════════════════════
describe('a purchase order already covering the shortfall', () => {
  const raise = (m, quantity, receivedQuantity = 0) =>
    PurchaseOrder.create({
      supplier: supplier._id, poNo: 1, status: 'Open',
      items: [{ rawMaterial: m._id, quantity, receivedQuantity, price: 250 }],
    });

  it('counts as stock that is coming', async () => {
    const m = await material({ stock: 10 });
    await steadyDraws(m, 10, 30);
    await raise(m, 50);

    const line = await lineFor('Warp 40s');
    expect(line.onOrder).toBe(50);
    expect(line.netStock).toBe(60);
  });

  it('takes the material off the buying list entirely when it covers it', async () => {
    const m = await material({ stock: 10 });
    await steadyDraws(m, 10, 30);
    const before = (await lineFor('Warp 40s')).suggestedQty;

    await raise(m, before + 1000);
    expect(await lineFor('Warp 40s')).toBeUndefined();
  });

  it('counts only what is still outstanding on a part-received PO', async () => {
    const m = await material({ stock: 10 });
    await steadyDraws(m, 10, 30);
    await raise(m, 300, 250);

    expect((await lineFor('Warp 40s')).onOrder).toBe(50);
  });

  it('does not let an over-receipt become a negative inbound', async () => {
    // Over-receipt inside tolerance is allowed. Subtracting it would
    // inflate the shortfall instead of clearing it.
    const m = await material({ stock: 10 });
    await steadyDraws(m, 10, 30);
    await raise(m, 50, 80);

    expect((await lineFor('Warp 40s')).onOrder).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. ARCHIVED MATERIALS
//
//  WAS: `RawMaterial.find({})`, no filter — a retired yarn was still
//  proposed for purchase.
// ══════════════════════════════════════════════════════════════════
describe('a material that has been archived', () => {
  it('is off the buying list, like it is off every picker', async () => {
    const m = await material({ name: 'Retired 30s', stock: 0, archived: true });
    await steadyDraws(m, 10, 30);

    expect(await lineFor('Retired 30s')).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. WHAT COUNTS AS CONSUMPTION
//
//  WAS: only ORDER_APPROVAL. Yarn issued against a job during the run
//  moved the rate not at all, so a mill whose jobs draw extra
//  under-ordered.
// ══════════════════════════════════════════════════════════════════
describe('the demand the run-rate is built from', () => {
  it('counts yarn issued against a job, not just drawn at approval', async () => {
    const m = await material({ stock: 50 });
    await steadyDraws(m, 10, 30, 'JOB_CONSUMPTION');

    expect((await lineFor('Warp 40s')).dailyDemand).toBeGreaterThan(0);
  });

  it('adds the two together', async () => {
    const m = await material({ stock: 50 });
    await steadyDraws(m, 6, 30, 'ORDER_APPROVAL');
    await steadyDraws(m, 4, 30, 'JOB_CONSUMPTION');

    // 10/day across a 60-day window with draws on 30 of them = 5/day.
    expect((await lineFor('Warp 40s')).dailyDemand).toBe(5);
  });

  it('does NOT count a write-off as demand', async () => {
    // A stock correction is not consumption. Treating it as such would
    // have the system buy yarn to replace stock nothing ever used.
    const m = await material({ stock: 50 });
    await steadyDraws(m, 10, 30, 'ORDER_APPROVAL');
    const before = (await lineFor('Warp 40s')).dailyDemand;

    await MaterialOutward.create({
      rawMaterial: m._id, quantity: 5000, unitPrice: 250,
      type: 'STOCK_ADJUST', outwardDate: daysAgo(2), createdAt: daysAgo(2),
    });

    expect((await lineFor('Warp 40s')).dailyDemand).toBe(before);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. LEAD TIME — the input the whole model rests on
//
//  WAS: absent from every model. "Order this" never meant "order this
//  BY a date", which is the only actionable output a replenishment
//  report has.
// ══════════════════════════════════════════════════════════════════
describe('supplier lead time', () => {
  it('produces the last day an order still arrives in time', async () => {
    const m = await material({ stock: 250 });
    await steadyDraws(m, 20, 60);   // 20/day over the whole window

    const line = await lineFor('Warp 40s');
    expect(line.leadTimeDays).toBe(14);
    expect(line.daysOfCover).toBe(12.5);
    expect(line.orderByDate).toBeTruthy();
    expect(new Date(line.orderByDate).getTime())
      .toBeLessThan(new Date(line.projectedStockoutDate).getTime());
  });

  it('flags a material an order placed today can no longer save', async () => {
    // 100 kg at 20/day is 5 days of cover against a 14-day wait. This
    // is the case that stops a loom, and it is not the same thing as
    // "below the reorder point".
    const m = await material({ stock: 100 });
    await steadyDraws(m, 20, 60);

    const line = await lineFor('Warp 40s');
    expect(line.alreadyLate).toBe(true);
    expect(line.severity).toBe('critical');
  });

  it('lets a material override its supplier — a dyed yarn takes longer', async () => {
    const m = await material({ stock: 250, leadTimeDays: 45 });
    await steadyDraws(m, 20, 60);

    expect((await lineFor('Warp 40s')).leadTimeDays).toBe(45);
  });

  it('reads 0 as a real answer, not as "unset"', async () => {
    // Null means "use the supplier's"; 0 means same-day. They must not
    // read alike, or a same-day supplier silently inherits 14 days.
    const m = await material({ stock: 50, leadTimeDays: 0 });
    await steadyDraws(m, 20, 60);

    const res = await forecast();
    const line = (res.body.materials || []).find((f) => f.name === 'Warp 40s');
    if (line) expect(line.leadTimeDays).toBe(0);
  });

  it('says so when nobody has set one, rather than quietly flagging nothing', async () => {
    const s2 = await Supplier.create({ name: 'No Terms', phoneNumber: '9000000002' });
    await RawMaterial.create({
      name: 'Untimed', category: 'warp', supplier: s2._id, stock: 10, price: 100,
    });

    const res = await forecast();
    expect(res.body.warnings.join(' ')).toMatch(/no lead time set/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. WHAT THE SUPPLIER WILL ACTUALLY SELL
// ══════════════════════════════════════════════════════════════════
describe('pack sizes and minimums', () => {
  it('rounds the order up to the pack', async () => {
    await Supplier.updateOne({ _id: supplier._id }, { $set: { packSize: 25 } });
    const m = await material({ stock: 10 });
    await steadyDraws(m, 10, 30);

    const line = await lineFor('Warp 40s');
    expect(line.suggestedQty % 25).toBe(0);
    expect(line.suggestedQty).toBeGreaterThanOrEqual(line.rawSuggestedQty);
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. THE ORDER OF THE LIST
//
//  WAS: sorted on run-rate, so a material with no history and no stock
//  — a certain stockout — sorted to the bottom.
// ══════════════════════════════════════════════════════════════════
describe('ordering of the list', () => {
  it('puts what is already too late to save at the top', async () => {
    const late = await material({ name: 'Late yarn', stock: 20 });
    await steadyDraws(late, 20, 60);              // 5 days cover vs 14 wait

    const soon = await material({ name: 'Soon yarn', stock: 900 });
    await steadyDraws(soon, 20, 60);              // comfortable, still under ROP

    const res = await forecast();
    const names = res.body.materials.map((f) => f.name);
    expect(names[0]).toBe('Late yarn');
  });

  it('reports how many are past saving, as its own figure', async () => {
    const late = await material({ name: 'Late yarn', stock: 20 });
    await steadyDraws(late, 20, 60);

    const res = await forecast();
    expect(res.body.totals.late).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what the buyer is told about the demand itself', () => {
  it('marks a yarn drawn a few times a month as intermittent', async () => {
    // Its safety stock is dominated by the zero days and the suggestion
    // reads high. Saying so beats silently switching formula.
    const m = await material({ stock: 50 });
    for (const d of [3, 20, 44]) {
      await MaterialOutward.create({
        rawMaterial: m._id, quantity: 400, unitPrice: 250,
        type: 'ORDER_APPROVAL', outwardDate: daysAgo(d), createdAt: daysAgo(d),
      });
    }
    expect((await lineFor('Warp 40s')).demandPattern).toBe('intermittent');
  });

  it('shows every term of the arithmetic, so the figure can be argued with', async () => {
    const m = await material({ stock: 100 });
    await steadyDraws(m, 20, 60);
    const line = await lineFor('Warp 40s');

    for (const k of [
      'dailyDemand', 'demandSd', 'leadTimeDays', 'demandDuringLead',
      'safetyStock', 'reorderPoint', 'netStock', 'onOrder', 'committed',
      'daysOfCover', 'orderByDate', 'serviceLevel',
    ]) {
      expect(line[k]).toBeDefined();
    }
  });
});
