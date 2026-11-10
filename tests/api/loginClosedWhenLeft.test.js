'use strict';
// ══════════════════════════════════════════════════════════════════
//  A LOGIN WHOSE PERSON HAS LEFT
//
//  Offboarding closed a worker's phone sign-in and nothing else. A
//  supervisor's login went on working, a worker who had put an email on
//  theirs could still be sent a code, and a phone that was already signed
//  in stayed signed in for its ninety days. Held here:
//
//    • from the day after the last working day, a login linked to that
//      employee can neither sign in nor use a session it already has;
//    • on the last working day itself it still works;
//    • reinstating them, or unlinking the login, opens it again with
//      nothing else to undo;
//    • an administrator's login is never closed this way — recording
//      that the owner "left" must not lock the owner out.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, factoryToday, ALWAYS_ON, admin, adminToken;

const dayKey = (offset) => {
  const d = new Date(`${factoryToday()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const signIn = (email, password = 'pass1234') => request(app).post('/api/v2/user/login-user').send({ email, password });
const me = (token) => request(app).get('/api/v2/user/me').set('Cookie', [`token=${token}`]);
const asAdmin = (method, url, body) => request(app)[method](url).set('Cookie', [`token=${adminToken}`]).send(body);
const offboard = (emp, lastWorkingDay) => asAdmin('post', `/api/v2/employee/${emp._id}/offboard`, { lastWorkingDay, reason: 'resigned' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Employee = require('../../models/Employee.js');
  ({ factoryToday } = require('../../utils/employeeStatus'));
  ({ ALWAYS_ON } = require('../../utils/features'));
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  await User.deleteMany({});
  await Employee.deleteMany({});
  admin = await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  adminToken = (await signIn('own@t.co')).body.token;
});

async function supervisor() {
  const emp = await Employee.create({ name: 'Kumar', phoneNumber: '9100000011', department: 'weaving', role: 'supervisor' });
  const login = await User.create({
    name: 'Kumar', email: 'kumar@t.co', password: 'pass1234', role: 'production', department: 'production', employee: emp._id,
  });
  return { emp, login };
}

describe('a supervisor who has left', () => {
  it('cannot sign in, and the session they already had ends', async () => {
    const { emp } = await supervisor();
    const before = (await signIn('kumar@t.co')).body.token;
    expect((await me(before)).status).toBe(200);

    const res = await offboard(emp, dayKey(-1));
    expect(res.status).toBe(200);
    // Told to the admin: this login stops by itself.
    expect(res.body.managerLogin).toMatchObject({ email: 'kumar@t.co', staysOpen: false });

    const stale = await me(before);
    expect(stale.status).toBe(401);
    expect(stale.body.message).toMatch(/login is closed/i);

    const again = await signIn('kumar@t.co');
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('LOGIN_CLOSED');
    expect(again.body.token).toBeUndefined();
  });

  it('cannot sign in with an emailed code either', async () => {
    const { emp, login } = await supervisor();
    await offboard(emp, dayKey(-1));
    const u = await User.findById(login._id);
    const code = u.createLoginOtp();
    await u.save({ validateBeforeSave: false });
    const res = await request(app).post('/api/v2/user/verify-otp').send({ email: 'kumar@t.co', otp: code });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('LOGIN_CLOSED');
  });

  it('still works through their last working day', async () => {
    const { emp } = await supervisor();
    const before = (await signIn('kumar@t.co')).body.token;
    expect((await offboard(emp, dayKey(0))).status).toBe(200);
    expect((await me(before)).status).toBe(200);
    expect((await signIn('kumar@t.co')).status).toBe(201);
  });

  it('works again once reinstated', async () => {
    const { emp } = await supervisor();
    const before = (await signIn('kumar@t.co')).body.token;
    await offboard(emp, dayKey(-3));
    expect((await me(before)).status).toBe(401);

    expect((await asAdmin('post', `/api/v2/employee/${emp._id}/reinstate`, {})).status).toBe(200);
    expect((await me(before)).status).toBe(200);
    expect((await signIn('kumar@t.co')).status).toBe(201);
  });

  it('works again once the login is no longer tied to that employee', async () => {
    const { emp, login } = await supervisor();
    await offboard(emp, dayKey(-3));
    expect((await signIn('kumar@t.co')).status).toBe(403);
    const res = await asAdmin('put', `/api/v2/user/manage/${login._id}`, { employee: '' });
    expect(res.status).toBe(200);
    expect((await signIn('kumar@t.co')).status).toBe(201);
  });
});

describe('a worker who has left', () => {
  it('cannot come back in by adding an email to the login first', async () => {
    const emp = await Employee.create({ name: 'Ravi', phoneNumber: '9100000012', department: 'weaving', role: 'operator' });
    const login = await User.create({
      name: 'Ravi', email: 'ravi@t.co', password: 'pass1234', role: 'production', department: 'production',
      employee: emp._id, features: ALWAYS_ON,
    });
    const before = (await signIn('ravi@t.co')).body.token;
    const res = await offboard(emp, dayKey(-1));
    expect(res.body.workerLoginClosed).toBe(true);

    expect((await me(before)).status).toBe(401);
    expect((await signIn('ravi@t.co')).status).toBe(403);
    const u = await User.findById(login._id);
    const code = u.createLoginOtp();
    await u.save({ validateBeforeSave: false });
    expect((await request(app).post('/api/v2/user/verify-otp').send({ email: 'ravi@t.co', otp: code })).status).toBe(403);
  });
});

describe('an administrator', () => {
  it('is never locked out by an offboarding entry', async () => {
    const emp = await Employee.create({ name: 'Owner', phoneNumber: '9100000013', department: 'admin', role: 'manager' });
    await User.updateOne({ _id: admin._id }, { employee: emp._id });

    const res = await offboard(emp, dayKey(-10));
    expect(res.status).toBe(200);
    // Told to the admin: this one does NOT stop by itself.
    expect(res.body.managerLogin).toMatchObject({ email: 'own@t.co', staysOpen: true });

    expect((await me(adminToken)).status).toBe(200);
    expect((await signIn('own@t.co')).status).toBe(201);
  });
});

describe('CONTROL', () => {
  it('a login with no employee, or one whose employee is still here, is untouched', async () => {
    await User.create({ name: 'Books', email: 'books@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
    expect((await signIn('books@t.co')).status).toBe(201);
    await supervisor();
    expect((await signIn('kumar@t.co')).status).toBe(201);
  });

  it('a login pointing at an employee record that no longer exists is not closed', async () => {
    await User.create({
      name: 'Orphan', email: 'orphan@t.co', password: 'pass1234', role: 'production', department: 'production',
      employee: new mongoose.Types.ObjectId(),
    });
    expect((await signIn('orphan@t.co')).status).toBe(201);
  });
});
