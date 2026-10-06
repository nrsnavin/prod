'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PRODUCTION ENTRY CANNOT REOPEN A VERIFIED SHIFT
//
//  The race: an entry route reads the shift while it is still open, a
//  supervisor verifies it (status → closed, metres cascaded into the
//  job), and then the entry route writes. Read-then-save wrote status
//  back to "pending_verification", and verifying it again counted the
//  metres a second time.
//
//  Each test reproduces exactly that interleaving: the route's read is
//  served the stale open shift while the database already holds the
//  closed one. The entry must be refused and the shift stay closed.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, ShiftDetail, admin, worker, emp;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (u, url, body) => request(app).post(url).set('Cookie', cookie(u)).send(body);

/** A query that resolves to a fixed (stale) document, however it is chained. */
function staleQuery(doc) {
  const q = {
    select: () => q, lean: () => q, populate: () => q, session: () => q,
    exec: () => Promise.resolve(doc),
    then: (ok, fail) => Promise.resolve(doc).then(ok, fail),
  };
  return q;
}

/**
 * A shift that is closed in the database, while the next read of it by
 * the route returns the open snapshot taken just before it was verified.
 */
async function verifiedJustAfterRead(method) {
  const shift = await ShiftDetail.create({
    date: new Date(), shift: 'DAY', status: 'open', employee: emp._id,
    shiftPlan: new mongoose.Types.ObjectId(), machine: new mongoose.Types.ObjectId(),
  });
  const snapshot = shift.toObject();
  await ShiftDetail.updateOne({ _id: shift._id }, { $set: { status: 'closed', productionMeters: 400 } });
  jest.spyOn(ShiftDetail, method).mockImplementationOnce(() =>
    staleQuery(ShiftDetail.hydrate(snapshot))
  );
  return shift._id;
}

const statusOf = async (id) => (await ShiftDetail.findById(id).lean()).status;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const Employee = require('../../models/Employee');
  ShiftDetail = require('../../models/ShiftDetail');
  const { ALWAYS_ON } = require('../../utils/features');
  emp = await Employee.create({ name: 'Ravi', department: 'weaving' });
  admin = await User.create({ name: 'Admin', email: 'a@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  worker = await User.create({
    name: 'Ravi', email: 'r@t.co', password: 'pass1234', role: 'production', department: 'production',
    features: [...ALWAYS_ON], employee: emp._id,
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => jest.restoreAllMocks());

describe('a shift verified between an entry\'s read and its write', () => {
  it('stays closed: supervisor entry', async () => {
    const id = await verifiedJustAfterRead('findById');
    const res = await post(admin, '/api/v2/shift/enter-shift-production', { id: String(id), production: 300 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already closed/);
    expect(await statusOf(id)).toBe('closed');
  });

  it('stays closed: supervisor update', async () => {
    const id = await verifiedJustAfterRead('findById');
    const res = await post(admin, '/api/v2/shift/update', { shiftId: String(id), production: 300 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/verified and closed meanwhile/);
    expect(await statusOf(id)).toBe('closed');
  });

  it('stays closed: bulk sheet upload, which skips it', async () => {
    const id = await verifiedJustAfterRead('findById');
    const res = await post(admin, '/api/v2/shift/bulk-enter-production', { entries: [{ id: String(id), production: 300 }] });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/Already closed/);
    expect(await statusOf(id)).toBe('closed');
  });

  it('stays closed: the worker\'s own entry', async () => {
    const id = await verifiedJustAfterRead('findOne');
    const res = await post(worker, `/api/v2/me/shifts/${id}/production`, { production: 300, timer: '7:30' });
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe('closed');
    expect((await ShiftDetail.findById(id).lean()).submittedProductionMeters).toBeUndefined();
  });
});

describe('an open shift', () => {
  it('still takes an entry, as before', async () => {
    const shift = await ShiftDetail.create({
      date: new Date(), shift: 'DAY', status: 'open', employee: emp._id,
      shiftPlan: new mongoose.Types.ObjectId(), machine: new mongoose.Types.ObjectId(),
    });
    const res = await post(worker, `/api/v2/me/shifts/${shift._id}/production`, { production: 300, timer: '7:30' });
    expect(res.status).toBe(200);
    expect(await ShiftDetail.findById(shift._id).lean()).toMatchObject({ status: 'pending_verification', submittedProductionMeters: 300 });
  });
});
