'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHO MOVED THE COSTS
//
//  Found reading api/pnl.js line by line.
//
//  The conversion rate card is four figures that cost every metre the
//  factory has ever made: change one and the margin on every order,
//  past ones too, changes with it. It kept the time it was last saved
//  and nothing else — not who saved it, and not what it had said before.
//
//  A job's actual cost, entered over the rate card, kept the last hand
//  on it and no more: the figure it replaced was gone.
//
//  (The selling rates on an order have had their line on the order's
//  trail from the start; these two are now kept the same way.)
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M = {}, admin, clerk;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const get = (url, u = admin) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u));
const put = (url, body, u = admin) => request(app).put(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const card = async () => (await get('/pnl/settings')).body.settings;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'CostSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'pt@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Meena', email: 'pt-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await M.CostSettings.deleteMany({}); });

// ══════════════════════════════════════════════════════════════════
describe('the conversion rate card', () => {
  it('says who changed it, when, and what each figure was before', async () => {
    expect((await card()).lastChange).toBeNull();
    const res = await put('/pnl/settings', { finishingRatePerMeter: 1.5, packingRatePerMeter: 0.4 }, clerk);
    expect(res.status).toBe(200);
    const c = await card();
    // Before: updatedAt, and no more.
    expect(c.lastChange).toMatchObject({ byName: 'Meena', from: { finishingRatePerMeter: 0, packingRatePerMeter: 0 }, to: { finishingRatePerMeter: 1.5, packingRatePerMeter: 0.4 } });
    expect(Date.now() - new Date(c.lastChange.at).getTime()).toBeLessThan(60_000);
    expect(c.changes).toHaveLength(1);
    expect(c).toMatchObject({ finishingRatePerMeter: 1.5, packingRatePerMeter: 0.4, configured: true });
  });

  it('lists only the figures that moved', async () => {
    await put('/pnl/settings', { finishingRatePerMeter: 1.5, packingRatePerMeter: 0.4 }, clerk);
    await put('/pnl/settings', { finishingRatePerMeter: 2, packingRatePerMeter: 0.4 });
    const c = await card();
    expect(c.lastChange).toMatchObject({ byName: 'Owner', from: { finishingRatePerMeter: 1.5 }, to: { finishingRatePerMeter: 2 } });
    expect(c.lastChange.from).not.toHaveProperty('packingRatePerMeter');
    // Newest first.
    expect(c.changes.map((x) => x.byName)).toEqual(['Owner', 'Meena']);
  });

  it('a save that changes no figure is not a change', async () => {
    await put('/pnl/settings', { finishingRatePerMeter: 1.5 }, clerk);
    expect((await put('/pnl/settings', { finishingRatePerMeter: 1.5 })).status).toBe(200);
    expect((await put('/pnl/settings', { notes: 'Reviewed in November' })).status).toBe(200);
    const c = await card();
    expect(c.changes).toHaveLength(1);
    expect(c.lastChange.byName).toBe('Meena');
    expect(c.notes).toBe('Reviewed in November');
  });

  it('keeps the last fifty', async () => {
    for (let i = 1; i <= 53; i += 1) await put('/pnl/settings', { overheadRatePerMeter: i });
    const doc = await M.CostSettings.findOne({ key: 'cost' }).lean();
    expect(doc.changes).toHaveLength(50);
    expect(doc.changes[49].to).toEqual({ overheadRatePerMeter: 53 });
    expect(doc.changes[0].to).toEqual({ overheadRatePerMeter: 4 });
    // The screen is given the newest ten.
    expect((await card()).changes).toHaveLength(10);
  });

  it('a card saved before this is read as it was (unchanged)', async () => {
    await M.CostSettings.collection.insertOne({ key: 'cost', finishingRatePerMeter: 2.5, checkingRatePerMeter: 0, packingRatePerMeter: 0, overheadRatePerMeter: 4, notes: '', createdAt: new Date(), updatedAt: new Date() });
    const c = await card();
    expect(c).toMatchObject({ finishingRatePerMeter: 2.5, overheadRatePerMeter: 4, configured: true, lastChange: null, changes: [] });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a job\'s actual cost', () => {
  let job;
  beforeEach(async () => {
    const customer = await M.Customer.create({ name: `Acme ${Date.now()}`, contactName: 'Ms Rao', phoneNumber: '9000000001' });
    const order = await M.Order.create({ customer: customer._id, po: 'PO-1', date: new Date('2026-03-01'), supplyDate: new Date('2026-06-30'), status: 'Approved', elasticOrdered: [] });
    job = await M.JobOrder.create({ order: order._id, customer: customer._id, date: new Date('2026-03-02'), status: 'weaving' });
  });
  const trail = async () => (await M.JobOrder.findById(job._id).lean()).fingerprints.filter((f) => f.code === 'JOB_COST_RECORDED');

  it('leaves a line on the job\'s trail: who, and from what to what', async () => {
    const set = await put(`/pnl/job/${job._id}/cost-overrides`, { finishing: 3500, notes: 'Rework on 200 m' }, clerk);
    expect(set.status).toBe(200);
    let lines = await trail();
    // Before: nothing on the trail at all.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ label: 'Actual Cost Recorded', actor: { name: 'Meena' } });
    expect(lines[0].meta).toMatchObject({ previousValues: { finishing: null, notes: '' }, newValues: { finishing: 3500, notes: 'Rework on 200 m' } });

    // Changed, then handed back to the rate card: the figure it replaced is kept.
    await put(`/pnl/job/${job._id}/cost-overrides`, { finishing: 4200 });
    await put(`/pnl/job/${job._id}/cost-overrides`, { finishing: null });
    lines = await trail();
    expect(lines).toHaveLength(3);
    expect(lines[1].meta).toMatchObject({ previousValues: { finishing: 3500 }, newValues: { finishing: 4200 } });
    expect(lines[2].meta).toMatchObject({ previousValues: { finishing: 4200 }, newValues: { finishing: null } });
    expect(lines[2].actor.name).toBe('Owner');
  });

  it('a save that changes nothing adds no line', async () => {
    await put(`/pnl/job/${job._id}/cost-overrides`, { packing: 800 });
    expect((await put(`/pnl/job/${job._id}/cost-overrides`, { packing: 800 })).status).toBe(200);
    expect(await trail()).toHaveLength(1);
    // And the override is as it was set.
    expect((await M.JobOrder.findById(job._id).lean()).costOverrides).toMatchObject({ packing: 800, finishing: null });
  });
});
