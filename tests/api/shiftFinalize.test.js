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

// ══════════════════════════════════════════════════════════════════
//  Finalising while the plan is changing.
//
//  Finalise read the plan, counted the unverified entries, and saved.
//  A loom added in between — the floor scanning one the plan left out —
//  ended up, unverified, on a finalised shift. The lock is now a write
//  made only while the plan is unlocked, and adding or changing an entry
//  writes to the plan too, so the two collide in the database.
// ══════════════════════════════════════════════════════════════════
describe('finalising while the plan is changing', () => {
  const DAY = 86_400_000;
  let n = 0;
  const finalize = (id) => request(app).post(`/api/v2/shift/finalize-plan/${id}`).set('Cookie', cookie);
  const unfinalize = (id) => request(app).post(`/api/v2/shift/unfinalize-plan/${id}`).set('Cookie', cookie);

  /** A plan of its own day, with its one entry verified. */
  async function verifiedPlan() {
    const date = new Date(Date.UTC(2031, 0, 1) + (n++) * DAY);
    const { insertedId: id } = await ShiftPlan.collection.insertOne({ date, shift: 'DAY', totalProduction: 100, status: 'confirmed', plan: [] });
    const { insertedId: entry } = await ShiftDetail.collection.insertOne({
      date, shift: 'DAY', status: 'closed', productionMeters: 100, shiftPlan: id, timer: '10:00:00',
    });
    await ShiftPlan.collection.updateOne({ _id: id }, { $set: { plan: [entry] } });
    return id;
  }

  test('a loom added while it is being finalised is never left, unverified, on a finalised shift', async () => {
    const { addMachineToPlan } = require('../../services/shiftPlanCreate');
    const Machine = require('../../models/Machine.js');
    const outcomes = new Set();

    for (let round = 0; round < 10; round++) {
      const planId = await verifiedPlan();
      const { insertedId: machine } = await Machine.collection.insertOne({ ID: `RACE-${round}`, status: 'free', elastics: [] });
      const operator = new mongoose.Types.ObjectId();

      const [fin, added] = await Promise.all([
        finalize(planId),
        addMachineToPlan(planId, { machine, operator }).then(() => 'added', (e) => e.statusCode || String(e)),
      ]);

      const fresh = await ShiftPlan.findById(planId).lean();
      const unverified = await ShiftDetail.countDocuments({ _id: { $in: fresh.plan }, status: { $nin: ['closed', 'loading'] } });
      // The thing that must never be: locked, with an entry nobody verified.
      expect(Boolean(fresh.finalized) && unverified > 0).toBe(false);
      // And each was answered by what the other did.
      if (fin.status === 200) {
        expect(added).toBe(409);
        expect(fresh.plan).toHaveLength(1);
        // Nothing half-added either: no entry left pointing at the plan.
        expect(await ShiftDetail.countDocuments({ shiftPlan: planId })).toBe(1);
      } else {
        expect([fin.status, added]).toEqual([400, 'added']);
        expect(fin.body.message).toMatch(/1 entry is not verified/);
        expect(fresh.finalized).toBeFalsy();
        expect(fresh.plan).toHaveLength(2);
      }
      outcomes.add(fin.status);
    }
    expect([...outcomes].every((s) => s === 200 || s === 400)).toBe(true);
  }, 120_000);

  test('finalised by two people at once: one does, the other is told it already is', async () => {
    const planId = await verifiedPlan();
    const both = await Promise.all([finalize(planId), finalize(planId)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(both.find((r) => r.status === 400).body.message).toBe('Shift is already finalised');
    expect((await ShiftPlan.findById(planId).lean()).finalized).toBe(true);
  });

  test('a loom cannot be added once it is finalised, and can again when it is reopened', async () => {
    const { addMachineToPlan } = require('../../services/shiftPlanCreate');
    const Machine = require('../../models/Machine.js');
    const planId = await verifiedPlan();
    const { insertedId: machine } = await Machine.collection.insertOne({ ID: 'LATE-1', status: 'free', elastics: [] });
    const operator = new mongoose.Types.ObjectId();

    expect((await finalize(planId)).status).toBe(200);
    await expect(addMachineToPlan(planId, { machine, operator })).rejects.toMatchObject({ statusCode: 409 });
    expect((await unfinalize(planId)).status).toBe(200);
    const detail = await addMachineToPlan(planId, { machine, operator });
    expect((await ShiftPlan.findById(planId).lean()).plan.map(String)).toContain(String(detail._id));
    // …and with an entry now unverified, it will not finalise.
    expect((await finalize(planId)).status).toBe(400);
  });

  test('reopening says when there is nothing to reopen', async () => {
    const planId = await verifiedPlan();
    const notLocked = await unfinalize(planId);
    expect([notLocked.status, notLocked.body.message]).toEqual([400, 'Shift is not finalised']);
    expect((await unfinalize(new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await finalize(new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await finalize('nope')).status).toBe(400);
  });

  test('a plan with nothing on it has nothing to finalise', async () => {
    const { insertedId: empty } = await ShiftPlan.collection.insertOne({ date: new Date(Date.UTC(2032, 0, 1)), shift: 'NIGHT', plan: [] });
    const res = await finalize(empty);
    expect([res.status, res.body.message]).toEqual([400, 'Nothing to finalise — the shift has no production entries']);
  });
});
