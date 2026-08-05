'use strict';
// An outsourced job runs no shifts here, so the vendor record IS its
// production record. `finishing` is the point of no return — production
// entry and the outsource toggle both close there — so a record left
// blank at that moment stays blank for good. The move is refused until it
// reconciles.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { outsourcingBlockers, outsourcingDerived } = require('../../utils/outsourcingRecord');

let mongo, app, M = {}, admin, refs;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

const COMPLETE = {
  qtySentMeters: 1000,
  qtyReceivedMeters: 940,
  efficiencyPct: 94,
  actualReturnDate: '2026-05-20',
  notes: 'Returned in two bundles; 60 m short, vendor accepts.',
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ launchTimeout: 60000 }],
  });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'JobOrder', 'Customer', 'Order']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({
    name: 'Owner', email: 'osrec-owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  const cust = await M.Customer.create({ name: 'Acme', contactName: 'Ms Rao', phoneNumber: '9000000009' });
  const ord = await M.Order.create({
    customer: cust._id, orderNo: 9200, po: 'PO-9200',
    date: new Date('2026-03-01'), supplyDate: new Date('2026-06-30'),
  });
  refs = { customer: cust._id, order: ord._id, date: new Date('2026-03-01') };
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const outsourcedJob = (over = {}) =>
  M.JobOrder.create({
    status: 'weaving', productionMode: 'outsource', outsourceVendor: 'Sunrise Weaving',
    ...refs, ...over,
  });

const moveToFinishing = (job) =>
  request(app)
    .post('/api/v2/job/update-status')
    .set('Cookie', adminCookie())
    .send({ jobId: String(job._id), nextStatus: 'finishing' });

describe('the finishing gate on an outsourced job', () => {
  test('refuses the move while the vendor record is blank, and names what is missing', async () => {
    const job = await outsourcedJob();
    const res = await moveToFinishing(job);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/complete the vendor record/i);
    // Every required field is called out, not just the first.
    for (const f of [/quantity sent/i, /quantity received/i, /efficiency/i, /return date/i, /notes/i]) {
      expect(res.body.message).toMatch(f);
    }
    // And the job did NOT move.
    expect((await M.JobOrder.findById(job._id)).status).toBe('weaving');
  });

  test('still refuses when only efficiency and notes are filled', async () => {
    const job = await outsourcedJob();
    await request(app).put(`/api/v2/job/${job._id}/outsourcing`).set('Cookie', adminCookie())
      .send({ efficiencyPct: 94, notes: 'looks fine' });

    const res = await moveToFinishing(job);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/quantity sent/i);
  });

  test('allows the move once the record reconciles', async () => {
    const job = await outsourcedJob();
    const save = await request(app).put(`/api/v2/job/${job._id}/outsourcing`)
      .set('Cookie', adminCookie()).send(COMPLETE);
    expect(save.status).toBe(200);
    expect(save.body.data.blockers).toEqual([]);

    const res = await moveToFinishing(job);
    expect(res.status).toBe(200);
    expect((await M.JobOrder.findById(job._id)).status).toBe('finishing');
  });

  test('an IN-HOUSE job is not gated by this at all', async () => {
    const job = await M.JobOrder.create({ status: 'weaving', ...refs }); // in_house
    const res = await moveToFinishing(job);
    expect(res.status).toBe(200);
  });

  // Present-but-nonsense is as unusable as missing, and more likely to be
  // believed later.
  test.each([
    ['zero quantity sent',   { ...COMPLETE, qtySentMeters: 0 },     /greater than 0/i],
    ['efficiency over 100',  { ...COMPLETE, efficiencyPct: 140 },   /between 0 and 100/i],
    ['negative received',    { ...COMPLETE, qtyReceivedMeters: -5 }, /cannot be negative/i],
    ['a one-word note',      { ...COMPLETE, notes: 'ok' },          /at least 3 characters/i],
  ])('refuses %s', async (_label, payload, expected) => {
    const job = await outsourcedJob();
    await request(app).put(`/api/v2/job/${job._id}/outsourcing`).set('Cookie', adminCookie()).send(payload);
    const res = await moveToFinishing(job);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(expected);
  });
});

