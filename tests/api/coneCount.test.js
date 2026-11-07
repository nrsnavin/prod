'use strict';
// ══════════════════════════════════════════════════════════════════
//  CONES COUNTED FROM A PHOTO, FOR THE STOCK TAKE
//
//    • the count read (a grid's own rows × per row wins over a total that
//      disagrees), turned into kg at the cone weight, which is kept on
//      the material for next time; nothing goes on the sheet by reading
//    • no weight on file: the count, and no kg guessed
//    • entered on the sheet, the count scores the reading
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = {};
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(mockReply) }], usage: { input_tokens: 5, output_tokens: 5 } }) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, M, count, pc40;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const cones = (fields) => {
  let r = request(app).post(`/api/v2/stock-counts/${count._id}/cones`).set('Cookie', cookie());
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', photo, { filename: 'rack.jpg', contentType: 'image/jpeg' });
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'RawMaterial', 'StockCount', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'cc@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  pc40 = await M.RawMaterial.create({ name: '40s PC Black', category: 'warp', unit: 'kg', stock: 90, price: 220 });
  const opened = await request(app).post('/api/v2/stock-counts').set('Cookie', cookie()).send({ label: 'Nov count', scope: { kind: 'materials', materials: [String(pc40._id)] } });
  count = opened.body.count || opened.body.data || opened.body;
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('cones counted from a photo', () => {
  it('without a cone weight: the count, and no kilograms guessed', async () => {
    mockReply = { problem: null, cones: 48, rows: 6, perRow: 8, layers: 1, hidden: false, confidence: 0.85, note: '6 rows of 8' };
    const line = count.lines[0];
    const r = await cones({ lineId: String(line._id) });
    expect(r.status).toBe(200);
    expect(r.body.read).toMatchObject({ cones: 48, rows: 6, perRow: 8 });
    expect(r.body.estimate).toBe(null);
  });

  it('with a cone weight: kilograms, the weight kept on the material, the grid trusted over a wrong total', async () => {
    mockReply = { problem: null, cones: 50, rows: 6, perRow: 8, layers: 1, hidden: true, confidence: 0.6, note: 'some behind' };
    const line = count.lines[0];
    const r = await cones({ lineId: String(line._id), coneWeightKg: '1.8' });
    expect(r.body.read).toMatchObject({ cones: 48, hidden: true });
    expect(r.body.estimate).toEqual({ quantity: 86.4, unit: 'kg', basis: '48 cones × 1.8 kg' });
    expect((await M.RawMaterial.findById(pc40._id).lean()).coneWeightKg).toBe(1.8);
    // Nothing is on the sheet yet.
    expect((await M.StockCount.findById(count._id).lean()).lines[0].countedQty).toBe(null);

    const entered = await request(app).patch(`/api/v2/stock-counts/${count._id}/lines`).set('Cookie', cookie())
      .send({ lines: [{ lineId: String(line._id), countedQty: 88.2, cones: 49, aiSuggestion: r.body.aiSuggestion }] });
    expect(entered.status).toBe(200);
    await new Promise((ok) => setTimeout(ok, 50));
    expect((await M.AiSuggestion.findById(r.body.aiSuggestion).lean()).outcome).toBe('edited');
  });

  it('refuses a silly weight, a line not on the sheet, and says when there are no cones', async () => {
    const line = count.lines[0];
    expect((await cones({ lineId: String(line._id), coneWeightKg: '500' })).status).toBe(400);
    expect((await cones({ lineId: String(new mongoose.Types.ObjectId()) })).status).toBe(400);
    mockReply = { problem: 'no_cones' };
    expect((await cones({ lineId: String(line._id) })).body.read.problem).toBe('no_cones');
  });
});
