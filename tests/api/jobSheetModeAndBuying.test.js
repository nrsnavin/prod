'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE JOB'S REQUIREMENT SHEET: WHO MAKES IT, AND WHEN IT MAY BUY
//
//  Found reading api/jobMaterials.js line by line.
//
//  1. IN-HOUSE OR OUTSOURCED LEFT NO MARK. Switching a job to a vendor —
//     or back, or to a different vendor — was written straight onto the
//     job with nothing on its trail. The neighbouring vendor record
//     writes a line each time it is saved; the decision it depends on
//     wrote none. Who sent J-12 out, and when, could not be answered —
//     and the order's costing reads an outsourced job's output from the
//     vendor record, so the switch changes the figures as well.
//
//  2. YARN COULD BE BOUGHT FOR A JOB THAT WOULD NEVER USE IT. "Raise PO"
//     on the sheet worked out what the job was short of and bought it,
//     whatever state the job was in: cancelled, completed, or long off
//     the loom. A cancelled job under an order approved on part stock
//     read as short for good, and each press bought the gap.
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
const post  = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const patch = (url, body) => request(app).patch(`/api/v2${url}`).set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'RawMaterial', 'Supplier', 'PurchaseOrder']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'job-sheet@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
/** A job for 100,000 m under an approved order that holds none of its 100 kg of yarn. */
async function scene({ status = 'preparatory' } = {}) {
  seq += 1;
  const supplier = await M.Supplier.create({ name: `Kumar Yarns ${seq}`, phoneNumber: '9000000001' });
  const yarn = await M.RawMaterial.create({ name: `Nylon ${seq}`, category: 'Yarn', stock: 0, price: 300, supplier: supplier._id });
  const elastic = await M.Elastic.create({
    name: `20mm ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, weight: 1 }],
  });
  const customer = await M.Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const order = await M.Order.create({
    customer: customer._id, status: 'Approved', po: `ACME-${seq}`, date: new Date('2026-05-01'), supplyDate: new Date('2026-07-15'),
    elasticOrdered: [{ elastic: elastic._id, quantity: 100_000 }],
    rawMaterialRequired: [{ rawMaterial: yarn._id, name: yarn.name, requiredWeight: 100 }],
  });
  const job = await M.JobOrder.create({
    date: new Date('2026-05-03'), order: order._id, customer: customer._id, status,
    elastics: [{ elastic: elastic._id, quantity: 100_000 }],
  });
  return { yarn, order, job };
}
const trail = async (job, code = 'JOB_PRODUCTION_MODE_CHANGED') =>
  ((await M.JobOrder.findById(job._id).lean()).fingerprints || []).filter((f) => f.code === code);
const setMode = (job, productionMode, outsourceVendor) =>
  patch(`/job/${job._id}/production-mode`, { productionMode, ...(outsourceVendor !== undefined ? { outsourceVendor } : {}) });

// ══════════════════════════════════════════════════════════════════
describe('sending a job out to a vendor', () => {
  it('is written on the job\'s trail: from, to, the vendor, and who', async () => {
    const s = await scene();
    const res = await setMode(s.job, 'outsource', '  Sri Sakthi Weaving ');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ productionMode: 'outsource', outsourceVendor: 'Sri Sakthi Weaving' });

    const rows = await trail(s.job);
    // Before: nothing at all.
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Production Mode Changed');
    expect(rows[0].meta).toMatchObject({ from: 'in_house', to: 'outsource', vendor: 'Sri Sakthi Weaving', stage: 'preparatory' });
    expect(String(rows[0].actor?.id ?? rows[0].actor)).toBe(String(admin._id));
  });

  it('bringing it back in-house says whose it had been', async () => {
    const s = await scene();
    await setMode(s.job, 'outsource', 'Sri Sakthi Weaving');
    const res = await setMode(s.job, 'in_house');
    expect(res.body.data).toMatchObject({ productionMode: 'in_house', outsourceVendor: '' });

    const rows = await trail(s.job);
    expect(rows).toHaveLength(2);
    expect(rows[1].meta).toMatchObject({ from: 'outsource', to: 'in_house', previousVendor: 'Sri Sakthi Weaving', vendor: '' });
  });

  it('a change of vendor alone is a line too', async () => {
    const s = await scene();
    await setMode(s.job, 'outsource', 'Sri Sakthi Weaving');
    await setMode(s.job, 'outsource', 'Annamalai Looms');
    const rows = await trail(s.job);
    expect(rows).toHaveLength(2);
    expect(rows[1].meta).toMatchObject({ from: 'outsource', to: 'outsource', previousVendor: 'Sri Sakthi Weaving', vendor: 'Annamalai Looms' });
  });

  it('saying the same thing twice writes nothing more', async () => {
    const s = await scene();
    await setMode(s.job, 'outsource', 'Sri Sakthi Weaving');
    const again = await setMode(s.job, 'outsource', 'Sri Sakthi Weaving');
    expect(again.status).toBe(200);
    expect(await trail(s.job)).toHaveLength(1);

    const fresh = await scene();
    expect((await setMode(fresh.job, 'in_house')).status).toBe(200);
    expect(await trail(fresh.job)).toHaveLength(0);
  });

  it('is still refused once the job is off the loom, and leaves nothing behind', async () => {
    const s = await scene({ status: 'finishing' });
    const res = await setMode(s.job, 'outsource', 'Sri Sakthi Weaving');
    expect(res.status).toBe(409);
    expect(await trail(s.job)).toHaveLength(0);
    expect((await M.JobOrder.findById(s.job._id).lean()).productionMode).toBe('in_house');
  });

  it('a mode that is neither is a bad request (unchanged)', async () => {
    const s = await scene();
    expect((await setMode(s.job, 'elsewhere')).status).toBe(400);
    expect((await patch('/job/not-an-id/production-mode', { productionMode: 'outsource' })).status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('Raise PO on a job\'s sheet', () => {
  const raisePo = (job) => post(`/job/${job._id}/raise-po`, {});

  it.each(['cancelled', 'completed', 'finishing', 'checking', 'packing'])(
    'buys nothing for a job that is %s', async (status) => {
      const s = await scene({ status });
      const res = await raisePo(s.job);
      // Before: 201 — a purchase order for 100 kg, for a job with nothing left to weave.
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('JOB_OFF_THE_LOOM');
      expect(res.body.message).toMatch(new RegExp(status));
      expect(await M.PurchaseOrder.countDocuments({})).toBe(0);
    });

  it.each(['preparatory', 'weaving'])('still buys what a %s job is short of', async (status) => {
    const s = await scene({ status });
    const res = await raisePo(s.job);
    expect(res.status).toBe(201);
    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(res.body.purchaseOrders[0].lines[0]).toMatchObject({ rawMaterial: String(s.yarn._id), quantity: 100 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a job\'s share of its order\'s approval draw', () => {
  // Required when used: see app.js — models are set up as the server starts.
  const shareForJob = (...args) => require('../../services/orderIssuance').shareForJob(...args);
  const row = (requiredWeight) => [{ rawMaterial: 'm1', requiredWeight }];

  it('is never more than the order drew', () => {
    // A job needing 120 kg under an order whose stored requirement is 100 kg, all of it drawn.
    const share = shareForJob(new Map([['m1', 100]]), row(100), row(120));
    // Before: 120 — twenty kilos nobody took out of stock.
    expect(share.get('m1')).toBe(100);
  });

  it('leaves the metres planned past the order out of the split', () => {
    // Order restated to 120 kg after one job went 20 kg over; the approval drew 100.
    const drawn = new Map([['m1', 100]]);
    const orderExcess = new Map([['m1', 20]]);
    expect(shareForJob(drawn, row(120), row(60), { orderExcess }).get('m1')).toBe(60);
    expect(shareForJob(drawn, row(120), row(60), { orderExcess, jobExcess: new Map([['m1', 20]]) }).get('m1')).toBe(40);
  });

  it('splits a plain order as before', () => {
    expect(shareForJob(new Map([['m1', 100]]), row(100), row(50)).get('m1')).toBe(50);
    expect(shareForJob(new Map([['m1', 60]]), row(100), row(50)).get('m1')).toBe(30);
    expect(shareForJob(new Map(), row(100), row(50)).size).toBe(0);
    expect(shareForJob(new Map([['m1', 100]]), [], row(50)).size).toBe(0);
  });
});
