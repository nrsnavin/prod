'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE MORNING BRIEFING
//
//  Found reading api/advisor.js line by line.
//
//  The cards a client sends are put into the prompt. Their number was
//  capped at eight "so input cost is capped regardless of client
//  behaviour" — their length was not: eight cards could carry megabytes.
//  And a card that was not an object (a null in the list) threw while
//  the prompt was being built, which was reported as the model's failure:
//  502 "ANTHROPIC_CALL_FAILED", and a failed call written to the AI
//  ledger for a call that was never made.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockCreate = jest.fn();
let mockOn = true;
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockOn ? { messages: { create: (...a) => mockCreate(...a) } } : null),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, AiSuggestion;
const brief = (cards) => request(app).post('/api/v2/advisor/briefing')
  .set('Cookie', [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`]).send({ cards });
const promptSent = () => mockCreate.mock.calls[0][0].messages[0].content;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  AiSuggestion = require('../../models/AiSuggestion.js');
  admin = await require('../../models/User.js').create({ name: 'Owner', email: 'adv@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => {
  mockOn = true;
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ model: 'test-text', usage: { input_tokens: 80, output_tokens: 30 }, content: [{ type: 'text', text: 'Three looms are down. **Call the fitter first.**' }] });
});
afterEach(async () => { await AiSuggestion.deleteMany({}); });

describe('the morning briefing', () => {
  it('is written from the cards sent (unchanged)', async () => {
    const res = await brief([{ id: 'a', title: '3 looms down', subtitle: 'L4, L7, L12', priority: 'high' }, { id: 'b', title: '2 orders late', subtitle: 'ORD-41, ORD-44' }]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, viaLlm: true, summary: 'Three looms are down. **Call the fitter first.**' });
    expect(promptSent()).toContain('- [high] 3 looms down (L4, L7, L12)');
    expect(promptSent()).toContain('- [med] 2 orders late (ORD-41, ORD-44)');
  });

  it('sets aside what is not a card, instead of failing as if the model had', async () => {
    const res = await brief([null, 'three looms down', 42, ['x'], { title: '3 looms down', subtitle: 'L4, L7, L12', priority: 'high' }]);
    // Before: 502 ANTHROPIC_CALL_FAILED, "Cannot read properties of null".
    expect(res.status).toBe(200);
    expect(res.body.viaLlm).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(promptSent().match(/^- \[/gm)).toHaveLength(1);
    // And no failed call on the AI ledger for a call that was made and worked.
    expect(await AiSuggestion.countDocuments({ surface: 'advisor-briefing', outcome: 'failed' })).toBe(0);
  });

  it('carries a card\'s words, not its megabytes', async () => {
    const res = await brief([{ title: 'T'.repeat(50_000), subtitle: 'S'.repeat(50_000), priority: 'P'.repeat(500) }, { title: { $gt: '' }, subtitle: 7 }]);
    expect(res.status).toBe(200);
    // Before: all of it went to the model.
    expect(promptSent().length).toBeLessThan(1200);
    expect(promptSent()).toContain(`${'T'.repeat(160)} (`);
    // Fields that are not text are not printed as "[object Object]".
    expect(promptSent()).not.toContain('[object Object]');
    expect(promptSent()).toContain('(7)');
  });

  it('takes at most eight (unchanged)', async () => {
    await brief(Array.from({ length: 30 }, (_, i) => ({ title: `Signal ${i + 1}`, subtitle: 'x' })));
    expect(promptSent().match(/^- \[/gm)).toHaveLength(8);
    expect(promptSent()).toContain('Signal 8');
    expect(promptSent()).not.toContain('Signal 9');
  });

  it('asks the model nothing when there is nothing to say', async () => {
    for (const cards of [[], [null, 'x'], [{ title: '   ', subtitle: '' }], 'not a list', undefined]) {
      const res = await brief(cards);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ viaLlm: false });
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('says so when no key is set, and when the call fails (unchanged)', async () => {
    mockOn = false;
    expect((await brief([{ title: 'x' }])).status).toBe(503);
    mockOn = true;
    mockCreate.mockRejectedValueOnce(new Error('overloaded'));
    const res = await brief([{ title: '3 looms down' }]);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe('ANTHROPIC_CALL_FAILED');
    expect(await AiSuggestion.countDocuments({ surface: 'advisor-briefing', outcome: 'failed' })).toBe(1);
  });
});
