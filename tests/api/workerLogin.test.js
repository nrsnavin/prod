'use strict';
// ══════════════════════════════════════════════════════════════════
//  WORKER LOGINS — registration is the admin's, sign-in is phone + PIN
//
//  Held here:
//    • only an admin can register a worker (create the employee record)
//      or give them a login;
//    • an employee's phone number stays unique, since it is what they
//      sign in with;
//    • the PIN rules (length, obvious PINs refused);
//    • phone + PIN signs a worker in, with the same session /login-user
//      gives, and works however the number is typed;
//    • wrong PINs lock the login, an admin reset lifts the lock and ends
//      the sessions already open;
//    • a manager login can never sign in, or be given a PIN, this way;
//    • the Users list never carries the PIN hash or a placeholder email.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, ALWAYS_ON;
let admin, supervisor, accounts, ravi, kumar, sup;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(url).set('Cookie', cookieFor(u)).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookieFor(u)).send(body),
  del: (url) => request(app).delete(url).set('Cookie', cookieFor(u)),
});
const signIn = (phone, pin, headers = {}) =>
  request(app).post('/api/v2/user/worker-login').set(headers).send({ phone, pin });
const access = (emp) => `/api/v2/user/manage/worker-access/${emp._id}`;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  Employee = require('../../models/Employee');
  ({ ALWAYS_ON } = require('../../utils/features'));

  admin = await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await User.create({ name: 'Floor', email: 'floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
  accounts = await User.create({ name: 'Books', email: 'books@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  ravi = await Employee.create({ name: 'Ravi', phoneNumber: '9100000001', department: 'weaving', role: 'operator' });
  kumar = await Employee.create({ name: 'Kumar', phoneNumber: '9100000002', department: 'packing', role: 'packer' });
  sup = await Employee.create({ name: 'Floor', phoneNumber: '9100000003', department: 'weaving', role: 'supervisor' });
  // The supervisor's own login is linked to their employee record.
  await User.updateOne({ _id: supervisor._id }, { employee: sup._id });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('registering a worker', () => {
  const body = { name: 'New Hand', department: 'weaving', phoneNumber: '9100000099' };

  it('is refused to a supervisor and to accounts', async () => {
    for (const u of [supervisor, accounts]) {
      const res = await as(u).post('/api/v2/employee/create-employee', body);
      expect(res.status).toBe(403);
    }
    expect(await Employee.exists({ phoneNumber: '9100000099' })).toBeNull();
  });

  it('is open to an admin', async () => {
    const res = await as(admin).post('/api/v2/employee/create-employee', body);
    expect(res.status).toBe(201);
    expect(res.body.employee.name).toBe('New Hand');
  });

  it('still lets a supervisor correct a record', async () => {
    const res = await as(supervisor).put(`/api/v2/employee/update?id=${ravi._id}`, { role: 'senior operator' });
    expect(res.status).toBe(200);
  });

  it('keeps phone numbers unique when one is edited', async () => {
    const res = await as(admin).put(`/api/v2/employee/update?id=${ravi._id}`, { phoneNumber: '9100000002' });
    expect(res.status).toBe(409);
    expect((await Employee.findById(ravi._id)).phoneNumber).toBe('9100000001');
  });

  it('still clears a phone number when asked', async () => {
    const e = await Employee.create({ name: 'Temp', phoneNumber: '9100000098', department: 'weaving' });
    const res = await as(admin).put(`/api/v2/employee/update?id=${e._id}`, { phoneNumber: '' });
    expect(res.status).toBe(200);
    expect((await Employee.findById(e._id)).phoneNumber).toBe('');
  });
});

describe('giving a worker phone sign-in', () => {
  it('is refused to anyone but an admin', async () => {
    const res = await as(supervisor).post(access(ravi), { pin: '4826' });
    expect(res.status).toBe(403);
  });

  it.each([
    ['12', /4 to 6 digits/],
    ['12a4', /4 to 6 digits/],
    ['1111', /one digit repeated/],
    ['1234', /run of digits/],
    ['9876', /run of digits/],
    ['0001', /end of the phone/],
  ])('refuses the PIN %s', async (pin, why) => {
    const res = await as(admin).post(access(ravi), { pin });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(why);
  });

  it('needs a phone number on the record', async () => {
    const e = await Employee.create({ name: 'No Phone', department: 'weaving' });
    const res = await as(admin).post(access(e), { pin: '4826' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/phone number/);
  });

  it('creates a worker login: self-service, linked, no usable email', async () => {
    const res = await as(admin).post(access(ravi), { pin: '4826' });
    expect(res.status).toBe(201);
    expect(res.body.login).toMatchObject({ selfService: true, phoneSignIn: true, email: null });
    const u = await User.findOne({ employee: ravi._id }).select('+pin');
    expect(u.features).toEqual(ALWAYS_ON);
    expect(u.department).toBe('production');
    expect(u.pin).not.toBe('4826'); // hashed
  });

  it('gives a packer a packing login', async () => {
    await as(admin).post(access(kumar), { pin: '5937' });
    expect((await User.findOne({ employee: kumar._id })).department).toBe('packing');
  });

  it('refuses a PIN for an employee whose login is a manager login', async () => {
    const res = await as(admin).post(access(sup), { pin: '4826' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/manager login/);
    expect(await User.findById(supervisor._id).select('+pin').then((u) => u.pin)).toBeUndefined();
  });

  it('reports what the worker has', async () => {
    const res = await as(admin).get(access(ravi));
    expect(res.status).toBe(200);
    expect(res.body.employee).toMatchObject({ name: 'Ravi', phoneNumber: '9100000001' });
    expect(res.body.login).toMatchObject({ phoneSignIn: true, lockedUntil: null });
  });
});

describe('signing in with phone and PIN', () => {
  it('signs a worker in, with the session /login-user gives', async () => {
    const res = await signIn('9100000001', '4826');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'Ravi', selfService: true, employee: String(ravi._id) });
    expect(res.headers['set-cookie'].join(';')).toMatch(/token=/);
    const me = await request(app).get('/api/v2/me/profile').set('Cookie', `token=${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.profile.name).toBe('Ravi');
  });

  it.each(['+91 91000 00001', '091000-00001', '91000 00001'])('understands the number typed as %s', async (phone) => {
    expect((await signIn(phone, '4826')).status).toBe(201);
  });

  it('gives the app its long session', async () => {
    const res = await signIn('9100000001', '4826', { 'X-Client': 'mobile' });
    expect(jwt.decode(res.body.token).exp - jwt.decode(res.body.token).iat).toBe(90 * 24 * 3600);
  });

  it('answers a wrong PIN and an unknown phone the same way', async () => {
    const a = await signIn('9100000001', '4827');
    const b = await signIn('9199999999', '4827');
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
    await User.updateOne({ employee: ravi._id }, { pinAttempts: 0 });
  });

  it('never signs in a manager login, even one with a PIN', async () => {
    // Planted directly: the routes never give a manager login a PIN.
    const { hashPassword } = require('../../utils/passwordHash');
    await User.updateOne({ _id: supervisor._id }, { pin: await hashPassword('4826') });
    expect((await signIn('9100000003', '4826')).status).toBe(401);
    await User.updateOne({ _id: supervisor._id }, { $unset: { pin: 1 } });
  });

  it('locks after five wrong PINs, warning before it does', async () => {
    let res;
    for (let i = 0; i < 4; i++) res = await signIn('9100000002', '0000');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/1 try left/);
    res = await signIn('9100000002', '0000');
    expect(res.status).toBe(429);
    // Locked means locked: the right PIN does not get through either.
    res = await signIn('9100000002', '5937');
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/Try again in \d+ minute/);
  });

  it('is unlocked by an admin reset, which ends the old sessions', async () => {
    const before = await User.findOne({ employee: kumar._id });
    const res = await as(admin).post(access(kumar), { pin: '6048' });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect((await signIn('9100000002', '6048')).status).toBe(201);
    // A token from before the reset no longer opens anything.
    const stale = await request(app).get('/api/v2/me/profile').set('Cookie', cookieFor(before));
    expect(stale.status).toBe(401);
  });

  it('stops working when an admin turns phone sign-in off', async () => {
    const res = await as(admin).del(access(kumar));
    expect(res.status).toBe(200);
    expect(res.body.login.phoneSignIn).toBe(false);
    expect((await signIn('9100000002', '6048')).status).toBe(401);
  });
});

describe('the Users screen', () => {
  it('lists phone sign-in, never the hash or the placeholder email', async () => {
    const res = await as(admin).get('/api/v2/user/manage/list');
    const row = res.body.users.find((u) => String(u.employee?._id) === String(ravi._id));
    expect(row).toMatchObject({ phoneSignIn: true, email: null, selfService: true });
    expect(JSON.stringify(res.body)).not.toMatch(/\$scrypt|workers\.invalid/);
  });

  it('drops the PIN when a worker login is given manager screens', async () => {
    const u = await User.findOne({ employee: ravi._id });
    const res = await as(admin).put(`/api/v2/user/manage/${u._id}`, { features: ['/jobs'] });
    expect(res.status).toBe(200);
    expect(res.body.user.selfService).toBe(false);
    expect((await User.findById(u._id).select('+pin')).pin).toBeUndefined();
    expect((await signIn('9100000001', '4826')).status).toBe(401);
  });
});
