'use strict';
// ══════════════════════════════════════════════════════════════════
//  CHECKED AT THE DOOR — middleware/validate.js on real routes
//
//    • a wrong type or an oversized value is refused with 400 and
//      INVALID_INPUT, naming the field, before the handler runs;
//    • fields a route doesn't read are dropped;
//    • text that arrives as a number (a phone typed into a numeric
//      field) is accepted — it used to crash the handler with a 500;
//    • a missing field still gets the handler's own words.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, admin;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  Employee = require('../../models/Employee');
  admin = await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('a value of the wrong type or size', () => {
  it('is refused with the field named, before the handler runs', async () => {
    const res = await request(app).post('/api/v2/user/login-user').send({ email: { $gt: '' }, password: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_INPUT', message: 'email must be text' });
    expect(res.body.details.issues[0]).toMatchObject({ field: 'email' });
  });

  it('refuses a password too long to be worth hashing', async () => {
    const res = await request(app).post('/api/v2/user/login-user').send({ email: 'own@t.co', password: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/password is too long/);
  });

  it('refuses a malformed id in the path', async () => {
    const res = await request(app).put('/api/v2/user/manage/not-an-id').set('Cookie', cookie(admin)).send({ name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/id/);
  });
});

describe('a field the route does not read', () => {
  it('is dropped, so it can never reach the database', async () => {
    const res = await request(app).post('/api/v2/employee/create-employee').set('Cookie', cookie(admin))
      .send({ name: 'Smuggler', department: 'weaving', performance: 100, shifts: ['x'], isAdmin: true });
    expect(res.status).toBe(201);
    const doc = await Employee.findById(res.body.employee._id).lean();
    expect(doc.performance).not.toBe(100);
    expect(doc).not.toHaveProperty('isAdmin');
  });
});

describe('text sent as a number', () => {
  it('is accepted: a phone number from a numeric field no longer crashes the route', async () => {
    const res = await request(app).post('/api/v2/employee/create-employee').set('Cookie', cookie(admin))
      .send({ name: 'Numeric Phone', department: 'weaving', phoneNumber: 9300000001 });
    expect(res.status).toBe(201);
    expect(res.body.employee.phoneNumber).toBe('9300000001');
  });
});

describe('a missing field', () => {
  it('still gets the handler\'s own words', async () => {
    const res = await request(app).post('/api/v2/user/login-user').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Please provide the all fields!');
    expect(res.body.code).toBeUndefined();
  });
});
