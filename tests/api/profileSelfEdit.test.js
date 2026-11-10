'use strict';
// ══════════════════════════════════════════════════════════════════
//  EDITING YOUR OWN PROFILE  (PATCH /user/me — the employee app's sheet)
//
//  The phone number on an employee's record is what a worker signs in
//  with, and the email on a login is where its sign-in code goes. Both
//  could be set to anything. Held here:
//
//    • a phone number must be a 10-digit number, is stored as one
//      however it was typed, and cannot be another employee's;
//    • a number that has not changed is left exactly as it is, so an old
//      record's odd number does not block fixing a name;
//    • a worker who signs in by phone cannot blank their number;
//    • a blank email is "no change" (a worker has none to type), and a
//      changed one is recorded like any other change to a login.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, AccessEvent, ALWAYS_ON;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Employee = require('../../models/Employee.js');
  AccessEvent = require('../../models/AccessEvent.js');
  ({ ALWAYS_ON } = require('../../utils/features'));
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let ravi, raviLogin, token;
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Employee.deleteMany({}), AccessEvent.deleteMany({})]);
  ravi = await Employee.create({ name: 'Ravi', phoneNumber: '9100000001', department: 'weaving', role: 'operator' });
  await Employee.create({ name: 'Mani', phoneNumber: '9100000002', department: 'weaving', role: 'operator' });
  raviLogin = await User.create({
    name: 'Ravi', email: 'worker-x@workers.invalid', password: 'pass1234', role: 'production', department: 'production',
    employee: ravi._id, features: ALWAYS_ON,
  });
  token = (await request(app).post('/api/v2/user/login-user').send({ email: 'worker-x@workers.invalid', password: 'pass1234' })).body.token;
});

const save = (body, t = token) => request(app).patch('/api/v2/user/me').set('Cookie', [`token=${t}`]).send(body);
const phoneOf = async (emp = ravi) => (await Employee.findById(emp._id).lean()).phoneNumber;

describe('the phone number', () => {
  it('is stored as ten digits however it was typed', async () => {
    const res = await save({ name: 'Ravi', email: '', phoneNumber: '+91 91000 00077' });
    expect(res.status).toBe(200);
    expect(await phoneOf()).toBe('9100000077');
    expect(res.body.user.employee.phoneNumber).toBe('9100000077');
  });

  it('cannot be a colleague\'s', async () => {
    const res = await save({ name: 'Ravi', phoneNumber: '91000 00002' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/another employee/);
    expect(await phoneOf()).toBe('9100000001');
  });

  it('has to be a phone number', async () => {
    for (const bad of ['12345', 'call me', '99999999999999']) {
      const res = await save({ name: 'Ravi', phoneNumber: bad });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/10-digit/);
    }
    expect(await phoneOf()).toBe('9100000001');
  });

  it('is left alone when it has not changed, whatever shape it has', async () => {
    // An old record: not ten digits, and shared with somebody else.
    await Employee.updateOne({ _id: ravi._id }, { phoneNumber: '0422-2345' });
    const res = await save({ name: 'Ravi Kumar', email: '', phoneNumber: '0422-2345' });
    expect(res.status).toBe(200);
    expect(await phoneOf()).toBe('0422-2345');
    expect((await Employee.findById(ravi._id).lean()).name).toBe('Ravi Kumar');
  });

  it('cannot be blanked by someone who signs in with it', async () => {
    await User.updateOne({ _id: raviLogin._id }, { pin: 'hashed-pin' });
    const res = await save({ name: 'Ravi', phoneNumber: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/how you sign in/);
    expect(await phoneOf()).toBe('9100000001');
  });

  it('CONTROL: a login with no employee record sends one and nothing breaks', async () => {
    await User.create({ name: 'Books', email: 'books@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
    const t = (await request(app).post('/api/v2/user/login-user').send({ email: 'books@t.co', password: 'pass1234' })).body.token;
    const res = await save({ name: 'Books Dept', email: 'books@t.co', phoneNumber: 'not a number' }, t);
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Books Dept');
  });
});

describe('the email', () => {
  it('left blank changes nothing — a worker has none to type', async () => {
    const res = await save({ name: 'Ravi K', email: '', phoneNumber: '9100000001' });
    expect(res.status).toBe(200);
    expect((await User.findById(raviLogin._id).lean()).email).toBe('worker-x@workers.invalid');
    expect(await AccessEvent.countDocuments({})).toBe(0);
  });

  it('changed is on the record, with who it was', async () => {
    const res = await save({ name: 'Ravi', email: 'Ravi@Example.com', phoneNumber: '9100000001' });
    expect(res.status).toBe(200);
    expect((await User.findById(raviLogin._id).lean()).email).toBe('ravi@example.com');
    const ev = await AccessEvent.findOne({ 'subject.id': String(raviLogin._id) }).lean();
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev)).toMatch(/ravi@example\.com/);
    expect(JSON.stringify(ev)).toMatch(/own profile/);
  });

  it('cannot be somebody else\'s, or not an address', async () => {
    await User.create({ name: 'Books', email: 'books@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
    expect((await save({ name: 'Ravi', email: 'books@t.co' })).status).toBe(409);
    expect((await save({ name: 'Ravi', email: 'not-an-address' })).status).toBe(400);
  });
});
