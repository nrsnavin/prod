'use strict';
// ══════════════════════════════════════════════════════════════════
//  TIMER PHOTOS KEPT FOR VERIFICATION — api/timerOcr.js
//
//  A photo taken for a shift is kept with it, read or not, so whoever
//  verifies the entry sees the display the run time came from:
//    • kept before it is read, so a photo taken while reading is down or
//      not set up is still there, and the caller is told so;
//    • a worker attaches photos to, and sees photos of, their own shifts
//      only; a supervisor any shift;
//    • the photo the run time was filled from is marked, one per shift,
//      and its reading settled in the AI ledger.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = '';
let mockConfigured = true;
let mockFail = null;
const mockCreate = jest.fn(async () => {
  if (mockFail) throw mockFail;
  return { content: [{ type: 'text', text: mockReply }], usage: { input_tokens: 900, output_tokens: 60 } };
});
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockConfigured ? { messages: { create: (...a) => mockCreate(...a) } } : null),
  VISION_MODEL: 'test-vision',
  TEXT_MODEL: 'test-text',
  isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, TimerPhoto, AiSuggestion, supervisor, ravi, kumar, raviShift, kumarShift;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const send = (u, shiftId, file = PNG, type = 'image/png') => {
  const r = request(app).post('/api/v2/ocr/timer').set('Cookie', cookie(u));
  if (shiftId) r.field('shiftId', String(shiftId));
  return r.attach('photo', file, { filename: 'timer.png', contentType: type });
};
const get = (u, url) => request(app).get(url).set('Cookie', cookie(u));
const reads = (text) => { mockReply = JSON.stringify({ displays: [{ text, kind: 'run_time', confidence: 0.95 }], primary: 0 }); };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  const Employee = require('../../models/Employee');
  const ShiftDetail = require('../../models/ShiftDetail');
  TimerPhoto = require('../../models/TimerPhoto');
  AiSuggestion = require('../../models/AiSuggestion');
  const { ALWAYS_ON } = require('../../utils/features');

  const raviEmp = await Employee.create({ name: 'Ravi', department: 'weaving' });
  const kumarEmp = await Employee.create({ name: 'Kumar', department: 'weaving' });
  const worker = (name, emp) => User.create({
    name, email: `${name}@t.co`, password: 'pass1234', role: 'production', department: 'production',
    features: [...ALWAYS_ON], employee: emp._id,
  });
  ravi = await worker('Ravi', raviEmp);
  kumar = await worker('Kumar', kumarEmp);
  supervisor = await User.create({ name: 'Sup', email: 'sup@t.co', password: 'pass1234', role: 'production', department: 'production' });
  const shift = (emp) => ShiftDetail.create({
    date: new Date(), shift: 'DAY', status: 'open', employee: emp._id,
    shiftPlan: new mongoose.Types.ObjectId(), machine: new mongoose.Types.ObjectId(),
  });
  raviShift = await shift(raviEmp);
  kumarShift = await shift(kumarEmp);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  mockConfigured = true; mockFail = null; mockCreate.mockClear();
  await TimerPhoto.deleteMany({});
});

describe('keeping the photo with the shift', () => {
  it('keeps a worker\'s photo of their own shift, with what was read', async () => {
    reads('07:45:12');
    const res = await send(ravi, raviShift._id);
    expect(res.status).toBe(200);
    expect(res.body.photoId).toEqual(expect.any(String));
    const kept = await TimerPhoto.findById(res.body.photoId).select('+data').lean();
    expect(kept).toMatchObject({ contentType: 'image/png', size: PNG.length, uploadedByName: 'Ravi', readText: '07:45:12', readKind: 'run_time', used: false });
    expect(String(kept.shift)).toBe(String(raviShift._id));
    expect(kept.data).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(String(kept.suggestion)).toBe(res.body.suggestionId);
  });

  it('keeps it even when reading is not set up, and says it was kept', async () => {
    mockConfigured = false;
    const res = await send(ravi, raviShift._id);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'AI_UNAVAILABLE', details: { photoId: expect.any(String) } });
    expect(await TimerPhoto.findById(res.body.details.photoId).lean()).toMatchObject({ readProblem: 'not_set_up', readText: null });
  });

  it('keeps it when the reading fails part-way', async () => {
    mockFail = Object.assign(new Error('AI is busy'), { statusCode: 503, code: 'AI_BUSY' });
    const res = await send(ravi, raviShift._id);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'AI_BUSY', details: { photoId: expect.any(String) } });
    expect(await TimerPhoto.countDocuments({ shift: raviShift._id, readProblem: 'not_read' })).toBe(1);
  });

  it('refuses a worker attaching a photo to someone else\'s shift, and keeps nothing', async () => {
    reads('07:45');
    const res = await send(ravi, kumarShift._id);
    expect(res.status).toBe(404);
    expect(await TimerPhoto.countDocuments({})).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('lets a supervisor attach a photo to any shift', async () => {
    reads('07:45');
    expect((await send(supervisor, kumarShift._id)).status).toBe(200);
    expect(await TimerPhoto.countDocuments({ shift: kumarShift._id })).toBe(1);
  });

  it('keeps nothing without a shift, as before', async () => {
    reads('07:45');
    const res = await send(supervisor, null);
    expect(res.status).toBe(200);
    expect(res.body.photoId).toBeNull();
    expect(await TimerPhoto.countDocuments({})).toBe(0);
  });

  it('refuses a bad shift id, and a file that is not a photo', async () => {
    expect((await send(supervisor, 'nope')).status).toBe(404);
    expect((await send(supervisor, raviShift._id, PNG, 'image/gif')).status).toBe(400);
    expect(await TimerPhoto.countDocuments({})).toBe(0);
  });
});

