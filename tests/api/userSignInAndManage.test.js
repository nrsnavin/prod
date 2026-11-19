'use strict';
// ══════════════════════════════════════════════════════════════════
//  SIGNING IN, AND MANAGING LOGINS
//
//  Found reading api/user.js line by line.
//
//  1. A CAPITAL LETTER IN THE EMAIL FAILED THE PASSWORD SIGN-IN. Both
//     apps' password forms call /login-user, which looked the address up
//     exactly as typed; accounts are kept in lower case. "Navin@…" —
//     which is how a phone keyboard starts a line — was "Invalid email
//     or password", with the right password. The code sign-in and the
//     reset link have always matched whatever the case.
//
//  2. CREATING A LOGIN ANSWERED WITH ITS PASSWORD HASH. /sign-up sent
//     the stored record back as it was made, hash included.
//
//  3. A WORKER WHOSE NUMBER WAS KEPT WITH SPACES COULD BE GIVEN A PIN
//     AND NEVER SIGN IN. Giving a PIN read the number tolerantly
//     ("+91 98765 43210" is a number); signing in looks for the ten
//     digits exactly. The admin saw "phone sign-in is on"; the worker
//     saw "wrong phone number or PIN", for ever.
//
//  4. MOVING A LOGIN TO ANOTHER DEPARTMENT LEFT THE OLD DEPARTMENT'S
//     SCREENS ON ITS LIST when the list was not sent with the change:
//     shown as granted on the Users screen, refused at the door.
//
//  5. SAVING YOUR OWN PROFILE ANSWERED WITH A WORKER'S PLACEHOLDER
//     ADDRESS as their email — the one place it was not hidden.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, ALWAYS_ON, admin;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get:   (url)       => request(app).get(`/api/v2/user${url}`).set('Cookie', cookieFor(u)),
  post:  (url, body) => request(app).post(`/api/v2/user${url}`).set('Cookie', cookieFor(u)).send(body),
  put:   (url, body) => request(app).put(`/api/v2/user${url}`).set('Cookie', cookieFor(u)).send(body),
  patch: (url, body) => request(app).patch(`/api/v2/user${url}`).set('Cookie', cookieFor(u)).send(body),
});
const login = (email, password) => request(app).post('/api/v2/user/login-user').send({ email, password });
const workerLogin = (phone, pin) => request(app).post('/api/v2/user/worker-login').send({ phone, pin });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  Employee = require('../../models/Employee');
  ({ ALWAYS_ON } = require('../../utils/features'));
  admin = await User.create({ name: 'Owner', email: 'us-own@t.co', password: 'Loom-shed-2026', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  await User.deleteMany({ _id: { $ne: admin._id } });
  await Employee.deleteMany({});
});

let seq = 0;
const phoneNo = () => `96000${String(++seq).padStart(5, '0')}`;

