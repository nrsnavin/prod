'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN EMPLOYEE'S SHIFTS, READ BY REFERENCE
//
//  The employee page used to populate Employee.shifts — every shift the
//  person ever worked, with its machine — then sort in JavaScript and
//  keep ten. Its cost grew by roughly 730 documents per operator per
//  year, for good. It now reads ShiftDetail by its `employee` ref: ten
//  newest, and a count.
//
//  The array was also wrong for older data: the plan route once pushed
//  a whole plan onto every operator in it, so "Total shifts" was
//  inflated. The count now comes from the details themselves.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['Employee', 'Machine', 'ShiftDetail', 'User']) M[n] = require(`../../models/${n}`);
  admin = await M.User.create({ name: 'Owner', email: 'es@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await M.ShiftDetail.syncIndexes();
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function operatorWithShifts(n) {
  const emp = await M.Employee.create({ name: 'Ravi', phoneNumber: '9000000002', role: 'operator', salary: 600 });
  const machine = await M.Machine.create({ ID: 'M-07', manufacturer: 'Comez', NoOfHead: 1, NoOfHooks: 8 });
  const base = Date.parse('2026-01-01T06:00:00Z');
  for (let i = 0; i < n; i++) {
    await M.ShiftDetail.create({
      date: new Date(base + i * 864e5), shift: i % 2 ? 'NIGHT' : 'DAY',
      machine: machine._id, employee: emp._id, timer: '06:00:00',
      shiftPlan: new mongoose.Types.ObjectId(),
      productionMeters: 100 + i, status: 'closed',
      createdAt: new Date(base + i * 864e5),
    });
  }
  return { emp, machine };
}

const detail = (id) =>
  request(app).get('/api/v2/employee/get-employee-detail').query({ id: String(id) }).set('Cookie', cookie());

describe('the employee page', () => {
  it('counts every shift the person worked', async () => {
    const { emp } = await operatorWithShifts(15);
    const res = await detail(emp._id);
    expect(res.status).toBe(200);
    expect(res.body.employee.totalShifts).toBe(15);
  });

  it('shows the ten newest, newest first, with their machine', async () => {
    const { emp } = await operatorWithShifts(15);
    const { result } = (await detail(emp._id)).body.employee;
    expect(result).toHaveLength(10);
    // Newest is the 15th shift, which made 114 m.
    expect(result.map((r) => r.outputMeters)).toEqual([114, 113, 112, 111, 110, 109, 108, 107, 106, 105]);
    expect(result[0].machine).toBe('M-07');
  });

  it('gives the true count when the old array was inflated', async () => {
    // Older data: the plan route once pushed a whole plan's shifts onto
    // every operator, so the array overstates the person's work.
    const { emp } = await operatorWithShifts(4);
    const others = Array.from({ length: 40 }, () => new mongoose.Types.ObjectId());
    await M.Employee.updateOne({ _id: emp._id }, { $set: { shifts: others } });
    expect((await detail(emp._id)).body.employee.totalShifts).toBe(4);
  });

  it('is served by the { employee, createdAt } index, not a scan', async () => {
    const { emp } = await operatorWithShifts(3);
    const plan = await M.ShiftDetail.find({ employee: emp._id }).sort({ createdAt: -1 }).limit(10).explain('queryPlanner');
    const winning = JSON.stringify(plan.queryPlanner?.winningPlan ?? plan[0]?.queryPlanner?.winningPlan);
    expect(winning).toMatch(/IXSCAN/);
    expect(winning).toMatch(/employee_1_createdAt_-1/);
  });

  it('still says not found for an employee that does not exist', async () => {
    expect((await detail(new mongoose.Types.ObjectId())).status).toBe(404);
  });
});
