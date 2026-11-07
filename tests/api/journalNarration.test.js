'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NARRATION FOR A JOURNAL
//
//    • a plain one by rule, from the lines, always
//    • the house's own wording for the same ledgers first, once used
//    • the model's line only when every amount in it is on the journal
//    • the narration posted scores the suggestions
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = null;
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockReply ? { messages: { create: async () => ({ content: [{ type: 'text', text: mockReply }], usage: { input_tokens: 5, output_tokens: 5 } }) } } : null),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, AiSuggestion;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const lines = [{ kind: 'ledger', ledger: 'Freight Outward', debit: 4200 }, { kind: 'ledger', ledger: 'Freight Payable', credit: 4200 }];
const suggest = (body) => request(app).post('/api/v2/accounts/journals/narration').set('Cookie', cookie()).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  admin = await require('../../models/User.js').create({ name: 'Owner', email: 'jn@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  AiSuggestion = require('../../models/AiSuggestion.js');
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('a journal narration', () => {
  it('suggests a plain one from the lines when there is nothing else', async () => {
    const r = await suggest({ lines, purpose: 'accrual' });
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toEqual([{ text: 'Being ₹4,200 provided for Freight Outward, payable to Freight Payable', from: 'rule' }]);
  });

  it('offers the house\'s own wording for the same ledgers first, and scores what was posted', async () => {
    const first = await suggest({ lines, purpose: 'accrual' });
    const posted = await request(app).post('/api/v2/accounts/journals').set('Cookie', cookie())
      .send({ date: '2026-11-05', purpose: 'accrual', reason: 'October freight not yet billed', narration: 'Being October freight to VRL provided', lines, aiSuggestion: first.body.aiSuggestion });
    expect(posted.status).toBe(201);
    expect((await AiSuggestion.findById(first.body.aiSuggestion).lean()).outcome).toBe('edited');
    const again = await suggest({ lines: [{ ...lines[0], debit: 3900 }, { ...lines[1], credit: 3900 }], purpose: 'accrual' });
    expect(again.body.suggestions[0]).toEqual({ text: 'Being October freight to VRL provided', from: 'past' });
  });

  it('takes the model\'s line only when its amounts are on the journal', async () => {
    mockReply = 'Being freight of ₹4,200 for October provided for';
    let r = await suggest({ lines: [{ kind: 'ledger', ledger: 'Freight Outward', debit: 4200 }, { kind: 'ledger', ledger: 'VRL Logistics', credit: 4200 }] });
    expect(r.body.suggestions.map((s) => s.from)).toEqual(['model', 'rule']);
    mockReply = 'Being freight of ₹5,000 provided';
    r = await suggest({ lines: [{ kind: 'ledger', ledger: 'Freight Outward', debit: 4200 }, { kind: 'ledger', ledger: 'VRL Logistics', credit: 4200 }] });
    expect(r.body.suggestions.map((s) => s.from)).toEqual(['rule']);
    mockReply = null;
    expect((await suggest({ lines: [lines[0]] })).status).toBe(400);
  });
});