// ══════════════════════════════════════════════════════════════════
describe('signing in with a password', () => {
  it('finds the account whatever the case the address is typed in', async () => {
    await User.create({ name: 'Navin', email: 'navin@baluelastics.test', password: 'Loom-shed-2026', role: 'production', department: 'production' });

    const typed = await login('Navin@BaluElastics.test', 'Loom-shed-2026');
    // Before: 401 "Invalid email or password".
    expect(typed.status).toBe(201);
    expect(typed.body.username).toBe('Navin');
    expect((await login('  navin@baluelastics.test ', 'Loom-shed-2026')).status).toBe(201);
  });

  it('still needs the right password, and says the same for a wrong address (unchanged)', async () => {
    await User.create({ name: 'Navin', email: 'navin@baluelastics.test', password: 'Loom-shed-2026', role: 'production', department: 'production' });
    const wrongPassword = await login('Navin@BaluElastics.test', 'not-the-password');
    const noAccount = await login('nobody@baluelastics.test', 'Loom-shed-2026');
    expect(wrongPassword.status).toBe(401);
    expect(noAccount.status).toBe(401);
    expect(wrongPassword.body.message).toBe(noAccount.body.message);
  });

  it('prefers the address exactly as typed when two accounts differ only by case', async () => {
    // From before addresses were kept in lower case.
    await User.collection.insertOne({ name: 'Old Mixed', email: 'Stores@BaluElastics.test', password: await require('../../utils/passwordHash').hashPassword('Mixed-case-2026'), role: 'production', department: 'production', createdAt: new Date() });
    await User.create({ name: 'New Lower', email: 'stores@baluelastics.test', password: 'Lower-case-2026', role: 'production', department: 'production' });

    expect((await login('Stores@BaluElastics.test', 'Mixed-case-2026')).body.username).toBe('Old Mixed');
    expect((await login('stores@baluelastics.test', 'Lower-case-2026')).body.username).toBe('New Lower');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('creating a login', () => {
  it('does not answer with the password, hashed or not', async () => {
    const res = await as(admin).post('/sign-up', { name: 'Stores Clerk', email: 'Clerk@BaluElastics.test', password: 'Loom-shed-2026', department: 'production' });
    expect(res.status).toBe(200);
    // Before: the stored record, hash and all.
    expect(res.body.user.password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$|\$argon2|scrypt/);
    expect(res.body.user).toMatchObject({ name: 'Stores Clerk', email: 'clerk@baluelastics.test', department: 'production', role: 'production' });
    expect(res.body.user._id || res.body.user.id).toBeTruthy();
    // And the login works.
    expect((await login('clerk@baluelastics.test', 'Loom-shed-2026')).status).toBe(201);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('giving a worker phone sign-in', () => {
  it('works for a number that was kept with spaces and a country code', async () => {
    // On file from before numbers were kept as ten digits.
    const { insertedId } = await Employee.collection.insertOne({ name: 'Ravi', phoneNumber: '+91 98765 43210', department: 'weaving', role: 'operator', status: 'active', createdAt: new Date(), updatedAt: new Date() });

    const set = await as(admin).post(`/manage/worker-access/${insertedId}`, { pin: '4827' });
    expect(set.status).toBe(201);
    expect(set.body.login.phoneSignIn).toBe(true);

    const signedIn = await workerLogin('98765 43210', '4827');
    // Before: 401 "Wrong phone number or PIN" — for ever.
    expect(signedIn.status).toBe(201);
    expect(signedIn.body.username).toBe('Ravi');
    // The number is kept as what they sign in with.
    expect((await Employee.findById(insertedId).lean()).phoneNumber).toBe('9876543210');
    expect(set.body.employee.phoneNumber).toBe('9876543210');
  });

  it('is refused when the same number, kept another way, is someone else\'s', async () => {
    await Employee.create({ name: 'Kumar', phoneNumber: '9876543210', department: 'weaving', role: 'operator' });
    const { insertedId } = await Employee.collection.insertOne({ name: 'Ravi', phoneNumber: '+91 98765 43210', department: 'weaving', role: 'operator', status: 'active', createdAt: new Date(), updatedAt: new Date() });

    const res = await as(admin).post(`/manage/worker-access/${insertedId}`, { pin: '4827' });
    // Before: 201 — two people, one number to sign in with.
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Kumar/);
    expect((await Employee.findById(insertedId).lean()).phoneNumber).toBe('+91 98765 43210');
  });

  it('works as before for a number kept as ten digits (unchanged)', async () => {
    const emp = await Employee.create({ name: 'Mani', phoneNumber: phoneNo(), department: 'weaving', role: 'operator' });
    expect((await as(admin).post(`/manage/worker-access/${emp._id}`, { pin: '4827' })).status).toBe(201);
    expect((await workerLogin(emp.phoneNumber, '4827')).status).toBe(201);
    expect((await workerLogin(emp.phoneNumber, '0000')).status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('moving a login to another department', () => {
  const create = async (department, features) => {
    const res = await as(admin).post('/manage/create', { name: 'Clerk', email: `clerk-${++seq}@baluelastics.test`, password: 'Loom-shed-2026', department, ...(features ? { features } : {}) });
    expect(res.status).toBe(201);
    return res.body.user;
  };

  it('does not leave the old department\'s screens on its list', async () => {
    const { featuresForDepartment } = require('../../utils/features');
    const accountsOnly = featuresForDepartment('finance').filter((k) => !featuresForDepartment('production').includes(k));
    const shared = featuresForDepartment('finance').filter((k) => featuresForDepartment('production').includes(k));
    expect(accountsOnly.length).toBeGreaterThan(0);

    const u = await create('finance');
    const res = await as(admin).put(`/manage/${u.id}`, { department: 'production' });       // the list is not sent
    expect(res.status).toBe(200);
    const kept = res.body.user.features;
    // Before: every finance screen still listed.
    for (const k of accountsOnly) expect(kept).not.toContain(k);
    for (const k of shared) expect(kept).toContain(k);
    expect(kept.length).toBeGreaterThan(0);
  });

  it('falls back to the new department\'s own screens when none carry over', async () => {
    const { featuresForDepartment } = require('../../utils/features');
    const financeOnly = featuresForDepartment('finance').filter((k) => !featuresForDepartment('production').includes(k));
    const u = await create('finance', financeOnly.slice(0, 1));
    const res = await as(admin).put(`/manage/${u.id}`, { department: 'production' });
    expect(res.status).toBe(200);
    // An empty list means "granted nothing": not what a change of department means.
    expect(res.body.user.features).toEqual(featuresForDepartment('production'));
  });

  it('takes the list that is sent with the change (unchanged)', async () => {
    const { featuresForDepartment } = require('../../utils/features');
    const u = await create('finance');
    const pick = featuresForDepartment('production').slice(0, 2);
    const res = await as(admin).put(`/manage/${u.id}`, { department: 'production', features: pick });
    expect(res.body.user.features).toEqual(pick);
  });

  it('leaves the list alone when the department does not change (unchanged)', async () => {
    const { featuresForDepartment } = require('../../utils/features');
    const pick = featuresForDepartment('production').slice(0, 2);
    const u = await create('production', pick);
    const res = await as(admin).put(`/manage/${u.id}`, { name: 'Renamed', department: 'production' });
    expect(res.body.user).toMatchObject({ name: 'Renamed', features: pick });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('saving your own profile', () => {
  it('answers as reading it does: a placeholder address is no address', async () => {
    const { placeholderEmail } = require('../../utils/workerLogin');
    const emp = await Employee.create({ name: 'Ravi', phoneNumber: phoneNo(), department: 'weaving', role: 'operator' });
    const worker = await User.create({ name: 'Ravi', email: placeholderEmail(emp._id), password: 'Loom-shed-2026', role: 'production', department: 'production', features: [...ALWAYS_ON], employee: emp._id });

    const saved = await as(worker).patch('/me', { name: 'Ravi K' });
    expect(saved.status).toBe(200);
    // Before: "worker-<id>@workers.invalid".
    expect(saved.body.user.email).toBeNull();
    expect(saved.body.user.name).toBe('Ravi K');
    const read = await as(worker).get('/me');
    expect(read.body.user.email).toBeNull();
    // The same things, in the same shape.
    expect(Object.keys(saved.body.user).sort()).toEqual(Object.keys(read.body.user).sort());
  });
});