describe('the photo the run time came from', () => {
  it('is marked, one per shift, and its reading settled', async () => {
    reads('07:45:12');
    const first = (await send(ravi, raviShift._id)).body;
    const second = (await send(ravi, raviShift._id)).body;
    const use = (id, runTime) => request(app).post(`/api/v2/ocr/timer/photo/${id}/use`).set('Cookie', cookie(ravi)).send({ runTime });

    expect((await use(first.photoId, '7:45:12')).status).toBe(200);
    expect((await use(second.photoId, '7:40:00')).status).toBe(200);
    const photos = await TimerPhoto.find({ shift: raviShift._id }).lean();
    expect(photos.filter((p) => p.used).map((p) => String(p._id))).toEqual([second.photoId]);
    expect(photos.find((p) => p.used).runTimeUsed).toBe('7:40:00');
    expect((await AiSuggestion.findById(second.suggestionId).lean()).outcome).toBe('edited');
  });

  it('cannot be marked by another worker, or with a run time that is not one', async () => {
    reads('07:45');
    const { photoId } = (await send(ravi, raviShift._id)).body;
    expect((await request(app).post(`/api/v2/ocr/timer/photo/${photoId}/use`).set('Cookie', cookie(kumar)).send({ runTime: '7:45' })).status).toBe(404);
    expect((await request(app).post(`/api/v2/ocr/timer/photo/${photoId}/use`).set('Cookie', cookie(ravi)).send({ runTime: 'soon' })).status).toBe(400);
    expect((await TimerPhoto.findById(photoId).lean()).used).toBe(false);
  });
});

describe('seeing the photos when verifying', () => {
  it('lists a shift\'s photos newest first, without the bytes, and serves each one', async () => {
    reads('07:45');
    const a = (await send(ravi, raviShift._id)).body.photoId;
    mockConfigured = false;
    const b = (await send(ravi, raviShift._id)).body.details.photoId;

    const list = await get(supervisor, `/api/v2/ocr/timer/shift/${raviShift._id}/photos`);
    expect(list.status).toBe(200);
    expect(list.body.photos.map((p) => p.id)).toEqual([b, a]);
    expect(list.body.photos[1]).toMatchObject({ takenBy: 'Ravi', readText: '07:45', used: false });
    expect(list.body.photos[0]).toMatchObject({ readProblem: 'not_set_up' });
    expect(JSON.stringify(list.body)).not.toContain('base64');

    const file = await get(supervisor, `/api/v2/ocr/timer/photo/${a}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(file.body, PNG)).toBe(0);
  });

  it('shows a worker their own shift\'s photos and nobody else\'s', async () => {
    reads('07:45');
    const { photoId } = (await send(ravi, raviShift._id)).body;
    expect((await get(ravi, `/api/v2/ocr/timer/shift/${raviShift._id}/photos`)).status).toBe(200);
    expect((await get(kumar, `/api/v2/ocr/timer/shift/${raviShift._id}/photos`)).status).toBe(404);
    expect((await get(kumar, `/api/v2/ocr/timer/photo/${photoId}/file`)).status).toBe(404);
    expect((await get(supervisor, '/api/v2/ocr/timer/photo/nope/file')).status).toBe(404);
  });
});

describe('how long photos are kept', () => {
  const { expiryFrom } = require('../../models/TimerPhoto');
  const now = new Date('2026-10-05T00:00:00Z');
  it('is 365 days unless set, and forever at 0', () => {
    expect(expiryFrom(now, undefined).toISOString()).toBe('2027-10-05T00:00:00.000Z');
    expect(expiryFrom(now, '').toISOString()).toBe('2027-10-05T00:00:00.000Z');
    expect(expiryFrom(now, '365d').toISOString()).toBe('2027-10-05T00:00:00.000Z');
    expect(expiryFrom(now, '30').toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(expiryFrom(now, '0')).toBeNull();
  });
});