describe('the vendor record endpoint', () => {
  test('saves progressively — a half-filled record is allowed to park', async () => {
    const job = await outsourcedJob();
    const res = await request(app).put(`/api/v2/job/${job._id}/outsourcing`)
      .set('Cookie', adminCookie())
      .send({ qtySentMeters: 1000, dispatchDate: '2026-05-01', outwardChallanNo: 'OC-77' });

    expect(res.status).toBe(200);
    expect(res.body.data.qtySentMeters).toBe(1000);
    expect(res.body.data.outwardChallanNo).toBe('OC-77');
    // Not complete yet, and it says so rather than refusing the save.
    expect(res.body.data.blockers.length).toBeGreaterThan(0);
  });

  test('refuses to record vendor work against an in-house job', async () => {
    const job = await M.JobOrder.create({ status: 'weaving', ...refs });
    const res = await request(app).put(`/api/v2/job/${job._id}/outsourcing`)
      .set('Cookie', adminCookie()).send(COMPLETE);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/produced in-house/i);
  });

  test('stays editable after finishing, so a typo needs no status rollback', async () => {
    const job = await outsourcedJob();
    await request(app).put(`/api/v2/job/${job._id}/outsourcing`).set('Cookie', adminCookie()).send(COMPLETE);
    await moveToFinishing(job);

    const fix = await request(app).put(`/api/v2/job/${job._id}/outsourcing`)
      .set('Cookie', adminCookie()).send({ ...COMPLETE, efficiencyPct: 93 });
    expect(fix.status).toBe(200);
    expect(fix.body.data.efficiencyPct).toBe(93);
  });

  test('the job detail exposes the record, its derived figures and its blockers', async () => {
    const job = await outsourcedJob();
    await request(app).put(`/api/v2/job/${job._id}/outsourcing`).set('Cookie', adminCookie())
      .send({ ...COMPLETE, dispatchDate: '2026-05-01', ratePerMeter: 12 });

    const res = await request(app).get(`/api/v2/job/${job._id}`).set('Cookie', adminCookie());
    const body = res.body.data ?? res.body.job ?? res.body;
    expect(body.outsourcing.efficiencyPct).toBe(94);
    expect(body.outsourcing.blockers).toEqual([]);
    expect(body.outsourcing.derived.shortfallMeters).toBe(60);
    expect(body.outsourcing.derived.jobWorkCost).toBe(11280); // 940 × 12
  });

  test('an in-house job reports no outsourcing record', async () => {
    const job = await M.JobOrder.create({ status: 'weaving', ...refs });
    const res = await request(app).get(`/api/v2/job/${job._id}`).set('Cookie', adminCookie());
    const body = res.body.data ?? res.body.job ?? res.body;
    expect(body.outsourcing).toBeNull();
  });
});

describe('derived figures', () => {
  test('surface a disagreement between the entered and implied yield', () => {
    // 940/1000 is 94%, so an entered 98% is 4 points optimistic — that
    // gap is the thing worth taking back to the vendor.
    const d = outsourcingDerived({ qtySentMeters: 1000, qtyReceivedMeters: 940, efficiencyPct: 98 });
    expect(d.derivedEfficiencyPct).toBe(94);
    expect(d.efficiencyVariancePct).toBe(4);
    expect(d.shortfallMeters).toBe(60);
  });

  test('compute vendor lead time from dispatch to return', () => {
    const d = outsourcingDerived({
      qtySentMeters: 100, qtyReceivedMeters: 100,
      dispatchDate: '2026-05-01', actualReturnDate: '2026-05-15',
    });
    expect(d.leadTimeDays).toBe(14);
  });

  test('stay null rather than guessing when the inputs are missing', () => {
    const d = outsourcingDerived({});
    expect(d.shortfallMeters).toBeNull();
    expect(d.derivedEfficiencyPct).toBeNull();
    expect(d.leadTimeDays).toBeNull();
    expect(d.jobWorkCost).toBeNull();
  });

  test('a complete record has no blockers', () => {
    expect(outsourcingBlockers(COMPLETE)).toEqual([]);
  });
});
