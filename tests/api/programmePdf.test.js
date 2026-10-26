'use strict';
// ══════════════════════════════════════════════════════════════════
//  GET /warping/:id/programme.pdf and /covering/:id/programme.pdf
//
//  The printable programmes, drawn on the server: the job's customer
//  (which the warping page never loaded), each beam with its dye lot,
//  the ends worked out where the plan stored none, and the covering's
//  elastics with their spandex and beam weights.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const download = (url) => request(app).get(url).set('Cookie', cookie())
  .buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'RawMaterial', 'YarnLot', 'Warping', 'WarpingPlan', 'Covering', 'JobOrder', 'Order', 'Customer', 'Elastic']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

async function seed() {
  const customer = await M.Customer.create({ name: 'Suguna Garments', contactName: 'S', phoneNumber: '9111111111', address: 'T', email: 's@t.co' });
  const spandex = await M.RawMaterial.create({ name: 'Spandex 840D', category: 'rubber', stock: 500, price: 900 });
  const nylon = await M.RawMaterial.create({ name: 'Nylon 70D', category: 'covering', stock: 500, price: 320 });
  const maroon = await M.RawMaterial.create({ name: 'VHB1406 D.MAROON VPH', category: 'warp', stock: 500, price: 200 });
  const elastic = await M.Elastic.create({
    name: 'SUGUNA PLAIN 8MM MAROON', weight: 5, noOfHook: 24, pick: 40, spandexEnds: 9,
    warpSpandex: { id: spandex._id, weight: 0.42 }, spandexCovering: { id: nylon._id, weight: 0.2 },
  });
  const order = await M.Order.create({
    customer: customer._id, po: 'PO-1', date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1800 }],
  });
  const job = await M.JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(), status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 1800 }],
  });
  const lot = await M.YarnLot.create({ rawMaterial: maroon._id, lotNo: 'D-4471', shade: 'Maroon', receivedQty: 100 });
  const warping = await M.Warping.create({ job: job._id, status: 'open', date: new Date('2026-10-26'), elasticOrdered: [{ elastic: elastic._id, quantity: 1800 }] });
  const plan = await M.WarpingPlan.create({
    warping: warping._id, job: job._id, noOfBeams: 2,
    beams: [
      // No totalEnds stored: the sheet works it out.
      { beamNo: 1, tapeNo: 1, elastic: elastic._id, sections: [{ warpYarn: maroon._id, ends: 54, maxMeters: 1500, yarnLot: lot._id }] },
      { beamNo: 2, tapeNo: 1, elastic: elastic._id, sections: [{ warpYarn: maroon._id, ends: 54, maxMeters: 1500 }] },
    ],
    remarks: 'Run beam 2 after the shade check.',
  });
  warping.warpingPlan = plan._id;
  await warping.save();
  const covering = await M.Covering.create({
    date: new Date('2026-10-26'), job: job._id, status: 'in_progress',
    elasticPlanned: [{ elastic: elastic._id, quantity: 1800 }],
    beamEntries: [{ beamNo: 1, weight: 12.5 }],
  });
  return { warping, covering, job, order };
}

describe('the warping programme PDF', () => {
  it('is a PDF naming the customer, the job, each beam, its dye lot and the tape\'s ends', async () => {
    const { warping, order } = await seed();
    const res = await download(`/api/v2/warping/${warping._id}/programme.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    expect(res.headers['content-disposition']).toMatch(/warping-programme-J-/);
    const text = await pdfText(res.body);
    expect(text).toMatch(/WARPING PROGRAMME/);
    expect(text).toMatch(/Suguna Garments/);
    expect(text).toContain(`#${order.orderNo}`);
    expect(text).toMatch(/SUGUNA PLAIN 8MM MAROON/);
    expect(text).toMatch(/VHB1406 D\.MAROON VPH/);
    expect(text).toMatch(/D-4471 · Maroon/);
    expect(text).toMatch(/2 beams · 108 ends/);
    expect(text).toMatch(/Run beam 2 after the shade check\./);
  });

  it('is 404 for a warping that does not exist, 400 for a bad id', async () => {
    expect((await download(`/api/v2/warping/${new mongoose.Types.ObjectId()}/programme.pdf`)).status).toBe(404);
    expect((await download('/api/v2/warping/nope/programme.pdf')).status).toBe(400);
  });

  it('the warping detail now carries the customer for the page', async () => {
    const { warping } = await seed();
    const res = await request(app).get(`/api/v2/warping/detail/${warping._id}`).set('Cookie', cookie());
    expect(res.body.warping.job.customer.name).toBe('Suguna Garments');
  });
});

describe('the covering programme PDF', () => {
  it('names the customer and each elastic with its spandex, and the weighed beams', async () => {
    const { covering } = await seed();
    const res = await download(`/api/v2/covering/${covering._id}/programme.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    const text = await pdfText(res.body);
    expect(text).toMatch(/COVERING PROGRAMME/);
    expect(text).toMatch(/Suguna Garments/);
    expect(text).toMatch(/Spandex 840D/);
    expect(text).toMatch(/Nylon 70D/);
    // 0.42 + 0.2 = 0.62 g/m; 1800 × 0.62 / 1000 = 1.116 kg
    expect(text).toMatch(/0\.62/);
    expect(text).toMatch(/1\.12/);
    expect(text).toMatch(/12\.5/);
    expect(text).toMatch(/In progress/);
  });

  it('is 404 for a covering that does not exist', async () => {
    expect((await download(`/api/v2/covering/${new mongoose.Types.ObjectId()}/programme.pdf`)).status).toBe(404);
  });
});
