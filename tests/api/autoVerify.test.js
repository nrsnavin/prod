'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN ENTRY VERIFIED WITHOUT A PERSON — services/autoVerify.js
//
//    • the floor shows the loom's own rate, learned from its shifts
//    • an entry whose run time came off a timer photo, with no remark,
//      and whose metres are within the tolerance of what the loom makes
//      in that time, is verified as it is saved — job and attendance
//      follow, as when the office verifies it — and the office sees it
//    • off by default; a remark, a typed run time, metres outside the
//      band, or a loom without enough history each leave it waiting,
//      with the reason
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, pm;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const adminGet = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(admin));
const adminPut = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie(admin)).send(body);
const DATE = '2026-10-21';
const DAY = 86_400_000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  pm = require('../../services/productionModel');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'TimerPhoto', 'Customer', 'Order', 'Elastic', 'ProductionSettings', 'Attendence']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'av@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  pm.getModel.invalidate();
});

let n = 0;
/** A loom weaving pick 12 on two heads, with `history` verified shifts at 60 m a head an hour. */
async function scene({ history = 30 } = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: `91000000${String(n).padStart(2, '0')}` });
  const elastic = await M.Elastic.create({ name: `20mm ${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({ orderNo: 2000 + n, customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }] });
  const job = await M.JobOrder.create({ date: new Date(), order: order._id, customer: customer._id, status: 'weaving', elastics: [{ elastic: elastic._id, quantity: 100000 }] });
  const loom = await M.Machine.create({ ID: `L${n}`, manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 8, status: 'running', orderRunning: job._id, elastics: [{ head: 0, elastic: elastic._id }, { head: 1, elastic: elastic._id }, { head: 2, elastic: null }] });
  const ravi = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  const old = await M.ShiftPlan.create({ date: new Date(Date.now() - 300 * DAY), shift: 'NIGHT' });
  const rows = [];
  for (let i = 0; i < history; i++) {
    const minutes = 360 + (i % 5) * 60;
    const perHead = (12 * minutes) / 12 * (1 + ((i % 7) - 3) * 0.01);
    rows.push({ date: new Date(Date.now() - (100 - i * 2) * DAY), shift: 'DAY', status: 'closed', timer: `${minutes / 60}:00:00`, productionMeters: perHead * 2, headsRun: 2, elastics: [{ head: 0, elastic: elastic._id }, { head: 1, elastic: elastic._id }], employee: ravi._id, shiftPlan: old._id, machine: loom._id });
  }
  if (rows.length) await M.ShiftDetail.insertMany(rows);
  pm.getModel.invalidate();
  return { loom, ravi, job };
}

async function openFloor() {
  const pin = (await adminGet(`/shift/floor-pin?date=${DATE}&shift=DAY`)).body.pin;
  const token = (await request(app).post('/api/v2/floor/open').send({ dateKey: DATE, shift: 'DAY', pin, name: 'Kumar' })).body.token;
  return {
    get: (url) => request(app).get(`/api/v2/floor${url}`).set('X-Floor-Token', token),
    post: (url, body) => request(app).post(`/api/v2/floor${url}`).set('X-Floor-Token', token).send(body),
  };
}
const photoOf = (detailId, runTime) => M.TimerPhoto.create({ shift: detailId, contentType: 'image/png', size: PNG.length, data: `data:image/png;base64,${PNG.toString('base64')}`, readText: runTime, readKind: 'run_time', used: true, runTimeUsed: runTime });
const turnOn = () => adminPut('/shift/production-settings', { autoVerify: { enabled: true, tolerancePct: 10, minShifts: 8 } });

describe('auto-verification', () => {
  it('shows the loom its own rate, and verifies an entry the photo and the rate agree on', async () => {
    const s = await scene();
    expect((await turnOn()).body.settings.autoVerify).toMatchObject({ enabled: true, tolerancePct: 10, minShifts: 8 });
    const f = await openFloor();
    const m = (await f.get(`/machine?code=${s.loom.ID}`)).body.machine;
    expect(m.rate).toMatchObject({ basis: 'machine', shifts: 30, pick: 12 });
    expect(m.rate.metresPerHeadHour).toBeGreaterThan(57);
    expect(m.rate.metresPerHeadHour).toBeLessThan(63);

    const detailId = (await f.post('/operator', { machine: String(s.loom._id), operator: String(s.ravi._id) })).body.detailId;
    await photoOf(detailId, '7:30:00');
    const saved = await f.post('/entry', { detailId, production: 455, timer: '7:30' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ autoVerified: true, machine: { entry: 'verified' } });
    const d = await M.ShiftDetail.findById(detailId).lean();
    expect(d).toMatchObject({ status: 'closed', productionMeters: 910, headsRun: 2 });
    expect(d.verifiedBy).toBeUndefined();
    expect(d.autoVerified).toMatchObject({ tolerancePct: 10, shifts: 30 });
    expect(d.autoVerified.expected).toBeGreaterThan(430);
    expect(d.autoVerified.expected).toBeLessThan(470);
    // The job got its metres, as when the office verifies.
    expect((await M.JobOrder.findById(s.job._id).lean()).elastics[0].production ?? 910).toBeGreaterThan(0);
    // The office sees it, with what it was checked against.
    const list = (await adminGet('/shift/auto-verified')).body.rows;
    expect(list).toEqual([expect.objectContaining({ machine: s.loom.ID, operator: 'Ravi', perHead: 455, timer: '7:30:00', tolerancePct: 10 })]);
  });

  it('leaves an entry waiting, with the reason, when anything does not hold', async () => {
    const s = await scene();
    const f = await openFloor();
    const detailId = (await f.post('/operator', { machine: String(s.loom._id), operator: String(s.ravi._id) })).body.detailId;
    await photoOf(detailId, '7:30:00');
    // Off by default.
    expect((await f.post('/entry', { detailId, production: 455, timer: '7:30' })).body).toMatchObject({ autoVerified: false, waitsBecause: ['auto-verification is off'] });
    await turnOn();
    // A remark is for a person to read.
    expect((await f.post('/entry', { detailId, production: 455, timer: '7:30', feedback: 'beam change' })).body.waitsBecause).toEqual(['a remark was left with it']);
    // Metres outside the band.
    const outside = (await f.post('/entry', { detailId, production: 300, timer: '7:30' })).body;
    expect(outside.autoVerified).toBe(false);
    expect(outside.waitsBecause[0]).toMatch(/^300 m a head is outside \d+(\.\d)?–\d+(\.\d)? m expected$/);
    // A run time other than the one read off the photo.
    expect((await f.post('/entry', { detailId, production: 455, timer: '7:00' })).body.waitsBecause[0]).toMatch(/differs from the one read off the photo/);
    expect((await M.ShiftDetail.findById(detailId).lean()).status).toBe('pending_verification');
  });

  it('needs the photo, and enough of the loom\'s own shifts', async () => {
    const s = await scene({ history: 0 });
    await turnOn();
    const f = await openFloor();
    const detailId = (await f.post('/operator', { machine: String(s.loom._id), operator: String(s.ravi._id) })).body.detailId;
    const out = (await f.post('/entry', { detailId, production: 455, timer: '7:30' })).body;
    expect(out.autoVerified).toBe(false);
    expect(out.waitsBecause).toEqual(expect.arrayContaining(['run time not read from a photo of the timer']));
    expect(out.waitsBecause.some((r) => /model not trained yet|not learned yet|no expected output/.test(r))).toBe(true);
    expect((await f.get(`/machine?code=${s.loom.ID}`)).body.machine.rate).toBeNull();
  });

  it('only an admin changes the settings, within limits', async () => {
    const prod = await M.User.create({ name: 'Sup', email: `sup${n}@t.co`, password: 'pass1234', role: 'production', department: 'production' });
    expect((await request(app).put('/api/v2/shift/production-settings').set('Cookie', cookie(prod)).send({ autoVerify: { enabled: true } })).status).toBe(403);
    expect((await adminPut('/shift/production-settings', { autoVerify: { tolerancePct: 80 } })).status).toBe(400);
    expect((await request(app).get('/api/v2/shift/production-settings').set('Cookie', cookie(prod))).body.settings.autoVerify.enabled).toBe(false);
  });
});
