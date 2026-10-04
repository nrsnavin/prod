'use strict';
// ══════════════════════════════════════════════════════════════════
//  READING A LOOM'S TIMER FROM A PHOTO — api/timerOcr.js
//
//  Against a stand-in model, so nothing leaves the machine:
//    • a worker or supervisor sends a photo and gets every display back,
//      bounded and well-typed whatever the model said;
//    • a mockReply that isn't JSON reads as "no display", never a guess;
//    • no AI mockConfigured → 503 AI_UNAVAILABLE; no photo / wrong type → 400;
//    • the reading is recorded in the AI ledger, and settling it records
//      whether the person used it as read or changed it.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = '';
let mockConfigured = true;
const mockCreate = jest.fn(async () => ({ content: [{ type: 'text', text: mockReply }], usage: { input_tokens: 900, output_tokens: 60 } }));
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

let mongo, app, AiSuggestion, worker, finance;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const send = (u, file = PNG, type = 'image/png') =>
  request(app).post('/api/v2/ocr/timer').set('Cookie', cookie(u)).attach('photo', file, { filename: 'timer.png', contentType: type });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User');
  AiSuggestion = require('../../models/AiSuggestion');
  const { ALWAYS_ON } = require('../../utils/features');
  worker = await User.create({ name: 'Ravi', email: 'ravi@t.co', password: 'pass1234', role: 'production', department: 'production', features: [...ALWAYS_ON] });
  finance = await User.create({ name: 'Books', email: 'b@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => { mockConfigured = true; mockCreate.mockClear(); });

describe('reading a photo', () => {
  it('returns every display, with the run time marked, and sends the image to the model', async () => {
    mockReply = JSON.stringify({
      displays: [
        { text: '07:45:12', kind: 'run_time', label: 'RUN', confidence: 0.93, alternatives: ['01:45:12'] },
        { text: '58213', kind: 'counter', label: 'PICK', confidence: 0.8, alternatives: [] },
      ],
      primary: 0, problem: null,
    });
    const res = await send(worker);
    expect(res.status).toBe(200);
    expect(res.body.reading.primary).toBe(0);
    expect(res.body.reading.displays[0]).toEqual({ text: '07:45:12', kind: 'run_time', label: 'RUN', confidence: 0.93, alternatives: ['01:45:12'] });
    const content = mockCreate.mock.calls[0][0].messages[0].content;
    expect(content[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
  });

  it('bounds whatever the model says', async () => {
    mockReply = '```json\n' + JSON.stringify({
      displays: [
        { text: 'no digits here', kind: 'run_time' },
        { text: '1234.6', kind: 'weird', label: 'X'.repeat(80), confidence: 7, alternatives: ['a', 'b', 'c', 'd'] },
      ],
      primary: 9, problem: 'exploded',
    }) + '\n```';
    const { body } = await send(worker);
    expect(body.reading.displays).toHaveLength(1);
    expect(body.reading.displays[0]).toMatchObject({ text: '1234.6', kind: 'other', confidence: 1 });
    expect(body.reading.displays[0].label.length).toBeLessThanOrEqual(20);
    expect(body.reading.displays[0].alternatives).toHaveLength(3);
    expect(body.reading).toMatchObject({ primary: 0, problem: null });
  });

  it('reads a mockReply that is not JSON as "no display", never a guess', async () => {
    mockReply = 'I think it says about seven hours.';
    const { body } = await send(worker);
    expect(body.reading).toEqual({ displays: [], primary: null, problem: 'no_display' });
  });

  it('is open to accounts too, who also enter production', async () => {
    mockReply = JSON.stringify({ displays: [{ text: '6:30', kind: 'run_time', confidence: 0.9 }], primary: 0 });
    expect((await send(finance)).status).toBe(200);
  });
});

describe('refusals', () => {
  it('says so when AI is not set up', async () => {
    mockConfigured = false;
    const res = await send(worker);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
  });

  it('needs a photo, of a type the model can read', async () => {
    const none = await request(app).post('/api/v2/ocr/timer').set('Cookie', cookie(worker));
    expect(none.status).toBe(400);
    const gif = await send(worker, PNG, 'image/gif');
    expect(gif.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('needs a sign-in', async () => {
    expect((await request(app).post('/api/v2/ocr/timer')).status).toBe(401);
  });
});

describe('the accuracy record', () => {
  it('records the reading, and whether it was used as read', async () => {
    mockReply = JSON.stringify({ displays: [{ text: '07:45:12', kind: 'run_time', confidence: 0.95 }], primary: 0 });
    const { body } = await send(worker);
    const row = await AiSuggestion.findById(body.suggestionId).lean();
    expect(row).toMatchObject({ surface: 'timer-ocr', model: 'test-vision', outcome: 'proposed' });
    expect(row.proposed.runTime).toBe('7:45:12');

    const ok = await request(app).post(`/api/v2/ocr/timer/${body.suggestionId}/settle`).set('Cookie', cookie(worker)).send({ runTime: '07:45:12' });
    expect(ok.status).toBe(200);
    expect((await AiSuggestion.findById(body.suggestionId).lean()).outcome).toBe('accepted');
  });

  it('records an edit when the person changed it', async () => {
    mockReply = JSON.stringify({ displays: [{ text: '07:45:12', kind: 'run_time', confidence: 0.6 }], primary: 0 });
    const { body } = await send(worker);
    await request(app).post(`/api/v2/ocr/timer/${body.suggestionId}/settle`).set('Cookie', cookie(worker)).send({ runTime: '1:45:12' });
    expect((await AiSuggestion.findById(body.suggestionId).lean()).outcome).toBe('edited');
  });

  it('refuses a run time that is not one', async () => {
    mockReply = JSON.stringify({ displays: [{ text: '7:45', kind: 'run_time', confidence: 0.9 }], primary: 0 });
    const { body } = await send(worker);
    const bad = await request(app).post(`/api/v2/ocr/timer/${body.suggestionId}/settle`).set('Cookie', cookie(worker)).send({ runTime: 'soon' });
    expect(bad.status).toBe(400);
  });
});
