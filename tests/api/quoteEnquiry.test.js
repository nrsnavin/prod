'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN ENQUIRY, DRAFTED INTO A QUOTE
//
//    • the message read into items; each matched to the elastic on file
//      (25mm never to 20mm); its cost from the recipe at today's prices
//    • the margin from what this customer accepted before, with why; a
//      lower one they declined is said; their target rate is put against
//      the cost
//    • a cover note from those figures; nothing saved; the quote created
//      from it scores the draft
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = {};
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(mockReply) }], usage: { input_tokens: 10, output_tokens: 10 } }) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, cust, e25;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'RawMaterial', 'Quote', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'enq@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  cust = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('customers').insertOne({ _id: cust, name: 'Sunrise Garments' });
  const spandex = await M.RawMaterial.create({ name: 'Spandex 840D', category: 'rubber', price: 900, stock: 0 });
  const pc = await M.RawMaterial.create({ name: '40s PC Black', category: 'warp', price: 220, stock: 0 });
  e25 = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('elastics').insertMany([
    { _id: e25, name: '25mm Knitted Elastic - Black', warpSpandex: { id: spandex._id, weight: 1 }, warpYarn: [{ id: pc._id, weight: 5 }] },
    { name: '20mm Knitted Elastic - Black', warpYarn: [{ id: pc._id, weight: 4 }] },
  ]);
  // Cost a metre: 0.9 + 1.1 + 1.25 conversion = 3.25. Accepted at 20%, declined at 12%.
  const line = (rate) => ({ elastic: e25, productName: '25mm', materials: [], totalCost: 3.25, rateBeforeTax: rate, quantityMetres: 1000 });
  await mongoose.connection.collection('quotes').insertMany([
    { quoteNo: 'Q/1', customer: cust, customerName: 'Sunrise Garments', status: 'accepted', date: new Date(Date.now() - 30 * 86_400_000), lines: [line(3.9)] },
    { quoteNo: 'Q/2', customer: cust, customerName: 'Sunrise Garments', status: 'declined', date: new Date(Date.now() - 10 * 86_400_000), lines: [line(3.64)] },
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('an enquiry drafted into a quote', () => {
  it('matches the elastic, costs it, suggests the margin they accepted, and drafts a note', async () => {
    mockReply = { problem: null, customerName: 'Sunrise Garments', items: [{ description: 'knitted elastic black', widthMm: 25, colour: 'Black', quantityMetres: 20000, targetRate: 3.5 }], neededBy: '', notes: '' };
    const res = await request(app).post('/api/v2/quote/from-enquiry').set('Cookie', cookie()).field('text', 'Need 20000 m 25mm black knitted, rate? our target 3.50');
    expect(res.status).toBe(200);
    expect(res.body.customer).toEqual({ _id: String(cust), name: 'Sunrise Garments' });
    const [l] = res.body.lines;
    expect(l).toMatchObject({ elastic: String(e25), productName: '25mm Knitted Elastic - Black', quantityMetres: 20000, cost: 3.25, marginPercent: 20, rate: 3.9, conversionCost: 1.25 });
    expect(l.materials).toEqual([{ label: 'Warp spandex — Spandex 840D', weightGrams: 1, ratePerKg: 900 }, { label: 'Warp yarn 1 — 40s PC Black', weightGrams: 5, ratePerKg: 220 }]);
    expect(l.reasons).toEqual([
      'They accepted 20% on Q/1 for this elastic.',
      'Declined at 12% before (Q/2) — they may push back.',
      'Their ₹3.5/m is a 7.7% margin.',
    ]);
    expect(res.body.coverNote).toMatch(/25mm Knitted Elastic - Black — 20,000 m at ₹3\.90\/m \+ GST/);
    expect(await M.Quote.countDocuments()).toBe(2);

    // The quote made from it scores the draft.
    const created = await request(app).post('/api/v2/quote/create').set('Cookie', cookie()).send({
      customer: String(cust), aiSuggestion: res.body.aiSuggestion,
      lines: [{ elastic: l.elastic, productName: l.productName, materials: l.materials, conversionCost: l.conversionCost, marginPercent: 18, quantityMetres: 20000 }],
    });
    expect(created.status).toBe(201);
    expect((await M.AiSuggestion.findById(res.body.aiSuggestion).lean()).outcome).toBe('edited');
  });

  it('never matches a 20mm enquiry to the 25mm, and says when it is not an enquiry', async () => {
    mockReply = { problem: null, items: [{ description: 'knitted elastic black', widthMm: 30, quantityMetres: 5000 }] };
    const res = await request(app).post('/api/v2/quote/from-enquiry').set('Cookie', cookie()).field('text', '30mm black 5000m');
    expect(res.body.lines[0].elastic).toBe(null);
    expect(res.body.lines[0].candidates).toEqual([]);
    expect(res.body.lines[0].reasons[0]).toMatch(/No elastic on file like this/);

    mockReply = { problem: 'not_an_enquiry' };
    expect((await request(app).post('/api/v2/quote/from-enquiry').set('Cookie', cookie()).field('text', 'hello')).body.read.problem).toBe('not_an_enquiry');
    expect((await request(app).post('/api/v2/quote/from-enquiry').set('Cookie', cookie())).status).toBe(400);
  });
});
