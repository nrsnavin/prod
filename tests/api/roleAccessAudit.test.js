'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT EACH ROLE IS SHOWN, IT CAN OPEN — found by walking every page
//  as each role
//
//    • production has the planner in its menu: it can read the plan;
//      accepting it and resetting the weights stay the admin's
//    • announcements: everyone reads what is up for them now; only an
//      admin sees drafts, expired notices and other departments'
//    • feedback: a worker reads, sends and withdraws only their own; the
//      inbox is the admin's and is no longer in other menus
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, prod, workerA, workerB, empA, empB;
const as = (u) => {
  const c = [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
  return {
    get: (url) => request(app).get(`/api/v2${url}`).set('Cookie', c),
    post: (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', c).send(body),
    del: (url) => request(app).delete(`/api/v2${url}`).set('Cookie', c),
  };
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User.js');
  const Employee = require('../../models/Employee.js');
  admin = await User.create({ name: 'Owner', email: 'ra@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  prod = await User.create({ name: 'Sup', email: 'ra2@t.co', password: 'pass1234', role: 'production', department: 'production' });
  empA = await Employee.create({ name: 'Ravi', department: 'weaving' });
  empB = await Employee.create({ name: 'Mani', department: 'weaving' });
  workerA = await User.create({ name: 'Ravi', email: 'ra3@t.co', password: 'pass1234', role: 'production', department: 'production', employee: empA._id });
  workerB = await User.create({ name: 'Mani', email: 'ra4@t.co', password: 'pass1234', role: 'production', department: 'production', employee: empB._id });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('the planner, for production', () => {
  it('reads the plan and the weights, but cannot accept a plan or reset the weights', async () => {
    expect((await as(prod).get('/planner/latest')).status).toBe(200);
    expect((await as(prod).get('/planner/weights')).status).toBe(200);
    expect((await as(prod).post('/planner/weights/reset', {})).status).toBe(403);
    expect((await as(prod).post('/planner/accept', {})).status).toBe(403);
  });
});

describe('announcements', () => {
  it('shows everyone what is up for them now, and only the admin the rest', async () => {
    const A = require('../../models/Announcement.js');
    const day = 86_400_000;
    await A.create([
      { title: 'Safety drill Friday', body: 'x', audience: 'all', isActive: true },
      { title: 'Production: new shift timings', body: 'x', audience: 'department', department: 'production', isActive: true },
      { title: 'Packing only', body: 'x', audience: 'department', department: 'packing', isActive: true },
      { title: 'Draft', body: 'x', audience: 'all', isActive: false },
      { title: 'Expired', body: 'x', audience: 'all', isActive: true, validUntil: new Date(Date.now() - day) },
      { title: 'Next week', body: 'x', audience: 'all', isActive: true, validFrom: new Date(Date.now() + day) },
    ]);
    const mine = await as(prod).get('/announcement/');
    expect(mine.status).toBe(200);
    expect(mine.body.readOnly).toBe(true);
    expect(mine.body.data.map((a) => a.title).sort()).toEqual(['Production: new shift timings', 'Safety drill Friday']);
    const all = await as(admin).get('/announcement/');
    expect(all.body.data).toHaveLength(6);
    expect((await as(prod).post('/announcement/', { title: 'x', body: 'y' })).status).toBe(403);
  });
});

describe('feedback', () => {
  it('a worker sends, reads and withdraws only their own', async () => {
    const sent = await as(workerA).post('/feedback', { employeeId: String(empA._id), type: 'suggestion', category: 'other', subject: 'Fans on loom row 3', body: 'Too hot after noon', isAnonymous: true });
    expect(sent.status).toBe(201);
    const id = sent.body.data?._id || sent.body.feedback?._id;
    // Not in another's name.
    expect((await as(workerB).post('/feedback', { employeeId: String(empA._id), type: 'complaint', category: 'other', subject: 'x', body: 'y' })).status).toBe(403);
    // Not another's list — anonymous notes stay anonymous.
    expect((await as(workerB).get(`/feedback/employee/${empA._id}`)).status).toBe(403);
    expect((await as(workerA).get(`/feedback/employee/${empA._id}`)).body.data).toHaveLength(1);
    expect((await as(admin).get(`/feedback/employee/${empA._id}`)).status).toBe(200);
    // Not withdrawn by another.
    expect((await as(workerB).del(`/feedback/${id}`)).status).toBe(403);
    expect((await as(workerA).del(`/feedback/${id}`)).status).toBe(200);
  });

  it('keeps the inbox out of every menu but the admin\'s', () => {
    const { featuresForDepartment } = require('../../utils/features');
    expect(featuresForDepartment('admin')).toContain('/feedback');
    for (const d of ['production', 'packing', 'finance', 'marketing']) expect(featuresForDepartment(d)).not.toContain('/feedback');
    expect(featuresForDepartment('production')).toContain('/announcements');
  });
});
