'use strict';
// ══════════════════════════════════════════════════════════════════
//  AADHAAR — sealed at rest, masked in every answer
//
//  Held here, against a real database:
//    • the stored value is AES-256-GCM ciphertext when AADHAAR_KEY is set;
//    • every screen gets "XXXX XXXX 1234", admins included, and nothing
//      that populates an employee carries the number at all;
//    • an admin can ask for the full number, and that is recorded;
//    • the masked value sent back by an edit form never overwrites it;
//    • only an admin can set a new number;
//    • numbers saved before the key keep working, and the script seals
//      them in place.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const KEY = Buffer.alloc(32, 7).toString('base64');

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, AccessEvent, aadhaar;
let admin, supervisor;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(url).set('Cookie', cookieFor(u)).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookieFor(u)).send(body),
});
const stored = async (id) => (await Employee.findById(id).select('+aadhar').lean()).aadhar;

beforeAll(async () => {
  process.env.AADHAAR_KEY = KEY;
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  Employee = require('../../models/Employee');
  AccessEvent = require('../../models/AccessEvent');
  aadhaar = require('../../utils/aadhaar');
  admin = await User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await User.create({ name: 'Floor', email: 'floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);

afterAll(async () => {
  delete process.env.AADHAAR_KEY;
  await mongoose.disconnect();
  await mongo.stop();
});

describe('the helpers', () => {
  it('seal and open round-trip, and every seal is different', () => {
    const a = aadhaar.seal('1234 5678 9012');
    const b = aadhaar.seal('1234 5678 9012');
    expect(a).toMatch(/^enc:v1:/);
    expect(a).not.toBe(b);
    expect(aadhaar.open(a)).toBe('1234 5678 9012');
  });

  it('refuse a sealed value that was tampered with', () => {
    const a = aadhaar.seal('123456789012');
    const parts = a.split(':');
    parts[4] = Buffer.from('999999999999').toString('base64');
    expect(() => aadhaar.open(parts.join(':'))).toThrow();
  });

  it('mask to the last four digits', () => {
    expect(aadhaar.mask('1234 5678 9012')).toBe('XXXX XXXX 9012');
    expect(aadhaar.mask('12')).toBe('XXXX');
    expect(aadhaar.looksMasked('XXXX XXXX 9012')).toBe(true);
    expect(aadhaar.looksMasked('123456789012')).toBe(false);
  });
});

describe('through the API', () => {
  let emp;

  it('is sealed when an admin registers the worker, and never answered in full', async () => {
    const res = await as(admin).post('/api/v2/employee/create-employee', {
      name: 'Ravi', department: 'weaving', phoneNumber: '9200000001', aadhar: '1234 5678 9012',
    });
    expect(res.status).toBe(201);
    expect(res.body.employee.aadhar).toBe('XXXX XXXX 9012');
    emp = res.body.employee;
    const raw = await stored(emp._id);
    expect(raw).toMatch(/^enc:v1:/);
    expect(raw).not.toMatch(/9012/);
  });

  it('is masked on the employee page, for admins too', async () => {
    for (const u of [admin, supervisor]) {
      const res = await as(u).get(`/api/v2/employee/get-employee-detail?id=${emp._id}`);
      expect(res.body.employee.aadhar).toBe('XXXX XXXX 9012');
    }
  });

  it('is not carried by anything that loads an employee without asking', async () => {
    const doc = await Employee.findById(emp._id).lean();
    expect(doc).not.toHaveProperty('aadhar');
    const list = await as(supervisor).get('/api/v2/employee/get-employees');
    expect(JSON.stringify(list.body)).not.toMatch(/aadhar|enc:v1/);
  });

  it('is shown in full to an admin who asks, and the look is recorded', async () => {
    const res = await as(admin).get(`/api/v2/employee/aadhaar?id=${emp._id}`);
    expect(res.status).toBe(200);
    expect(res.body.aadhar).toBe('1234 5678 9012');
    const ev = await AccessEvent.findOne({ code: 'AADHAAR_VIEWED', 'subject.id': String(emp._id) }).lean();
    expect(ev).toMatchObject({ actor: { name: 'Owner' }, subject: { name: 'Ravi' } });
    expect(JSON.stringify(ev)).not.toMatch(/9012/);
  });

  it('is refused in full to anyone else', async () => {
    const res = await as(supervisor).get(`/api/v2/employee/aadhaar?id=${emp._id}`);
    expect(res.status).toBe(403);
  });

  it('survives an edit form sending the masked value back', async () => {
    const before = await stored(emp._id);
    for (const sent of ['XXXX XXXX 9012', 'Not Provided']) {
      const res = await as(supervisor).put(`/api/v2/employee/update?id=${emp._id}`, { role: 'senior', aadhar: sent });
      expect(res.status).toBe(200);
      expect(res.body.employee.aadhar).toBeUndefined(); // not loaded, not answered
    }
    expect(await stored(emp._id)).toBe(before);
  });

  it('can only be changed by an admin', async () => {
    const res = await as(supervisor).put(`/api/v2/employee/update?id=${emp._id}`, { aadhar: '999988887777' });
    expect(res.status).toBe(403);
    const ok = await as(admin).put(`/api/v2/employee/update?id=${emp._id}`, { aadhar: '999988887777' });
    expect(ok.status).toBe(200);
    expect(ok.body.employee.aadhar).toBe('XXXX XXXX 7777');
    expect(aadhaar.open(await stored(emp._id))).toBe('999988887777');
  });

  it('reads a number saved before the key, and the script seals it', async () => {
    const legacy = await Employee.create({ name: 'Old', department: 'weaving' });
    await Employee.updateOne({ _id: legacy._id }, { $set: { aadhar: '111122223333' } });
    const blank = await Employee.create({ name: 'Blank', department: 'weaving' });
    await Employee.updateOne({ _id: blank._id }, { $set: { aadhar: 'Not Provided' } });

    const res = await as(supervisor).get(`/api/v2/employee/get-employee-detail?id=${legacy._id}`);
    expect(res.body.employee.aadhar).toBe('XXXX XXXX 3333');

    const { sealAll } = require('../../scripts/encrypt-aadhaar');
    expect(await sealAll({ apply: false })).toMatchObject({ sealed: 1, cleared: 1 });
    expect(await stored(legacy._id)).toBe('111122223333'); // a dry run writes nothing
    await sealAll({ apply: true });
    expect(await stored(legacy._id)).toMatch(/^enc:v1:/);
    expect(await stored(blank._id)).toBeUndefined();
    expect(await sealAll({ apply: true })).toMatchObject({ sealed: 0, cleared: 0 });
  });
});
