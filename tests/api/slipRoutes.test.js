'use strict';
// The web side of production slips: list, look, correct, save, drop.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockRead = jest.fn();
jest.mock('../../utils/slipOcr', () => ({
  readSlip: (...a) => mockRead(...a),
  SUPPORTED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, svc, admin, accounts, ShiftDetail, details;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie(u)),
  post: (url, body) => request(app).post(url).set('Cookie', cookie(u)).send(body),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  svc = require('../../services/slipIngest');
  const User = require('../../models/User');
  const ShiftPlan = require('../../models/ShiftPlan');
  ShiftDetail = require('../../models/ShiftDetail');
  const Machine = require('../../models/Machine');
  const Employee = require('../../models/Employee');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  accounts = await User.create({ name: 'Books', email: 'b@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });

  const sp = await ShiftPlan.create({ date: new Date('2026-10-06'), shift: 'DAY' });
  details = [];
  for (let i = 1; i <= 2; i++) {
    const m = await Machine.create({ ID: `M-0${i}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'running', elastics: [] });
    const e = await Employee.create({ name: `Op ${i}`, department: 'weaving' });
    details.push(await ShiftDetail.create({
      date: new Date('2026-10-06'), shift: 'DAY', timer: '00:00:00', elastics: [],
      employee: e._id, shiftPlan: sp._id, machine: m._id, status: 'open',
    }));
  }
  await ShiftPlan.updateOne({ _id: sp._id }, { $set: { plan: details.map((d) => d._id) } });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const reading = (rows) => ({
  format: 'slip', planNo: null, date: null, shift: null, problem: null, model: 'm', usage: {}, latencyMs: 1, rows,
});
const r = (machine, over = {}) => ({ code: null, machine, operator: null, production: 1000, timer: '8:00:00', remarks: '', confidence: 0.95, ...over });

it('uploads photos, reads them, and shows the slip with its photo', async () => {
  const res = await request(app).post('/api/v2/slips/upload').set('Cookie', cookie(admin))
    .field('shift', 'DAY').field('dateKey', '2026-10-06')
    .attach('photos', Buffer.from('jpeg'), { filename: 'slip.jpg', contentType: 'image/jpeg' });
  expect(res.status).toBe(201);
  const { id } = res.body.slip;

  mockRead.mockResolvedValueOnce(reading([r('M-01'), r('M-02', { confidence: 0.3, production: 1080 })]));
  await svc.readSlipJob(id);

  const got = await as(admin).get(`/api/v2/slips/${id}`);
  expect(got.status).toBe(200);
  expect(got.body.slip).toMatchObject({ status: 'ready', dateKey: '2026-10-06', shift: 'DAY', dateFrom: 'caption' });
  expect(got.body.slip.counts).toMatchObject({ ready: 1, check: 1 });
  expect(got.body.slip.photos).toEqual([{ page: 0, contentType: 'image/jpeg', size: 4 }]);

  const photo = await as(admin).get(`/api/v2/slips/${id}/photo/0`);
  expect(photo.headers['content-type']).toBe('image/jpeg');
  expect(Buffer.from(photo.body).toString()).toBe('jpeg');

  const list = await as(admin).get('/api/v2/slips?status=open');
  expect(list.body.slips.map((s) => s.id)).toContain(id);

  // Correct the held row and save both.
  const saved = await as(admin).post(`/api/v2/slips/${id}/apply`, {
    expectedVersion: got.body.slip.version,
    rows: [
      { index: 0, include: true, production: 1000, timer: '8:00:00' },
      { index: 1, include: true, production: 1030, timer: '7:50:00', remarks: 'checked' },
    ],
  });
  expect(saved.status).toBe(200);
  expect(saved.body).toMatchObject({ saved: 2, remaining: 0 });
  expect(saved.body.slip.status).toBe('applied');
  expect((await ShiftDetail.findById(details[1]._id).lean()))
    .toMatchObject({ submittedProductionMeters: 1030, submittedTimer: '7:50:00', submittedFeedback: 'checked' });
});

it('a stale screen cannot save over a newer slip', async () => {
  const up = await request(app).post('/api/v2/slips/upload').set('Cookie', cookie(admin))
    .field('shift', 'DAY').field('dateKey', '2026-10-06')
    .attach('photos', Buffer.from('x'), { filename: 's.jpg', contentType: 'image/jpeg' });
  mockRead.mockResolvedValueOnce(reading([r('M-01')]));
  await svc.readSlipJob(up.body.slip.id);
  const res = await as(admin).post(`/api/v2/slips/${up.body.slip.id}/apply`, {
    expectedVersion: 999, rows: [{ index: 0, include: true, production: 1, timer: '1:00:00' }],
  });
  expect(res.status).toBe(409);
});

it('refuses a bad number and a file it cannot read', async () => {
  const up = await request(app).post('/api/v2/slips/upload').set('Cookie', cookie(admin))
    .field('shift', 'DAY').field('dateKey', '2026-10-06')
    .attach('photos', Buffer.from('x'), { filename: 's.jpg', contentType: 'image/jpeg' });
  mockRead.mockResolvedValueOnce(reading([r('M-02')]));
  await svc.readSlipJob(up.body.slip.id);
  const bad = await as(admin).post(`/api/v2/slips/${up.body.slip.id}/apply`, {
    rows: [{ index: 0, include: true, production: '12.5', timer: '1:00:00' }],
  });
  expect(bad.status).toBe(400);
  expect(bad.body.message).toMatch(/whole number/);

  const gif = await request(app).post('/api/v2/slips/upload').set('Cookie', cookie(admin))
    .attach('photos', Buffer.from('x'), { filename: 's.gif', contentType: 'image/gif' });
  expect(gif.status).toBe(400);
});

it('sets the shift on a slip that could not tell, and drops one', async () => {
  const up = await request(app).post('/api/v2/slips/upload').set('Cookie', cookie(admin))
    .attach('photos', Buffer.from('x'), { filename: 's.jpg', contentType: 'image/jpeg' });
  mockRead.mockResolvedValueOnce(reading([r('M-01')]));
  await svc.readSlipJob(up.body.slip.id);
  expect((await as(admin).get(`/api/v2/slips/${up.body.slip.id}`)).body.slip.status).toBe('failed');

  const set = await as(admin).post(`/api/v2/slips/${up.body.slip.id}/shift`, { dateKey: '2026-10-06', shift: 'DAY' });
  expect(set.status).toBe(200);
  expect(set.body.slip).toMatchObject({ status: 'ready', dateFrom: 'person' });

  const drop = await as(admin).post(`/api/v2/slips/${up.body.slip.id}/discard`, {});
  expect(drop.body.slip.status).toBe('discarded');
});

it('is closed to accounts', async () => {
  expect((await as(accounts).get('/api/v2/slips')).status).toBe(403);
});
