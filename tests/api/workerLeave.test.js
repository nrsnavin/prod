'use strict';
// ══════════════════════════════════════════════════════════════════
//  A WORKER'S OWN LEAVE — the routes the employee web view uses
//
//  An employee login (self-service only) can apply for leave for
//  themselves, see their own requests and cancel one that is still
//  pending — and nobody else's. Bad input is refused with 400, never a
//  500.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, LeaveRequest, ravi, kumar, raviEmp, kumarEmp;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie(u)),
  post: (url, body) => request(app).post(url).set('Cookie', cookie(u)).send(body),
  del: (url) => request(app).delete(url).set('Cookie', cookie(u)),
});
const apply = (u, over = {}) =>
  as(u).post('/api/v2/leave/request', { date: '2026-11-10', shift: 'BOTH', leaveType: 'casual', reason: 'Family function', ...over });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const Employee = require('../../models/Employee');
  LeaveRequest = require('../../models/LeaveRequest');
  // The duplicate check relies on the unique index; wait until it exists.
  await LeaveRequest.init();
  const { ALWAYS_ON } = require('../../utils/features');
  raviEmp = await Employee.create({ name: 'Ravi', department: 'weaving' });
  kumarEmp = await Employee.create({ name: 'Kumar', department: 'weaving' });
  const worker = (name, emp) => User.create({
    name, email: `${name.toLowerCase()}@t.co`, password: 'pass1234', role: 'production', department: 'production',
    features: [...ALWAYS_ON], employee: emp._id,
  });
  ravi = await worker('Ravi', raviEmp);
  kumar = await worker('Kumar', kumarEmp);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('applying', () => {
  it('records a request for the worker, pending', async () => {
    const res = await apply(ravi);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ shift: 'BOTH', leaveType: 'casual', status: 'pending', employeeName: 'Ravi' });
  });

  it('is always for the signed-in worker, whatever id is sent', async () => {
    const res = await apply(ravi, { date: '2026-11-11', employeeId: String(kumarEmp._id) });
    expect(res.status).toBe(201);
    expect(String(res.body.data.employeeId)).toBe(String(raviEmp._id));
    expect(await LeaveRequest.countDocuments({ employee: kumarEmp._id })).toBe(0);
  });

  it('accepts the shift in any case', async () => {
    const res = await apply(ravi, { date: '2026-11-12', shift: 'night' });
    expect(res.status).toBe(201);
    expect(res.body.data.shift).toBe('NIGHT');
  });

  it('says so when the day is already requested', async () => {
    const res = await apply(ravi);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/);
  });

  it.each([
    [{ shift: 5 }, /shift/],
    [{ shift: 'EVENING' }, /DAY, NIGHT or BOTH/],
    [{ leaveType: 'holiday' }, /casual, sick or unpaid/],
    [{ reason: 'x'.repeat(501) }, /reason is too long/],
  ])('refuses %o with 400, not a crash', async (over, why) => {
    const res = await apply(ravi, { date: '2026-11-20', ...over });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(why);
  });
});

describe('seeing and cancelling', () => {
  it('lists the worker\'s own requests, and refuses anyone else\'s', async () => {
    const own = await as(ravi).get(`/api/v2/leave/employee/${raviEmp._id}`);
    expect(own.status).toBe(200);
    expect(own.body.data.length).toBe(3);
    const other = await as(kumar).get(`/api/v2/leave/employee/${raviEmp._id}`);
    expect(other.status).toBe(403);
  });

  it('cancels the worker\'s own pending request, never a colleague\'s', async () => {
    const leave = await LeaveRequest.findOne({ employee: raviEmp._id, shift: 'NIGHT' });
    expect((await as(kumar).del(`/api/v2/leave/${leave._id}`)).status).toBe(403);
    expect((await as(ravi).del(`/api/v2/leave/${leave._id}`)).status).toBe(200);
    expect(await LeaveRequest.exists({ _id: leave._id })).toBeNull();
  });

  it('cannot cancel a request already decided', async () => {
    const leave = await LeaveRequest.findOne({ employee: raviEmp._id });
    leave.status = 'approved';
    await leave.save();
    const res = await as(ravi).del(`/api/v2/leave/${leave._id}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only pending/);
  });
});
