'use strict';
// ══════════════════════════════════════════════════════════════════
//  OFFBOARDING — someone leaves
//
//  Held here:
//    • only an admin offboards, with a last working day and a reason;
//    • it is refused while they are on a shift after that day;
//    • their worker sign-in is closed at once (PIN gone, sessions ended),
//      and a manager login is reported, not touched;
//    • from the day after, they are out of the employee list (but in
//      "left"), out of the pickers, and cannot be put on a shift;
//    • someone serving notice is still here until their last day;
//    • nothing of theirs is deleted, and reinstating them keeps the
//      record of having left.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supervisor, ALWAYS_ON, factoryToday;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(url).set('Cookie', cookieFor(u)).send(body),
});
const offboard = (emp, body, by = admin) => as(by).post(`/api/v2/employee/${emp._id}/offboard`, body);
const dayKey = (offset) => {
  const d = new Date(`${factoryToday()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'ShiftDetail', 'ShiftPlan']) M[n] = require(`../../models/${n}.js`);
  ({ ALWAYS_ON } = require('../../utils/features'));
  ({ factoryToday } = require('../../utils/employeeStatus'));
  admin = await M.User.create({ name: 'Owner', email: 'own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await M.User.create({ name: 'Floor', email: 'floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  await M.Employee.deleteMany({});
  await M.User.deleteMany({ _id: { $nin: [admin._id, supervisor._id] } });
  await M.ShiftDetail.deleteMany({});
  await M.ShiftPlan.deleteMany({});
  await M.Machine.deleteMany({});
});

const worker = (name = 'Ravi', phoneNumber = '9100000001') =>
  M.Employee.create({ name, phoneNumber, department: 'weaving', role: 'operator' });

describe('offboarding', () => {
  it('is the admin\'s alone, and needs a day and a reason', async () => {
    const ravi = await worker();
    expect((await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'resigned' }, supervisor)).status).toBe(403);
    expect((await offboard(ravi, { reason: 'resigned' })).status).toBe(400);
    expect((await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'bored' })).status).toBe(400);
    expect((await M.Employee.findById(ravi._id).lean()).status).toBe('active');
  });

  it('records when and why, and takes them out of the list from the next day', async () => {
    const ravi = await worker();
    const kumar = await worker('Kumar', '9100000002');
    const res = await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'resigned', note: 'Moved to Tiruppur' });
    expect(res.status).toBe(200);
    expect(res.body.employee.status).toBe('offboarded');

    const e = await M.Employee.findById(ravi._id).lean();
    expect(e.offboarding).toMatchObject({ reason: 'resigned', note: 'Moved to Tiruppur', recordedByName: 'Owner' });
    expect(e.offboarding.lastWorkingDay.toISOString().slice(0, 10)).toBe(dayKey(-1));

    const names = async (q) => (await as(admin).get(`/api/v2/employee/get-employees${q}`)).body.employees.map((x) => x.name);
    expect(await names('')).toEqual(['Kumar']);
    expect(await names('?status=left')).toEqual(['Ravi']);
    expect(await names('?status=all')).toEqual(['Kumar', 'Ravi']);

    const detail = await as(admin).get(`/api/v2/employee/get-employee-detail?id=${ravi._id}`);
    expect(detail.body.employee.status).toBe('offboarded');
    expect(detail.body.employee.offboarding.reason).toBe('resigned');
    void kumar;
  });

  it('someone serving notice is still here until their last day', async () => {
    const ravi = await worker();
    await offboard(ravi, { lastWorkingDay: dayKey(10), reason: 'resigned' });
    const list = (await as(admin).get('/api/v2/employee/get-employees')).body.employees;
    expect(list.map((x) => x.name)).toEqual(['Ravi']);
    expect(list[0].status).toBe('offboarded');
    expect((await as(admin).get('/api/v2/employee/get-employees?status=left')).body.employees).toEqual([]);
  });

  it('is refused while they are on a shift after their last day, naming it', async () => {
    const ravi = await worker();
    const machine = await M.Machine.create({ ID: 'L-7', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'free' });
    const date = new Date(`${dayKey(2)}T00:00:00.000Z`);
    const plan = await M.ShiftPlan.create({ date, shift: 'DAY' });
    await M.ShiftDetail.create({ date, shift: 'DAY', machine: machine._id, employee: ravi._id, shiftPlan: plan._id, status: 'open' });
    const res = await offboard(ravi, { lastWorkingDay: dayKey(0), reason: 'resigned' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EMPLOYEE_HAS_LATER_SHIFTS');
    expect(res.body.message).toMatch(/Ravi is on 1 shift after/);
    expect(res.body.details.shifts[0]).toMatchObject({ machine: 'L-7', shift: 'DAY' });
    // A later last day, after the shift, is fine.
    expect((await offboard(ravi, { lastWorkingDay: dayKey(2), reason: 'resigned' })).status).toBe(200);
  });

  it('cannot be done twice', async () => {
    const ravi = await worker();
    await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'absconded' });
    const res = await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'absconded' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already recorded as leaving/);
  });
});

describe('their sign-in', () => {
  it('a worker login loses its PIN and every open session', async () => {
    const ravi = await worker();
    const set = await as(admin).post(`/api/v2/user/manage/worker-access/${ravi._id}`, { pin: '2580' });
    expect(set.status).toBe(201);
    const login = await M.User.findOne({ employee: ravi._id });
    const before = login.tokenVersion ?? 0;
    expect((await request(app).post('/api/v2/user/worker-login').send({ phone: '9100000001', pin: '2580' })).status).toBe(201);

    const res = await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'resigned' });
    expect(res.body.workerLoginClosed).toBe(true);
    expect(res.body.managerLogin).toBeNull();

    const after = await M.User.findById(login._id).select('+pin').lean();
    expect(after.pin).toBeUndefined();
    expect(after.tokenVersion).toBe(before + 1);
    // An old session is ended…
    expect((await as({ ...login.toObject(), tokenVersion: before }).get('/api/v2/user/getuser')).status).toBe(401);
    // …and no new one can start, nor a PIN be set again until reinstated.
    expect((await request(app).post('/api/v2/user/worker-login').send({ phone: '9100000001', pin: '2580' })).status).toBe(401);
    const again = await as(admin).post(`/api/v2/user/manage/worker-access/${ravi._id}`, { pin: '2580' });
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/has left/);
  });

  it('a manager login is reported, for the admin to remove', async () => {
    const sup = await worker('Floor', '9100000003');
    await M.User.updateOne({ _id: supervisor._id }, { employee: sup._id });
    const res = await offboard(sup, { lastWorkingDay: dayKey(-1), reason: 'retired' });
    expect(res.body.workerLoginClosed).toBe(false);
    expect(res.body.managerLogin).toEqual({ id: String(supervisor._id), email: 'floor@t.co' });
    await M.User.updateOne({ _id: supervisor._id }, { $unset: { employee: 1 } });
  });

  it('nobody else is blocked from a phone number a leaver had', async () => {
    const old = await worker('Old Hand', '9100000009');
    await offboard(old, { lastWorkingDay: dayKey(-30), reason: 'resigned' });
    // The number is reused by a new worker's record (added directly; the
    // create form tells the admin to reinstate instead).
    const fresh = await M.Employee.create({ name: 'New Hand', phoneNumber: '9100000009', department: 'weaving' });
    const set = await as(admin).post(`/api/v2/user/manage/worker-access/${fresh._id}`, { pin: '2580' });
    expect(set.status).toBe(201);
    expect((await request(app).post('/api/v2/user/worker-login').send({ phone: '9100000009', pin: '2580' })).status).toBe(201);
  });

  it('adding them again by phone number points to reinstating', async () => {
    const ravi = await worker();
    await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'resigned' });
    const res = await as(admin).post('/api/v2/employee/create-employee', { name: 'Ravi', department: 'weaving', phoneNumber: '9100000001' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/belongs to Ravi, who has left\. Reinstate them/);
  });
});

describe('shifts', () => {
  const machine = () => M.Machine.create({ ID: `L-${Math.random().toString(36).slice(2, 6)}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'free' });
  const planFor = async (date, emp) => request(app).post('/api/v2/shift/create-shift-plan').set('Cookie', cookieFor(admin))
    .send({ date, shiftType: 'DAY', machines: [{ machine: String((await machine())._id), operator: String(emp._id) }] });

  it('a leaver cannot be put on a shift after their last day, but the days before still work', async () => {
    const ravi = await worker();
    await offboard(ravi, { lastWorkingDay: dayKey(-1), reason: 'resigned' });

    const after = await planFor(dayKey(0), ravi);
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('EMPLOYEE_OFFBOARDED');
    expect(after.body.message).toMatch(/Ravi left on/);
    expect(await M.ShiftPlan.countDocuments({})).toBe(0);

    // A shift on their last day (entered late) is still theirs.
    expect((await planFor(dayKey(-1), ravi)).status).toBeLessThan(300);
  });
});

describe('reinstating', () => {
  it('brings them back, keeping when and why they left', async () => {
    const ravi = await worker();
    await offboard(ravi, { lastWorkingDay: dayKey(-5), reason: 'resigned', note: 'Family' });
    expect((await as(supervisor).post(`/api/v2/employee/${ravi._id}/reinstate`, {})).status).toBe(403);
    const res = await as(admin).post(`/api/v2/employee/${ravi._id}/reinstate`, { note: 'Rejoined' });
    expect(res.status).toBe(200);

    const e = await M.Employee.findById(ravi._id).lean();
    expect(e.status).toBe('active');
    expect(e.offboarding?.lastWorkingDay).toBeUndefined();
    expect(e.pastOffboardings).toHaveLength(1);
    expect(e.pastOffboardings[0]).toMatchObject({ reason: 'resigned', note: 'Family · Reinstated: Rejoined', reinstatedByName: 'Owner' });
    expect((await as(admin).get('/api/v2/employee/get-employees')).body.employees.map((x) => x.name)).toEqual(['Ravi']);

    const twice = await as(admin).post(`/api/v2/employee/${ravi._id}/reinstate`, {});
    expect(twice.status).toBe(409);
  });
});
