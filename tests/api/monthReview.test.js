'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE MONTH IN PLAIN WORDS — services/monthCommentary.js
//
//    • sales, rate a metre, customers that moved, yarn cost a metre
//      woven, expense heads above their usual, overdue — against the
//      month before
//    • said by rule without a model; by the model when every number it
//      states is in the figures, and not used when it invents one
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockModel = null;
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockModel ? { messages: { create: async () => ({ content: [{ type: 'text', text: mockModel }], usage: { input_tokens: 10, output_tokens: 10 } }) } } : null),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const d = (s) => new Date(`${s}T12:00:00+05:30`);
const db = () => mongoose.connection;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  admin = await require('../../models/User.js').create({ name: 'Owner', email: 'mr@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const sun = new mongoose.Types.ObjectId(); const kay = new mongoose.Types.ObjectId();
  const inv = (date, customer, name, taxable, metres, paid = taxable * 1.05) => ({ status: 'issued', invoiceDate: d(date), dueDate: d(date), customer, buyer: { name }, totals: { taxable, grand: taxable * 1.05 }, paidAmount: paid, lines: [{ name: '25mm Black', unit: 'm', quantity: metres, taxable }] });
  await db().collection('invoices').insertMany([
    inv('2026-09-10', sun, 'Sunrise Garments', 100000, 25000),
    inv('2026-09-20', kay, 'Kay Knits', 50000, 12500),
    inv('2026-10-08', sun, 'Sunrise Garments', 180000, 40000, 0),
  ]);
  await db().collection('supplierbills').insertMany([{ status: 'open', billDate: d('2026-10-03'), totals: { taxable: 90000 } }, { status: 'open', billDate: d('2026-09-03'), totals: { taxable: 60000 } }]);
  const ex = (date, categoryName, grand) => ({ status: 'paid', date: d(date), categoryName, totals: { grand } });
  await db().collection('expenses').insertMany([ex('2026-07-05', 'Power', 40000), ex('2026-08-05', 'Power', 42000), ex('2026-09-05', 'Power', 41000), ex('2026-10-05', 'Power', 70000), ex('2026-10-06', 'Repairs', 15000)]);
  await db().collection('materialoutwards').insertMany([
    { outwardDate: d('2026-09-12'), quantity: 100, unitPrice: 220 }, { outwardDate: d('2026-10-12'), quantity: 150, unitPrice: 240 },
    { outwardDate: d('2026-10-13'), quantity: 500, unitPrice: 240, reversed: true },
  ]);
  await db().collection('shiftdetails').insertMany([
    { status: 'closed', date: d('2026-09-12'), productionMeters: 20000 }, { status: 'closed', date: d('2026-10-12'), productionMeters: 30000 },
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => { mockModel = null; });

describe('the month in plain words', () => {
  it('computes the month against the one before and says it by rule', async () => {
    const res = await request(app).get('/api/v2/accounts/month-review?month=2026-10').set('Cookie', cookie());
    expect(res.status).toBe(200);
    const f = res.body.figures;
    expect(f.sales).toMatchObject({ taxable: 180000, previous: 150000, change: 20, metres: 40000, ratePerMetre: 4.5, previousRatePerMetre: 4 });
    expect(f.customerMoves).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Sunrise Garments', change: 80 }), expect.objectContaining({ name: 'Kay Knits', now: 0, change: -100 })]));
    expect(f.purchases).toMatchObject({ taxable: 90000, change: 50 });
    expect(f.yarn).toMatchObject({ kg: 150, value: 36000, metresWoven: 30000, perMetre: 1.2, previousPerMetre: 1.1, change: 9.1 });
    expect(f.expenses.unusual).toEqual([{ name: 'Power', amount: 70000, usual: 41000 }, { name: 'Repairs', amount: 15000, usual: 0 }]);
    expect(f.overdue.amount).toBe(189000);
    expect(res.body.by).toBe('rules');
    expect(res.body.points).toEqual([
      'Sales ₹1,80,000 — up 20% on September 2026, 40,000 m invoiced.',
      'Average rate ₹4.5/m against ₹4/m — the mix moved.',
      'Sunrise Garments up 80% to ₹1,80,000.',
      'Kay Knits bought nothing this month (₹50,000 last month).',
      'Yarn cost ₹1.2 a metre woven (up 9.1%).',
      'Power: ₹70,000 against a usual ₹41,000.',
    ]);
  });

  it('uses the model\'s lines only when every number in them is in the figures', async () => {
    mockModel = '- Sales up 20% to ₹1,80,000, all from Sunrise Garments\n- Kay Knits bought nothing\n- Power ₹70,000 against ₹41,000 usual';
    let r = (await request(app).get('/api/v2/accounts/month-review?month=2026-10').set('Cookie', cookie())).body;
    expect(r.by).toBe('model');
    expect(r.points[0]).toBe('Sales up 20% to ₹1,80,000, all from Sunrise Garments');
    mockModel = '- Sales up 35% to ₹2,40,000\n- Margins improved to 18%';
    r = (await request(app).get('/api/v2/accounts/month-review?month=2026-10').set('Cookie', cookie())).body;
    expect(r.by).toBe('rules');
    expect((await request(app).get('/api/v2/accounts/month-review?month=2026-13').set('Cookie', cookie())).status).toBe(400);
  });
});
