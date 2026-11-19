'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT TO BUY: THREE LISTS THAT LEFT THINGS OUT, OR PUT THEM IN TWICE
//
//  Found reading api/rawMaterialReplenishment.js line by line.
//
//  1. THE BUYING LIST DID NOT KNOW WHAT APPROVED ORDERS ARE STILL OWED.
//     /replenishment-forecast counts "committed" demand — yarn that will
//     leave stock for orders in hand — from OPEN orders only: "not yet
//     approved, so not yet drawn". An order approved on part stock has
//     left Open with part of its yarn undrawn, and that part was in no
//     bucket at all. Force an order for 100 kg through with 60 kg in
//     stock, and the buying list forgot the other 40 kg.
//
//  2. REORDER SUGGESTIONS RE-ORDERED WHAT WAS ALREADY ON ORDER. The web's
//     "Raise PO" per supplier tops each low material up to twice its
//     minimum — and did not look at open purchase orders. The same
//     shortfall was offered again every time the page was opened, the
//     fault the forecast's own header describes having put right there.
//     Retired (archived) materials were offered too.
//
//  3. A WRITE-OFF COUNTED AS CONSUMPTION. /projected-stockout, and the
//     morning digest's copy of it, added up every outward movement —
//     stock written off in a count among them. The forecast leaves those
//     out on purpose ("a count correction is not demand"); these two did
//     not, and called a material days from running out because somebody
//     had corrected its count.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'RawMaterial', 'Supplier', 'PurchaseOrder']) M[n] = require(`../../models/${n}.js`);
  M.MaterialOutward = require('../../models/MaterialOut.cjs');
  admin = await M.User.create({ name: 'Owner', email: 'replenish@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
/** An open order for 100,000 m of an elastic taking 1 g of nylon a metre: 100 kg. */
async function scene({ stock = 100, minStock = 0 } = {}) {
  seq += 1;
  const supplier = await M.Supplier.create({ name: `Kumar Yarns ${seq}`, phoneNumber: '9000000001' });
  const yarn = await M.RawMaterial.create({ name: `Nylon ${seq}`, category: 'Yarn', stock, minStock, price: 300, avgCost: 300, supplier: supplier._id });
  const elastic = await M.Elastic.create({
    name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, weight: 1 }],
  });
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const order = await M.Order.create({
    customer: customer._id, status: 'Open', po: `ACME-${seq}`, date: new Date('2026-05-01'), supplyDate: new Date('2026-07-15'),
    elasticOrdered: [{ elastic: elastic._id, quantity: 100_000, rate: 10 }],
    pendingElastic: [{ elastic: elastic._id, quantity: 100_000 }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    packedElastic: [{ elastic: elastic._id, quantity: 0 }],
    rawMaterialRequired: [{ rawMaterial: yarn._id, name: yarn.name, requiredWeight: 100 }],
  });
  return { supplier, yarn, elastic, customer, order };
}
const approve = async (s, { force = false } = {}) => {
  const res = await post('/order/approve', { orderId: String(s.order._id), ...(force ? { force: true, forceReason: 'proceeding on part stock' } : {}) });
  if (res.status >= 400) throw new Error(`approve failed: ${res.status} ${JSON.stringify(res.body)}`);
};
const raise = async (s, quantity, extra = {}) => {
  const res = await post('/job/create', { orderId: String(s.order._id), date: '2026-05-03', elastics: [{ elastic: String(s.elastic._id), quantity }], ...extra });
  if (res.status >= 400) throw new Error(`job create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.job;
};
const move = async (s, adjustment, job = null) => {
  const res = await post('/materials/bulk-adjust-stock', {
    adjustments: [{ _id: String(s.yarn._id), adjustment, reason: job ? 'Balance for the run' : 'Count correction', ...(job ? { job: String(job._id) } : {}) }],
  });
  if (res.status >= 400 || res.body.errors?.length) throw new Error(`stock move failed: ${res.status} ${JSON.stringify(res.body)}`);
};
const forecastRow = async (s) => {
  const res = await get('/materials/replenishment-forecast?includeHealthy=1');
  if (res.status >= 400) throw new Error(`forecast failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.materials.find((m) => String(m._id) === String(s.yarn._id));
};
const openPo = (s, quantity, received = 0, status = 'Open') => M.PurchaseOrder.create({
  poNo: 9000 + (seq += 1), supplier: s.supplier._id, status,
  items: [{ rawMaterial: s.yarn._id, quantity, price: 300, receivedQuantity: received }],
});

// ══════════════════════════════════════════════════════════════════
describe('the buying list and an order approved on part stock', () => {
  it('still counts the yarn the order is owed', async () => {
    const s = await scene({ stock: 60 });
    await approve(s, { force: true });            // draws the 60 there is; 40 still owed

    const row = await forecastRow(s);
    // Before: committed 0 — the order had left Open, and the 40 kg with it.
    expect(row).toMatchObject({ onHand: 0, committed: 40, netStock: -40, needsOrder: true });
    expect(row.suggestedQty).toBeGreaterThanOrEqual(40);
  });

  it('stops counting it once the stores have issued it to the job', async () => {
    const s = await scene({ stock: 60 });
    await approve(s, { force: true });
    const job = await raise(s, 100_000);
    await move(s, 40);
    await move(s, -40, job);
    expect(await forecastRow(s)).toMatchObject({ onHand: 0, committed: 0 });
  });

  it('counts what a forced over-plan could not draw, too', async () => {
    const s = await scene({ stock: 105 });
    await approve(s);                             // 100 drawn, 5 left
    await raise(s, 120_000, { force: true, forceReason: 'Yarn due on Thursday' });   // wants 20 more, gets 5
    expect(await forecastRow(s)).toMatchObject({ onHand: 0, committed: 15 });
  });

  it('an order approved in full adds nothing (unchanged)', async () => {
    const s = await scene({ stock: 130 });
    await approve(s);
    expect(await forecastRow(s)).toMatchObject({ onHand: 30, committed: 0 });
  });

  it('an open order still counts in full (unchanged)', async () => {
    const s = await scene({ stock: 130 });
    expect(await forecastRow(s)).toMatchObject({ onHand: 130, committed: 100 });
  });

  it('an order that is finished or called off is owed nothing', async () => {
    const s = await scene({ stock: 60 });
    await approve(s, { force: true });
    for (const status of ['Completed', 'Cancelled']) {
      await M.Order.updateOne({ _id: s.order._id }, { status });
      expect((await forecastRow(s)).committed).toBe(0);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
describe('reorder suggestions', () => {
  const suggestions = async () => {
    const res = await get('/materials/reorder-suggestions');
    if (res.status >= 400) throw new Error(`suggestions failed: ${res.status}`);
    return res.body;
  };
  const itemFor = (body, s) => body.suppliers.flatMap((g) => g.items).find((i) => String(i.materialId) === String(s.yarn._id));

  it('tops a low material up to twice its minimum (unchanged)', async () => {
    const s = await scene({ stock: 20, minStock: 50 });
    await M.Order.deleteMany({});
    expect(itemFor(await suggestions(), s)).toMatchObject({ suggestedQty: 80, onOrder: 0 });
  });

  it('does not order again what is already on order', async () => {
    const s = await scene({ stock: 20, minStock: 50 });
    await openPo(s, 80);
    const body = await suggestions();
    // Before: 80 again, every time the page was opened.
    expect(itemFor(body, s)).toBeUndefined();
    expect(body.count).toBe(0);
  });

  it('orders only what an open purchase order leaves uncovered', async () => {
    const s = await scene({ stock: 20, minStock: 50 });
    await openPo(s, 100, 70, 'Partial');          // 30 still to come
    expect(itemFor(await suggestions(), s)).toMatchObject({ suggestedQty: 50, onOrder: 30 });
  });

  it('a purchase order that is cancelled or has arrived covers nothing', async () => {
    const s = await scene({ stock: 20, minStock: 50 });
    await openPo(s, 80, 0, 'Cancelled');
    await openPo(s, 80, 80, 'Completed');
    expect(itemFor(await suggestions(), s)).toMatchObject({ suggestedQty: 80, onOrder: 0 });
  });

  it('leaves out a material that has been retired', async () => {
    const s = await scene({ stock: 20, minStock: 50 });
    await M.RawMaterial.updateOne({ _id: s.yarn._id }, { archived: true });
    // Before: offered for a purchase order like any other.
    expect(itemFor(await suggestions(), s)).toBeUndefined();
  });

  it('gives quantities as figures', async () => {
    const s = await scene({ stock: 0.3, minStock: 0.2 });
    await M.RawMaterial.updateOne({ _id: s.yarn._id }, { stock: 0.1 });
    // 2 × 0.2 − 0.1. Before: 0.30000000000000004.
    expect(itemFor(await suggestions(), s).suggestedQty).toBe(0.3);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('materials projected to run out', () => {
  const projected = async (query = '') => {
    const res = await get(`/materials/projected-stockout${query}`);
    return res;
  };
  const outward = (s, type, quantity, daysAgo = 2) => M.MaterialOutward.create({
    rawMaterial: s.yarn._id, quantity, type, outwardDate: new Date(Date.now() - daysAgo * 86_400_000), unitPrice: 300, remarks: 'test',
  });

  it('are the ones being USED up', async () => {
    const s = await scene({ stock: 30, minStock: 10 });
    await outward(s, 'JOB_CONSUMPTION', 300);     // 10 kg a day over 30 days: three days left
    const res = await projected();
    expect(res.status).toBe(200);
    expect(res.body.materials.map((m) => String(m._id))).toEqual([String(s.yarn._id)]);
    expect(res.body.materials[0]).toMatchObject({ dailyRate: 10, daysToStockout: 3 });
  });

  it('a write-off is not consumption', async () => {
    const s = await scene({ stock: 30, minStock: 10 });
    await outward(s, 'STOCK_ADJUST', 300);        // a count correction
    // Before: "three days from running out".
    expect((await projected()).body.materials).toEqual([]);
  });

  it('a retired material is not on the list', async () => {
    const s = await scene({ stock: 30, minStock: 10 });
    await outward(s, 'JOB_CONSUMPTION', 300);
    await M.RawMaterial.updateOne({ _id: s.yarn._id }, { archived: true });
    expect((await projected()).body.materials).toEqual([]);
  });

  it('an enormous window is the longest window, not an empty answer', async () => {
    const s = await scene({ stock: 30, minStock: 10 });
    await outward(s, 'JOB_CONSUMPTION', 300);
    const res = await projected('?lookbackDays=99999999999999&horizonDays=99999');
    expect(res.status).toBe(200);
    // Before: the look-back was taken off today's date as it came, which
    // left no start date at all — and nothing was ever running out.
    expect(res.body).toMatchObject({ lookbackDays: 365, horizonDays: 120 });
    expect(res.body.materials.map((m) => String(m._id))).toEqual([String(s.yarn._id)]);

    const usual = await projected('?lookbackDays=abc&horizonDays=');
    expect(usual.body).toMatchObject({ lookbackDays: 30, horizonDays: 7 });
  });

  it('the morning digest holds to the same rule', async () => {
    const used = await scene({ stock: 30, minStock: 10 });
    const corrected = await scene({ stock: 30, minStock: 10 });
    const retired = await scene({ stock: 30, minStock: 10 });
    await outward(used, 'JOB_CONSUMPTION', 300);
    await outward(corrected, 'STOCK_ADJUST', 300);
    await outward(retired, 'JOB_CONSUMPTION', 300);
    await M.RawMaterial.updateOne({ _id: retired.yarn._id }, { archived: true });

    const { buildDigestData } = require('../../utils/digest.js');
    const d = await buildDigestData(new Date());
    // Before: all three.
    expect(d.stockouts.map((x) => x.name)).toEqual([used.yarn.name]);
  });
});

describe('materials at or under their minimum', () => {
  it('do not include one that has been retired', async () => {
    const low = await scene({ stock: 5, minStock: 50 });
    const retired = await scene({ stock: 5, minStock: 50 });
    const noMinimum = await scene({ stock: 0, minStock: 0 });
    await M.RawMaterial.updateOne({ _id: retired.yarn._id }, { archived: true });

    // The list a purchase order is drafted from: a minimum has to be set.
    const advisor = await get('/materials/low-stock');
    // Before: the retired one too.
    expect(advisor.body.materials.map((m) => String(m._id))).toEqual([String(low.yarn._id)]);

    // The plain list keeps the rule the material list's own red flag
    // uses (stock at or under minimum — so out of stock with no minimum
    // counts), less what has been retired.
    const older = await get('/materials/get-low-stock-materials');
    expect(older.body.materials.map((m) => String(m._id)))
      .toEqual([String(noMinimum.yarn._id), String(low.yarn._id)]);
  });
});
