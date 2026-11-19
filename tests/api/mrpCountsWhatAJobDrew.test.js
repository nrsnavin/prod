'use strict';
// ══════════════════════════════════════════════════════════════════
//  YARN A JOB HAS ALREADY TAKEN, ON THE SHEETS THAT SAY WHAT IS SHORT
//
//  Found reading api/jobMaterials.js, api/orderMaterials.js and
//  api/orderDetail.js line by line.
//
//  The requirement sheets set what a job or an order needs against what
//  has already left stock for it, and call the rest short. "Already left
//  stock" was the order's approval draw and nothing else. Yarn leaves
//  stock for a job in two more ways, and neither was counted:
//
//  1. THE JOB'S OWN DRAW. A job planned past its order draws the yarn
//     for the extra metres when it is raised (services/jobRaise.js). The
//     order's requirement is restated for the larger plan at the same
//     moment — so the sheets showed the larger requirement against the
//     smaller draw, and the extra read as still owed. On an order for
//     100,000 m with a job for 120,000 m: 120 kg needed, 100 kg "held",
//     20 kg outstanding — the 20 kg the job had drawn a moment before.
//     The job's sheet called it short and its Raise PO bought it again.
//
//  2. WHAT THE STORES ISSUE TO A JOB. A forced approval draws what is
//     there and leaves the rest owed. When that rest arrives and the
//     stores issue it to the job, it leaves the stock figure — and the
//     sheets, not counting the issue, read the job as short of exactly
//     the yarn it had just been handed.
//
//  Also: a sibling job's share of the approval draw was worked out on
//  the restated (larger) requirement, so one job planning over the order
//  made the others read short.
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
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'RawMaterial', 'Supplier', 'PurchaseOrder']) M[n] = require(`../../models/${n}.js`);
  M.MaterialOutward = require('../../models/MaterialOut.cjs');
  admin = await M.User.create({ name: 'Owner', email: 'mrp-drew@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
/** An open order for 100,000 m of an elastic taking 1 g of nylon a metre: 100 kg. */
async function scene({ stock = 100, metres = 100_000 } = {}) {
  seq += 1;
  const supplier = await M.Supplier.create({ name: `Kumar Yarns ${seq}`, phoneNumber: '9000000001' });
  const yarn = await M.RawMaterial.create({ name: `Nylon ${seq}`, category: 'Yarn', stock, price: 300, avgCost: 300, supplier: supplier._id });
  const elastic = await M.Elastic.create({
    name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, weight: 1 }],
  });
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const order = await M.Order.create({
    customer: customer._id, status: 'Open', po: `ACME-${seq}`, date: new Date('2026-05-01'), supplyDate: new Date('2026-07-15'),
    elasticOrdered: [{ elastic: elastic._id, quantity: metres, rate: 10 }],
    pendingElastic: [{ elastic: elastic._id, quantity: metres }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    packedElastic: [{ elastic: elastic._id, quantity: 0 }],
    rawMaterialRequired: [{ rawMaterial: yarn._id, name: yarn.name, requiredWeight: metres / 1000 }],
  });
  return { supplier, yarn, elastic, customer, order };
}
const approve = async (s, { force = false } = {}) => {
  const res = await post('/order/approve', {
    orderId: String(s.order._id), ...(force ? { force: true, forceReason: 'proceeding on part stock' } : {}),
  });
  if (res.status >= 400) throw new Error(`approve failed: ${res.status} ${JSON.stringify(res.body)}`);
};
const raise = async (s, quantity, extra = {}) => {
  const res = await post('/job/create', {
    orderId: String(s.order._id), date: '2026-05-03', elastics: [{ elastic: String(s.elastic._id), quantity }], ...extra,
  });
  if (res.status >= 400) throw new Error(`job create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.job;
};
/** The stores' own line: so many kilos in (+) or out (−), out naming the job it went to. */
const move = async (s, adjustment, job = null) => {
  const res = await post('/materials/bulk-adjust-stock', {
    adjustments: [{ _id: String(s.yarn._id), adjustment, reason: job ? 'Balance for the run' : 'Received', ...(job ? { job: String(job._id) } : {}) }],
  });
  if (res.status >= 400 || res.body.errors?.length) throw new Error(`stock move failed: ${res.status} ${JSON.stringify(res.body)}`);
};
const stock = async (s) => (await M.RawMaterial.findById(s.yarn._id).lean()).stock;
const jobRow = async (s, job) => {
  const res = await get(`/job/${job._id}/mrp`);
  if (res.status >= 400) throw new Error(`job mrp failed: ${res.status}`);
  return res.body.data.materials.find((m) => String(m.rawMaterial) === String(s.yarn._id));
};
const orderRow = async (s) => {
  const res = await get(`/order/${s.order._id}/mrp`);
  if (res.status >= 400) throw new Error(`order mrp failed: ${res.status}`);
  return res.body.data.materials.find((m) => String(m.rawMaterial) === String(s.yarn._id));
};
const pageRow = async (s) => {
  const res = await get(`/order/get-orderDetail?id=${s.order._id}`);
  if (res.status >= 400) throw new Error(`order detail failed: ${res.status}`);
  return res.body.data.rawMaterialRequired.find((m) => String(m.rawMaterial) === String(s.yarn._id));
};

// ══════════════════════════════════════════════════════════════════
describe('a job planned past its order', () => {
  it('is not short of the yarn it drew for the extra metres', async () => {
    const s = await scene({ stock: 125 });
    await approve(s);                             // 100 kg out: 25 left
    const job = await raise(s, 120_000);          // 20% over: 20 kg more out
    expect(await stock(s)).toBe(5);

    const row = await jobRow(s, job);
    // Before: allocated 100, outstanding 20, shortfall 15, toBuy 15.
    expect(row).toMatchObject({ requiredWeight: 120, allocated: 120, outstanding: 0, shortfall: 0, toBuy: 0 });
  });

  it('cannot have that yarn bought a second time from its sheet', async () => {
    const s = await scene({ stock: 125 });
    await approve(s);
    const job = await raise(s, 120_000);

    const res = await post(`/job/${job._id}/raise-po`, {});
    // Before: 201 — a purchase order for 15 kg of yarn already on the job.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nothing is short/i);
    expect(await M.PurchaseOrder.countDocuments({})).toBe(0);
  });

  it('reads as fully held on the order page too', async () => {
    const s = await scene({ stock: 125 });
    await approve(s);
    await raise(s, 120_000);

    const row = await pageRow(s);
    // Before: allocated 100, outstanding 20, "partial" — as if the approval had been forced.
    expect(row).toMatchObject({ requiredWeight: 120, allocated: 120, outstanding: 0, allocationState: 'full' });
  });

  it('still shows what a forced raise could not draw', async () => {
    const s = await scene({ stock: 105 });
    await approve(s);                             // 5 left
    const job = await raise(s, 120_000, { force: true, forceReason: 'Yarn due on Thursday' });   // wants 20, gets 5
    expect(await stock(s)).toBe(0);

    const row = await jobRow(s, job);
    expect(row).toMatchObject({ requiredWeight: 120, allocated: 105, outstanding: 15, shortfall: 15, toBuy: 15 });
  });

  it('does not make the order\'s other jobs read short', async () => {
    const s = await scene({ stock: 120 });
    await approve(s);                             // 100 kg for the 100,000 m ordered
    const first = await raise(s, 60_000);         // inside the order
    const second = await raise(s, 60_000);        // takes it 20,000 m over: draws 20 kg itself
    expect(await stock(s)).toBe(0);

    // Before: 50 and 10 — the approval's 100 kg shared out over 120,000 m.
    expect(await jobRow(s, first)).toMatchObject({ requiredWeight: 60, allocated: 60, outstanding: 0, shortfall: 0 });
    expect(await jobRow(s, second)).toMatchObject({ requiredWeight: 60, allocated: 60, outstanding: 0, shortfall: 0 });
  });

  it('gives the yarn up again when the job is cancelled', async () => {
    const s = await scene({ stock: 125 });
    await approve(s);
    const job = await raise(s, 120_000);
    expect((await post('/job/cancel', { jobId: String(job._id), reason: 'Raised at the wrong quantity' })).status).toBe(200);
    expect(await stock(s)).toBe(25);

    // The order is back to what was ordered, all of it held by the approval.
    expect(await pageRow(s)).toMatchObject({ requiredWeight: 100, allocated: 100, outstanding: 0, allocationState: 'full' });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('an order approved on part stock', () => {
  /** Forced through with 60 kg of the 100; one job for all of it. */
  async function partStock() {
    const s = await scene({ stock: 60 });
    await approve(s, { force: true });
    const job = await raise(s, 100_000);
    return { s, job };
  }

  it('is short of the rest until it comes (unchanged)', async () => {
    const { s, job } = await partStock();
    expect(await jobRow(s, job)).toMatchObject({ allocated: 60, outstanding: 40, inStock: 0, shortfall: 40, toBuy: 40 });
    expect(await orderRow(s)).toMatchObject({ allocated: 60, outstanding: 40, shortfall: 40 });
    expect(await pageRow(s)).toMatchObject({ allocated: 60, outstanding: 40, allocationState: 'partial' });
  });

  it('is not short of it once the stores have issued it to the job', async () => {
    const { s, job } = await partStock();
    await move(s, 40);                            // the rest arrives
    expect(await jobRow(s, job)).toMatchObject({ outstanding: 40, inStock: 40, shortfall: 0 });
    await move(s, -40, job);                      // and is issued to the job
    expect(await stock(s)).toBe(0);

    // Before: allocated 60, outstanding 40, shortfall 40, toBuy 40 — short of the yarn just handed over.
    expect(await jobRow(s, job)).toMatchObject({ requiredWeight: 100, allocated: 100, outstanding: 0, shortfall: 0, toBuy: 0 });
    expect(await orderRow(s)).toMatchObject({ allocated: 100, outstanding: 0, shortfall: 0 });
    expect(await pageRow(s)).toMatchObject({ allocated: 100, outstanding: 0, allocationState: 'full' });

    const res = await post(`/job/${job._id}/raise-po`, {});
    expect(res.status).toBe(400);
    expect(await M.PurchaseOrder.countDocuments({})).toBe(0);
  });

  it('counts an issue for the job it went to, and for the order once', async () => {
    const s = await scene({ stock: 60 });
    await approve(s, { force: true });
    const first = await raise(s, 50_000);
    const second = await raise(s, 50_000);
    await move(s, 20);
    await move(s, -20, first);

    expect(await jobRow(s, first)).toMatchObject({ requiredWeight: 50, allocated: 50, outstanding: 0 });
    expect(await jobRow(s, second)).toMatchObject({ requiredWeight: 50, allocated: 30, outstanding: 20 });
    expect(await orderRow(s)).toMatchObject({ requiredWeight: 100, allocated: 80, outstanding: 20 });
  });

  it('never holds more than the job needs: yarn issued to replace waste is not a credit', async () => {
    const s = await scene({ stock: 110 });
    await approve(s);                             // all 100 kg held
    const job = await raise(s, 100_000);
    await move(s, -10, job);                      // 10 kg more, for a beam that was spoiled

    expect(await jobRow(s, job)).toMatchObject({ requiredWeight: 100, allocated: 100, outstanding: 0 });
    expect(await orderRow(s)).toMatchObject({ requiredWeight: 100, allocated: 100, outstanding: 0 });
  });

  it('does not count an issue that has been reversed', async () => {
    const { s, job } = await partStock();
    await move(s, 40);
    await move(s, -40, job);
    await M.MaterialOutward.updateOne({ job: job._id, type: 'JOB_CONSUMPTION' }, { reversed: true });

    expect(await jobRow(s, job)).toMatchObject({ allocated: 60, outstanding: 40 });
  });

  it('does not count yarn issued to a job that was then cancelled', async () => {
    const s = await scene({ stock: 60 });
    await approve(s, { force: true });
    const first = await raise(s, 50_000);
    await move(s, 20);
    await move(s, -20, first);
    expect((await post('/job/cancel', { jobId: String(first._id), reason: 'Customer changed the width' })).status).toBe(200);
    const second = await raise(s, 100_000);

    // The cancelled job's yarn is somewhere on the floor; nothing says it is this job's.
    expect(await jobRow(s, second)).toMatchObject({ requiredWeight: 100, allocated: 60, outstanding: 40 });
    expect(await orderRow(s)).toMatchObject({ allocated: 60, outstanding: 40 });
  });
});
