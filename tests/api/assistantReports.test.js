'use strict';
// ══════════════════════════════════════════════════════════════════
//  ASK JARVIS → THE REPORT ENGINE
//
//  Any figure across the business, asked in words, answered by a report
//  the asker may read — and handed back so the screen can open it.
//  The model is stubbed: what is tested is what the server does with
//  the query it writes, and who may see what.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockCreate = jest.fn();
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

let mongo, app, User, svc, admin, prod, acct;
const as = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const chat = (u, q) => request(app).post('/api/v2/assistant/chat').set('Cookie', as(u)).send({ messages: [{ role: 'user', content: q }] });

/** The model asks for one report, then answers. */
function modelRuns(sql, extra = {}) {
  mockCreate
    .mockResolvedValueOnce({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 't1', name: 'run_report', input: { sql, title: 'Stock by category', ...extra } }] })
    .mockResolvedValueOnce({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Warp yarn holds most of it. Open the report to download it.' }] });
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  svc = require('../../services/assistantReports');
  admin = await User.create({ name: 'Owner', email: 'jr1@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  prod = await User.create({ name: 'Sup', email: 'jr2@t.co', password: 'pass1234', role: 'production', department: 'production' });
  acct = await User.create({ name: 'Acct', email: 'jr3@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  const RawMaterial = require('../../models/RawMaterial');
  await RawMaterial.insertMany([
    { name: '40s black', category: 'warp', stock: 120, minStock: 50, price: 300 },
    { name: '40s white', category: 'warp', stock: 80, minStock: 50, price: 280 },
    { name: 'Rubber 42', category: 'rubber', stock: 30, minStock: 40, price: 500 },
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => mockCreate.mockReset());

describe('the report tool', () => {
  it('is described with only the datasets the asker may read', () => {
    const forProd = svc.toolFor(prod).description;
    expect(forProd).toMatch(/\bstock\b/);
    expect(forProd).not.toMatch(/\bsales\b.*taxable/);
    expect(svc.toolFor(acct).description).toMatch(/sales.*taxable/);
  });

  it('runs the query with the asker\'s role', async () => {
    const r = await svc.run({ sql: 'SELECT category, SUM(stock) FROM stock GROUP BY category' }, prod);
    expect(r.error).toBeUndefined();
    const warp = r.forModel.rows.find((x) => x.category === 'warp');
    expect(Object.values(warp)).toContain(200);
    expect(r.report.query.dataset).toBe('stock');
  });

  it('will not read money for production, however the question is put', async () => {
    const r = await svc.run({ sql: 'SELECT customer, SUM(taxable) FROM sales GROUP BY customer' }, prod);
    expect(r.error).toMatch(/not open to your role/i);
    expect(r.report).toBeUndefined();
  });

  it('says what is wrong with a query it cannot read, so the model can fix it', async () => {
    const r = await svc.run({ sql: 'DELETE FROM stock' }, admin);
    expect(r.error).toMatch(/did not read/i);
  });
});

describe('asking Jarvis', () => {
  it('answers from a report and hands the report back to open', async () => {
    modelRuns('SELECT category, SUM(value) AS value FROM stock GROUP BY category');
    const res = await chat(admin, 'What is our stock worth by category?');
    expect(res.status).toBe(200);
    expect(res.body.toolsUsed).toContain('run_report');
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0]).toMatchObject({ title: 'Stock by category', dataset: 'stock' });
    expect(res.body.reports[0].query.groupBy).toEqual(['category']);
    // The model was given the figures, not an error.
    const toolResult = JSON.parse(mockCreate.mock.calls[1][0].messages.at(-1).content[0].content);
    expect(toolResult.rowCount).toBe(2);
  });

  it('is not offered to a role the Reports page does not let in', async () => {
    const other = await User.create({ name: 'Mkt', email: 'jr4@t.co', password: 'pass1234', role: 'marketing', department: 'marketing' }).catch(() => null);
    if (!other) return; // no such role in this build
    mockCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] });
    await chat(other, 'sales by customer');
    const offered = (mockCreate.mock.calls[0][0].tools || []).map((t) => t.name);
    expect(offered).not.toContain('run_report');
  });

  it('is not offered when the account\'s features leave Reports out', async () => {
    const narrow = await User.create({ name: 'Narrow', email: 'jr5@t.co', password: 'pass1234', role: 'production', department: 'production', features: ['/orders'] });
    mockCreate.mockResolvedValueOnce({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'ok' }] });
    await chat(narrow, 'stock by category');
    const offered = (mockCreate.mock.calls[0][0].tools || []).map((t) => t.name);
    expect(offered).not.toContain('run_report');
    expect(offered).toContain('find_order');
  });
});
