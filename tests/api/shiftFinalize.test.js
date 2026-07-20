'use strict';
// Finalise-shift lifecycle: finalize requires every entry verified,
// a finalised plan rejects corrections/deletions, and unfinalize
// reopens it. Runs through the real app (needs a replset — the
// correction path uses transactions).

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let rs, app, User, ShiftPlan, ShiftDetail, admin, cookie, plan, closedShift, pendingShift;

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  ShiftPlan = require('../../models/ShiftPlan.js');
  ShiftDetail = require('../../models/ShiftDetail.js');

  admin = await User.create({ name: 'Admin', email: 'a@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  cookie = [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

  const planDoc = await ShiftPlan.collection.insertOne({
    date: new Date(), shift: 'DAY', totalProduction: 800, status: 'confirmed', plan: [],
  });
  plan = planDoc.insertedId;

  const cs = await ShiftDetail.collection.insertOne({
    date: new Date(), shift: 'DAY', status: 'closed', productionMeters: 800, shiftPlan: plan, timer: '10:00:00',
  });
  closedShift = cs.insertedId;
  const ps = await ShiftDetail.collection.insertOne({
    date: new Date(), shift: 'DAY', status: 'pending_verification', productionMeters: 0, shiftPlan: plan, timer: '00:00:00',
  });
  pendingShift = ps.insertedId;
  await ShiftPlan.collection.updateOne({ _id: plan }, { $set: { plan: [closedShift, pendingShift] } });
}, 90_000);

afterAll(async () => {
  await mongoose.disconnect();
  await rs.stop();
});

describe('POST /shift/finalize-plan/:id', () => {
  test('refuses while an entry is still unverified', async () => {
    const res = await request(app).post(`/api/v2/shift/finalize-plan/${plan}`).set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not verified/i);
  });

  test('finalises once every entry is verified', async () => {
    await ShiftDetail.collection.updateOne({ _id: pendingShift }, { $set: { status: 'closed', productionMeters: 200 } });
    const res = await request(app).post(`/api/v2/shift/finalize-plan/${plan}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.finalized).toBe(true);
    const fresh = await ShiftPlan.findById(plan).lean();
    expect(fresh.finalized).toBe(true);
    expect(fresh.finalizedBy).toBe('Admin');
  });

  test('a finalised plan rejects production corrections', async () => {
    const res = await request(app)
      .put(`/api/v2/shift/production-entry/${closedShift}`)
      .set('Cookie', cookie)
      .send({ productionMeters: 999, auditReason: 'trying to edit a locked shift' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/finalised/i);
    const fresh = await ShiftDetail.findById(closedShift).lean();
    expect(fresh.productionMeters).toBe(800); // unchanged
  });

  test('a finalised plan rejects entry deletion', async () => {
    const res = await request(app)
      .delete(`/api/v2/shift/production-entry/${closedShift}`)
      .set('Cookie', cookie)
      .send({ auditReason: 'trying to delete from a locked shift' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/finalised/i);
  });

  test('unfinalize lifts the lock', async () => {
    const un = await request(app).post(`/api/v2/shift/unfinalize-plan/${plan}`).set('Cookie', cookie);
    expect(un.status).toBe(200);
    expect(un.body.finalized).toBe(false);
    // The correction request now gets PAST the finalised lock. (This
    // seeded shift has no linked job order, so the pre-existing
    // re-derivation rule still 400s — but with ITS message, proving the
    // lock itself is lifted.)
    const res = await request(app)
      .put(`/api/v2/shift/production-entry/${closedShift}`)
      .set('Cookie', cookie)
      .send({ productionMeters: 750, auditReason: 'legit correction after reopen' });
    expect(res.body.message).not.toMatch(/finalised/i);
    expect(res.body.message).toMatch(/job order/i);
    const fresh = await ShiftPlan.findById(plan).lean();
    expect(fresh.finalized).toBe(false);
  });
});
