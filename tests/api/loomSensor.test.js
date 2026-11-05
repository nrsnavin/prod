'use strict';
// ══════════════════════════════════════════════════════════════════
//  LOOM SENSORS — api/loomSensor.js, services/loomSensor.js
//
//    • the admin adds a board for a loom and gets its key once; only a
//      hash is kept; a new key retires the old; removing stops posts
//    • the board posts running totals with its key — one, or a batch it
//      kept offline; a repeat is one reading; bad ones are refused
//    • a shift's run time is the rise across the shift: restarts, gaps,
//      garbled jumps and the shift's edges handled
//    • the floor sees it on the loom, and auto-verification takes it as
//      the run time's evidence when there is no photo
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supervisor, sensors;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u)),
  post: (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body),
  del: (url) => request(app).delete(`/api/v2${url}`).set('Cookie', cookie(u)),
});
const post = (key, body) => request(app).post('/api/v2/loom-sensor/reading').set('X-Device-Key', key).send(body);
// Factory time (IST).
const ist = (s) => new Date(`${s}+05:30`);
const epoch = (d) => Math.floor(d.getTime() / 1000);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  sensors = require('../../services/loomSensor');
  M = {};
  for (const n of ['User', 'Machine', 'LoomDevice', 'LoomReading', 'Employee', 'JobOrder', 'Customer', 'Order', 'Elastic', 'ShiftDetail', 'ShiftPlan', 'ProductionSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ls@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await M.User.create({ name: 'Sup', email: 'ls2@t.co', password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
const loom = () => { n += 1; return M.Machine.create({ ID: `S${n}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'free', elastics: [] }); };

describe('the boards', () => {
  it('are added by the admin, the key shown once and kept only as a hash', async () => {
    const m = await loom();
    expect((await as(supervisor).post('/loom-sensor/devices', { machine: String(m._id) })).status).toBe(403);
    const res = await as(admin).post('/loom-sensor/devices', { machine: String(m._id), name: 'ESP32 by the panel' });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^ld_[0-9a-f]{12}\.[\w-]{32}$/);
    expect(res.body.device).toMatchObject({ machine: { ID: m.ID }, name: 'ESP32 by the panel', active: true, live: false });
    const stored = await M.LoomDevice.findById(res.body.device.id).select('+keyHash').lean();
    expect(stored.keyHash).not.toContain(res.body.key.split('.')[1]);
    expect(JSON.stringify((await as(admin).get('/loom-sensor/devices')).body)).not.toContain(res.body.key.split('.')[1]);
    // One board a loom.
    expect((await as(admin).post('/loom-sensor/devices', { machine: String(m._id) })).status).toBe(409);
  });

  it('post with the key; a new key retires the old; a removed board is refused', async () => {
    const m = await loom();
    const { body } = await as(admin).post('/loom-sensor/devices', { machine: String(m._id) });
    expect((await post(body.key, { runSecondsTotal: 100 })).status).toBe(200);
    expect((await post(`${body.key}x`, { runSecondsTotal: 100 })).status).toBe(401);
    expect((await request(app).post('/api/v2/loom-sensor/reading').send({ runSecondsTotal: 1 })).status).toBe(401);

    const rotated = await as(admin).post(`/loom-sensor/devices/${body.device.id}/key`);
    expect((await post(body.key, { runSecondsTotal: 160 })).status).toBe(401);
    expect((await post(rotated.body.key, { runSecondsTotal: 160 })).status).toBe(200);
    expect((await as(admin).get('/loom-sensor/devices')).body.devices[0]).toMatchObject({ live: true, lastReading: { runSecondsTotal: 160 } });

    await as(admin).del(`/loom-sensor/devices/${body.device.id}`);
    expect((await post(rotated.body.key, { runSecondsTotal: 200 })).status).toBe(401);
  });

  it('send a batch kept offline; a repeat is one reading; a bad one is refused on its own', async () => {
    const m = await loom();
    const { body } = await as(admin).post('/loom-sensor/devices', { machine: String(m._id) });
    const now = Date.now();
    const at = (minAgo) => Math.floor((now - minAgo * 60_000) / 1000);
    const res = await post(body.key, { firmware: 'loom-sensor 1.0', readings: [
      { at: at(3), runSecondsTotal: 1000 }, { at: at(2), runSecondsTotal: 1060, picksTotal: 5000, running: true },
      { at: at(2), runSecondsTotal: 1060 }, { at: at(-60), runSecondsTotal: 1 }, { at: at(1), runSecondsTotal: -5 },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(2);
    expect(res.body.refused.map((r) => r.index)).toEqual([3, 4]);
    expect(res.body.refused[0].why).toMatch(/future/);
    expect(res.body.serverTime).toBeGreaterThan(0);
    expect(await M.LoomReading.countDocuments({ machine: m._id })).toBe(2);
    expect(await M.LoomDevice.findById(body.device.id).lean()).toMatchObject({ firmware: 'loom-sensor 1.0', lastReading: { runSecondsTotal: 1060, picksTotal: 5000, running: true } });
  });
});

describe('a shift\'s run time', () => {
  const start = ist('2026-10-21T08:00:00');
  const end = ist('2026-10-21T20:00:00');
  const r = (hhmm, total) => ({ at: ist(`2026-10-21T${hhmm}:00`), runSecondsTotal: total });

  it('is the rise across the shift, shared by time at the edges', () => {
    // 07:30 → 08:30 rose 3600: half of it before the shift.
    expect(sensors.runSecondsBetween([r('07:30', 0), r('08:30', 3600)], start, end)).toBe(1800);
    expect(sensors.runSecondsBetween([r('08:00', 500), r('12:00', 500 + 4 * 3600)], start, end)).toBe(4 * 3600);
  });

  it('counts a restart from zero, and never more than the time between posts', () => {
    // Restarted at 10:00: the new total (600) is all run since.
    expect(sensors.runSecondsBetween([r('08:00', 9000), r('09:00', 12600), r('10:10', 600)], start, end)).toBe(3600 + 600);
    // A garbled jump of a day in a minute is held to the minute (and a little slack).
    expect(sensors.runSecondsBetween([r('09:00', 0), r('09:01', 86400)], start, end)).toBe(150);
  });

  it('is worked out per factory shift: day 08:00–20:00, night to 08:00 the next day', () => {
    const day = sensors.shiftWindow({ dateKey: '2026-10-21', shift: 'DAY' });
    expect(day.start.toISOString()).toBe('2026-10-21T02:30:00.000Z');
    const night = sensors.shiftWindow({ dateKey: '2026-10-21', shift: 'NIGHT' });
    expect(night.start.toISOString()).toBe('2026-10-21T14:30:00.000Z');
    expect(night.end.toISOString()).toBe('2026-10-22T02:30:00.000Z');
  });

  it('is given from the stored readings, with how much of the shift they cover', async () => {
    const m = await loom();
    const d = await M.LoomDevice.create({ machine: m._id, keyId: 'ld_test', keyHash: 'x' });
    await M.LoomReading.insertMany([r('07:55', 100), r('12:00', 100 + 3 * 3600), r('20:05', 100 + 7 * 3600 + 1800)].map((x) => ({ ...x, device: d._id, machine: m._id })));
    const run = await sensors.shiftRun(m._id, { dateKey: '2026-10-21', shift: 'DAY' });
    expect(run).toMatchObject({ complete: true });
    expect(run.seconds).toBeGreaterThan(7 * 3600);
    expect(run.seconds).toBeLessThan(7.5 * 3600);
    expect((await as(admin).get(`/loom-sensor/run?machine=${m._id}&date=2026-10-21&shift=DAY`)).body.run.runTime).toBe(run.runTime);
    expect(await sensors.shiftRun(m._id, { dateKey: '2026-10-22', shift: 'DAY' })).toBeNull();
  });
});
