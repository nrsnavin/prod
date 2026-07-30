'use strict';
// Recent shifts on the machine detail page.
//
// The endpoint used to read Machine.shifts — a denormalised array that the
// shift-plan create path never wrote to (only the delete path filtered it),
// so the table was permanently empty. These tests pin the behaviour to the
// ShiftDetail collection itself, which is the record that actually exists.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Machine, ShiftDetail, Employee, User, JobOrder, admin;

const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Machine = require('../../models/Machine');
  ShiftDetail = require('../../models/ShiftDetail');
  Employee = require('../../models/Employee');
  JobOrder = require('../../models/JobOrder');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const makeMachine = (over = {}) =>
  Machine.create({ ID: 'M-01', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24, ...over });

/** Creates a shift on `day` of Jan 2026 without touching Machine.shifts. */
async function makeShift(machine, employee, day, over = {}) {
  return ShiftDetail.create({
    date: new Date(Date.UTC(2026, 0, day)),
    shift: 'DAY',
    job: new mongoose.Types.ObjectId(),
    machine: machine._id,
    employee: employee._id,
    shiftPlan: new mongoose.Types.ObjectId(),
    elastics: [],
    status: 'closed',
    timer: '06:00:00',
    productionMeters: 500,
    ...over,
  });
}

const detail = (id) =>
  request(app).get("/api/v2/machine/get-machine-detail").query({ id: String(id) }).set('Cookie', adminCookie());

describe('GET /machine/get-machine-detail — recent shifts', () => {
  test('returns shifts recorded against the machine even though Machine.shifts is empty', async () => {
    const m = await makeMachine();
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    await makeShift(m, emp, 5);

    // The regression this guards: nothing ever populates the array.
    const fresh = await Machine.findById(m._id);
    expect(fresh.shifts).toHaveLength(0);

    const res = await detail(m._id);
    expect(res.status).toBe(200);
    expect(res.body.machine.result).toHaveLength(1);
    expect(res.body.machine.result[0].employee).toBe('Ravi');
  });

  test('reports the meters produced, not zero', async () => {
    const m = await makeMachine();
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    await makeShift(m, emp, 5, { productionMeters: 1234 });

    const res = await detail(m._id);
    expect(res.body.machine.result[0].outputMeters).toBe(1234);
  });

  test('returns the six most recent shifts, newest first', async () => {
    const m = await makeMachine();
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    for (const day of [1, 2, 3, 4, 5, 6, 7, 8]) await makeShift(m, emp, day);

    const res = await detail(m._id);
    const rows = res.body.machine.result;
    expect(rows).toHaveLength(6);
    const days = rows.map((r) => new Date(r.date).getUTCDate());
    expect(days).toEqual([8, 7, 6, 5, 4, 3]);
  });

  test('never shows another machine’s shifts', async () => {
    const [a, b] = await Promise.all([makeMachine(), makeMachine({ ID: 'M-02' })]);
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    await makeShift(a, emp, 5, { productionMeters: 111 });
    await makeShift(b, emp, 6, { productionMeters: 222 });

    const res = await detail(a._id);
    expect(res.body.machine.result).toHaveLength(1);
    expect(res.body.machine.result[0].outputMeters).toBe(111);
  });

  test('survives a shift whose operator was deleted', async () => {
    const m = await makeMachine();
    const emp = await Employee.create({ name: 'Gone', hourlyRate: 100 });
    await makeShift(m, emp, 5);
    await Employee.findByIdAndDelete(emp._id);

    const res = await detail(m._id);
    expect(res.status).toBe(200);
    expect(res.body.machine.result[0].employee).toBe('Unknown');
  });

  test('derives runtime and efficiency from the shift timer against a 12h shift', async () => {
    const m = await makeMachine();
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    await makeShift(m, emp, 5, { timer: '06:00:00' });

    const row = (await detail(m._id)).body.machine.result[0];
    expect(row.runtimeMinutes).toBe(360);
    expect(row.efficiency).toBe(50); // 360 / 720
  });

  test('carries the shift status so an open shift reading 0 m is explicable', async () => {
    const m = await makeMachine();
    const emp = await Employee.create({ name: 'Ravi', hourlyRate: 100 });
    await makeShift(m, emp, 5, { status: 'open', timer: '00:00:00', productionMeters: 0 });

    const row = (await detail(m._id)).body.machine.result[0];
    expect(row.status).toBe('open');
    expect(row.outputMeters).toBe(0);
  });

  test('returns an empty list for a machine that has never run', async () => {
    const m = await makeMachine();
    const res = await detail(m._id);
    expect(res.status).toBe(200);
    expect(res.body.machine.result).toEqual([]);
  });
});
