'use strict';
// ══════════════════════════════════════════════════════════════════
//  PETTY CASH IN ONE LINE (services/cashLine.js)
//
//  "Paid 350 auto for yarn" becomes a cash expense draft: amount, day,
//  description and head. Rules read it first; the model is asked only
//  when they cannot, and picks a head from the firm's own list. The model
//  is a stand-in here: these pin what is asked of it and what is done
//  with its answer.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockCreate = jest.fn();
let mockClient = null;
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => mockClient, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const { byRules } = require('../../services/cashLine');
const bizDates = require('../../utils/bizDates');

let mongo, app, M, admin, heads;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const line = (text) => post('/accounts/expenses/from-line', { text });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'ExpenseCategory', 'Expense', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'cashline@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  mockClient = null; mockCreate.mockReset();
  heads = {};
  for (const name of ['Conveyance', 'Staff welfare', 'Courier charges', 'Printing & stationery', 'Power & fuel', 'Freight inward']) heads[name] = await M.ExpenseCategory.create({ name, approvalAbove: 5000 });
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

describe('the rules', () => {
  const today = bizDates.at(2026, 11, 13);
  const iso = (d) => d.toISOString().slice(0, 10);
  it('the amount, the day and what it was for', () => {
    expect(byRules('Paid 350 auto for yarn', today)).toMatchObject({ amount: 350, description: 'Auto for yarn', payee: '' });
    expect(iso(byRules('Paid 350 auto for yarn', today).date)).toBe('2026-11-13');
    const c = byRules('courier to Tiruppur 90 yesterday', today);
    expect(c).toMatchObject({ amount: 90, description: 'Courier to Tiruppur' });
    expect(iso(c.date)).toBe('2026-11-12');
    expect(byRules('Diesel for generator ₹1,250', today).amount).toBe(1250);
    expect(byRules('Rs.75 xerox', today)).toMatchObject({ amount: 75, description: 'Xerox' });
    expect(byRules('tea 120/-', today).amount).toBe(120);
  });
  it('a dd/mm day, never in the future; a phone number is no amount; "paid to" names the payee', () => {
    const x = byRules('xerox 40 on 10/11', today);
    expect(x.amount).toBe(40);
    expect(iso(x.date)).toBe('2026-11-10');
    expect(iso(byRules('xerox 40 on 20/11', today).date)).toBe('2026-11-13');
    expect(byRules('called 9876543210 for the plumber', today).amount).toBeNull();
    expect(byRules('paid to Murugan 500 for loading', today)).toMatchObject({ amount: 500, payee: 'Murugan' });
  });
});

describe('a line read into a draft', () => {
  it('the head of the kind its words point to, by the rules alone', async () => {
    const res = await line('Paid 350 auto for yarn');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ by: 'rules', problems: [] });
    expect(res.body.draft).toMatchObject({ amount: 350, description: 'Auto for yarn', category: { _id: String(heads.Conveyance._id), name: 'Conveyance' }, reason: '“auto” goes under Conveyance' });
    expect(mockCreate).not.toHaveBeenCalled();
    // Logged, so how often it is kept can be counted.
    expect(await M.AiSuggestion.countDocuments({ surface: 'cash-line', model: 'rules' })).toBe(1);
  });

  it('a head the line names; a head learned from how past entries were filed', async () => {
    expect((await line('courier charges 90')).body.draft.category.name).toBe('Courier charges');
    for (const d of ['Auto for yarn bags', 'Auto for yarn to warping']) await post('/accounts/expenses', { category: heads['Freight inward']._id, description: d, date: '2026-11-01', amount: 200 });
    const learned = (await line('Paid 350 auto for yarn')).body.draft;
    expect(learned.category.name).toBe('Freight inward');
    expect(learned.reason).toBe('Expenses described like this were Freight inward 2 times out of 2');
  });

  it('the model, only for what the rules cannot read: a head from our list, with structured output', async () => {
    mockClient = { messages: { create: mockCreate } };
    mockCreate.mockResolvedValue({ stop_reason: 'end_turn', usage: { input_tokens: 80, output_tokens: 30 }, content: [{ type: 'text', text: JSON.stringify({ amount: 300, day: 'yesterday', description: 'Tea for the night shift', payee: '', head: 'Staff welfare' }) }] });
    const res = await line('munnooru roobaai night shift ku');
    expect(res.body.by).toBe('model');
    expect(res.body.draft).toMatchObject({ amount: 300, description: 'Tea for the night shift', category: { name: 'Staff welfare' }, reason: 'suggested from the line' });
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.model).toBe('claude-opus-5-5');
    expect(sent.output_config.effort).toBe('low');
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(sent.output_config.format.schema.properties.head.anyOf[0].enum).toEqual(['Conveyance', 'Courier charges', 'Freight inward', 'Power & fuel', 'Printing & stationery', 'Staff welfare']);
    expect(sent.thinking).toBeUndefined();
  });

  it('a head the model makes up is not taken; a refusal or no AI key leaves the rules\' draft and says what is missing', async () => {
    mockClient = { messages: { create: mockCreate } };
    mockCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: JSON.stringify({ amount: null, day: null, description: 'Something', payee: '', head: 'Entertainment' }) }] });
    expect((await line('something odd 45')).body).toMatchObject({ draft: { amount: 45, category: null }, problems: ['No expense head fits: pick one'] });
    mockCreate.mockResolvedValueOnce({ stop_reason: 'refusal', usage: {}, content: [] });
    expect((await line('odd thing, no figure')).body.problems).toEqual(['No amount was found: type it in', 'No expense head fits: pick one']);
    mockClient = null;
    expect((await line('tea')).body).toMatchObject({ by: 'rules', draft: { amount: null, category: { name: 'Staff welfare' } }, problems: ['No amount was found: type it in'] });
    expect((await line('')).status).toBe(400);
  });

  it('the expense saved from it scores the line: kept as read, or which fields were changed', async () => {
    const r = (await line('Paid 350 auto for yarn')).body;
    const saved = await post('/accounts/expenses', { category: r.draft.category._id, description: r.draft.description, date: r.draft.date, amount: 350, source: 'line', aiSuggestion: r.aiSuggestion });
    expect(saved.status).toBe(201);
    expect(saved.body.expense.source).toBe('line');
    await new Promise((ok) => setTimeout(ok, 50));
    expect((await M.AiSuggestion.findById(r.aiSuggestion).lean()).outcome).toBe('accepted');
    const r2 = (await line('tea 120')).body;
    await post('/accounts/expenses', { category: r2.draft.category._id, description: 'Tea and biscuits', date: r2.draft.date, amount: 150, source: 'line', aiSuggestion: r2.aiSuggestion });
    await new Promise((ok) => setTimeout(ok, 50));
    expect((await M.AiSuggestion.findById(r2.aiSuggestion).lean())).toMatchObject({ outcome: 'edited', editedFields: expect.arrayContaining(['amount', 'description']) });
  });
});
