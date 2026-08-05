'use strict';
// End-to-end coverage for the Leave module.
//
// This module previously had NO test of any kind, which is how a
// router/model field mismatch (routes wrote `date`, the schema required
// `startDate`/`endDate`) shipped: every create returned 500 and the whole
// feature was dead, with a fully green suite. These tests exercise the
// real app so the request → approve → cancel path stays honest.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, Employee, LeaveRequest, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

const makeWorker = async (name, email) => {
  const emp = await Employee.create({ name, department: 'production', hourlyRate: 50 });
  const user = await User.create({
    name, email, password: 'pass1234', role: 'production',
    department: 'production', employee: emp._id, features: ['/jobs'],
  });
  return { emp, user };
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Employee = require('../../models/Employee.js');
  LeaveRequest = require('../../models/LeaveRequest.js');
  admin = await User.create({
    name: 'Owner', email: 'leave-owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  await LeaveRequest.syncIndexes();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await LeaveRequest.deleteMany({});
});

describe('a worker files their own leave', () => {
  test('POST /request persists and echoes the date it was filed for', async () => {
    const { emp, user } = await makeWorker('Filer', 'filer@t.co');

    const res = await request(app)
      .post('/api/v2/leave/request')
      .set('Cookie', cookie(user._id, 'production'))
      .send({ date: '2026-09-01', shift: 'DAY', leaveType: 'casual', reason: 'family function' });

    expect(res.status).toBe(201);
    expect(res.body.data.date).toBe('2026-09-01');
    expect(res.body.data.shift).toBe('DAY');
    expect(String(res.body.data.employeeId)).toBe(String(emp._id));

    // And it is actually in the database, under the field the routes read.
    const stored = await LeaveRequest.findById(res.body.data.id).lean();
    expect(stored).toBeTruthy();
    expect(stored.date).toBeInstanceOf(Date);
    expect(stored.status).toBe('pending');
  });

  test('the body employeeId cannot be used to file as somebody else', async () => {
    const { user } = await makeWorker('Spoofer', 'spoofer@t.co');
    const { emp: victim } = await makeWorker('Victim', 'victim@t.co');

    const res = await request(app)
      .post('/api/v2/leave/request')
      .set('Cookie', cookie(user._id, 'production'))
      .send({ employeeId: String(victim._id), date: '2026-09-02', leaveType: 'casual', reason: 'spoof' });

    expect(res.status).toBe(201);
    expect(String(res.body.data.employeeId)).not.toBe(String(victim._id));
  });

  test('the same date and shift cannot be requested twice', async () => {
    const { user } = await makeWorker('Dup', 'dup@t.co');
    const body = { date: '2026-09-03', shift: 'DAY', leaveType: 'sick', reason: 'fever' };

    const first = await request(app).post('/api/v2/leave/request')
      .set('Cookie', cookie(user._id, 'production')).send(body);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v2/leave/request')
      .set('Cookie', cookie(user._id, 'production')).send(body);
    expect(second.status).toBe(409);
  });

  test('an invalid date is rejected as a 400, not a 500', async () => {
    const { user } = await makeWorker('BadDate', 'baddate@t.co');
    const res = await request(app)
      .post('/api/v2/leave/request')
      .set('Cookie', cookie(user._id, 'production'))
      .send({ date: 'not-a-date', leaveType: 'casual', reason: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('admin raises and reviews leave', () => {
  test('POST /admin-request creates for another employee', async () => {
    const { emp } = await makeWorker('Target', 'target@t.co');
    const res = await request(app)
      .post('/api/v2/leave/admin-request')
      .set('Cookie', adminCookie())
      .send({ employeeId: String(emp._id), date: '2026-09-04', shift: 'BOTH', leaveType: 'unpaid', reason: 'personal' });

    expect(res.status).toBe(201);
    expect(String(res.body.data.employeeId)).toBe(String(emp._id));
    expect(res.body.data.date).toBe('2026-09-04');
  });

  test('approving records the reviewer note the HR page sends as `note`', async () => {
    const { emp } = await makeWorker('Approvee', 'approvee@t.co');
    const created = await request(app)
      .post('/api/v2/leave/admin-request')
      .set('Cookie', adminCookie())
      .send({ employeeId: String(emp._id), date: '2026-09-05', leaveType: 'casual', reason: 'wedding' });

    const res = await request(app)
      .put(`/api/v2/leave/${created.body.data.id}/approve`)
      .set('Cookie', adminCookie())
      .send({ note: 'approved by HR' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');

    const stored = await LeaveRequest.findById(created.body.data.id).lean();
    expect(stored.reviewNotes).toBe('approved by HR');
    expect(stored.reviewedAt).toBeTruthy();
  });

  test('rejecting records its note too', async () => {
    const { emp } = await makeWorker('Rejectee', 'rejectee@t.co');
    const created = await request(app)
      .post('/api/v2/leave/admin-request')
      .set('Cookie', adminCookie())
      .send({ employeeId: String(emp._id), date: '2026-09-06', leaveType: 'casual', reason: 'x' });

    const res = await request(app)
      .put(`/api/v2/leave/${created.body.data.id}/reject`)
      .set('Cookie', adminCookie())
      .send({ note: 'peak season' });

    expect(res.status).toBe(200);
    const stored = await LeaveRequest.findById(created.body.data.id).lean();
    expect(stored.status).toBe('rejected');
    expect(stored.reviewNotes).toBe('peak season');
  });

  test('GET /pending lists what was filed', async () => {
    const { emp } = await makeWorker('Pending', 'pending@t.co');
    await request(app).post('/api/v2/leave/admin-request').set('Cookie', adminCookie())
      .send({ employeeId: String(emp._id), date: '2026-09-07', leaveType: 'casual', reason: 'x' });

    const res = await request(app).get('/api/v2/leave/pending').set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].date).toBe('2026-09-07');
  });
});

// The defect: DELETE is exempt from the feature gate (cancelling is
// self-service), and had no ownership test — so any logged-in worker
// could delete any colleague's pending request by id.
describe('cancelling a leave request is restricted to its owner', () => {
  test('a worker CANNOT cancel a colleague\'s request', async () => {
    const { user: attacker } = await makeWorker('Attacker', 'attacker@t.co');
    const { emp: victimEmp } = await makeWorker('Victim2', 'victim2@t.co');

    const victimLeave = await LeaveRequest.create({
      employee: victimEmp._id, date: new Date('2026-09-08'), shift: 'DAY',
      leaveType: 'casual', reason: 'theirs', status: 'pending',
    });

    const res = await request(app)
      .delete(`/api/v2/leave/${victimLeave._id}`)
      .set('Cookie', cookie(attacker._id, 'production'));

    expect(res.status).toBe(403);
    expect(await LeaveRequest.findById(victimLeave._id)).not.toBeNull();
  });

  test('a worker CAN cancel their own request', async () => {
    const { emp, user } = await makeWorker('SelfCancel', 'selfcancel@t.co');
    const own = await LeaveRequest.create({
      employee: emp._id, date: new Date('2026-09-09'), shift: 'DAY',
      leaveType: 'casual', reason: 'mine', status: 'pending',
    });

    const res = await request(app)
      .delete(`/api/v2/leave/${own._id}`)
      .set('Cookie', cookie(user._id, 'production'));

    expect(res.status).toBe(200);
    expect(await LeaveRequest.findById(own._id)).toBeNull();
  });

  test('an admin can cancel anyone\'s request', async () => {
    const { emp } = await makeWorker('AdminCancel', 'admincancel@t.co');
    const row = await LeaveRequest.create({
      employee: emp._id, date: new Date('2026-09-10'), shift: 'DAY',
      leaveType: 'casual', reason: 'x', status: 'pending',
    });

    const res = await request(app)
      .delete(`/api/v2/leave/${row._id}`)
      .set('Cookie', adminCookie());
    expect(res.status).toBe(200);
  });
});

describe('GET /conflicts', () => {
  test('matches an approved leave against an open shift on the same day', async () => {
    const { emp } = await makeWorker('Clash', 'clash@t.co');
    const ShiftDetail = require('../../models/ShiftDetail.js');
    const day = new Date('2026-09-11'); day.setHours(0, 0, 0, 0);

    await LeaveRequest.create({
      employee: emp._id, date: day, shift: 'DAY',
      leaveType: 'casual', reason: 'x', status: 'approved',
    });
    await ShiftDetail.create({
      employee: emp._id, date: day, shift: 'DAY', status: 'open',
      // Required refs; /conflicts never dereferences them.
      machine: new mongoose.Types.ObjectId(),
      shiftPlan: new mongoose.Types.ObjectId(),
    });

    const res = await request(app).get('/api/v2/leave/conflicts').set('Cookie', adminCookie());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(String(res.body.conflicts[0].employeeId)).toBe(String(emp._id));
  });
});
