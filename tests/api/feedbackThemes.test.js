'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE WORKERS KEEP RAISING
//
//  Counts always; themes once there is enough to group — and nobody's
//  name goes to the model or comes back with a theme.
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

let mongo, app, admin, prod, Feedback, svc, emp;
const as = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Feedback = require('../../models/EmployeeFeedback');
  svc = require('../../services/feedbackThemes');
  const User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'ft@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  prod = await User.create({ name: 'Sup', email: 'ft2@t.co', password: 'pass1234', role: 'production', department: 'production' });
  emp = await require('../../models/Employee').create({ name: 'Selvaraj Muthu' });
  const notes = [
    ...Array.from({ length: 6 }, (_, i) => ({ type: 'complaint', category: 'facilities', subject: 'Too hot near loom row 3', body: `No fans working, day ${i}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'suggestion', category: 'facilities', subject: 'Canteen at night', body: `Please keep canteen open for night shift ${i}` })),
    { type: 'complaint', category: 'payroll', subject: 'OT not paid', body: 'My overtime from last week is missing' },
    { type: 'complaint', category: 'payroll', subject: 'OT short', body: 'Overtime hours less than worked' },
    { type: 'complaint', category: 'safety', subject: 'Guard broken', body: 'The guard on loom 12 is broken' },
  ];
  await Feedback.insertMany(notes.map((n, i) => ({ ...n, employee: emp._id, isAnonymous: i % 2 === 0 })));
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(() => mockCreate.mockReset());

describe('feedback themes', () => {
  it('groups what was written, counting it here', async () => {
    mockCreate.mockResolvedValueOnce({ usage: {}, content: [{ type: 'text', text: JSON.stringify({ themes: [
      { label: 'Heat and no fans near loom row 3', members: [7, 8, 9, 10, 11, 12] },
      { label: 'Overtime missing from pay', members: [1, 2] },
      { label: 'Made up', members: [99] },
    ] }) }] });
    const res = await request(app).get('/api/v2/feedback/themes?days=30').set('Cookie', as(admin));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.total).toBe(13);
    expect(d.byCategory).toMatchObject({ facilities: 10, payroll: 2, safety: 1 });
    expect(d.themes.map((t) => t.label)).toEqual(['Heat and no fans near loom row 3', 'Overtime missing from pay']);
    expect(d.themes[0].count).toBe(6);
    expect(d.ungrouped).toBe(5);
  });

  it('never sends a name to the model', async () => {
    mockCreate.mockResolvedValueOnce({ usage: {}, content: [{ type: 'text', text: '{"themes":[]}' }] });
    await svc.analyse({ days: 30 });
    const sent = JSON.stringify(mockCreate.mock.calls[0][0]);
    expect(sent).not.toMatch(/Selvaraj/);
    expect(sent).not.toMatch(String(emp._id));
  });

  it('quotes examples only from themes big enough not to point at anyone', async () => {
    mockCreate.mockResolvedValueOnce({ usage: {}, content: [{ type: 'text', text: JSON.stringify({ themes: [{ label: 'Heat', members: [7, 8, 9] }, { label: 'Guard', members: [0] }] }) }] });
    const d = await svc.analyse({ days: 30 });
    expect(d.themes.find((t) => t.label === 'Heat').examples.length).toBeGreaterThan(0);
    expect(d.themes.find((t) => t.label === 'Guard').examples).toEqual([]);
  });

  it('gives counts, and says why there are no themes, when there are too few notes', async () => {
    const d = await svc.analyse({ days: 30, minForThemes: 50 });
    expect(d.belowThreshold).toBe(true);
    expect(d.themes).toBeNull();
    expect(d.note).toMatch(/Themes start at 50/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('is the admin\'s', async () => {
    expect((await request(app).get('/api/v2/feedback/themes').set('Cookie', as(prod))).status).toBe(403);
  });
});
