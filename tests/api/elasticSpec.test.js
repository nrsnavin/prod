'use strict';
// ══════════════════════════════════════════════════════════════════
//  A TECH SHEET OR SAMPLE PHOTO, READ INTO THE NEW-ELASTIC FORM
//
//    • the construction comes back as read, each yarn matched to the
//      materials of its kind — a count that differs (30s for 40s) is
//      never matched, only offered as nothing
//    • what the reader was unsure of is said; nothing is saved
//    • not a spec: said so; no photo: refused
//    • the elastic saved from it settles the reading (its accuracy kept)
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = {};
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(mockReply) }], usage: { input_tokens: 100, output_tokens: 50 } }) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const readSpec = () => request(app).post('/api/v2/elastic/read-spec').set('Cookie', cookie()).attach('files', photo, { filename: 'sheet.jpg', contentType: 'image/jpeg' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'RawMaterial', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'es@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  for (const [name, category] of [['40s PC Black', 'warp'], ['30s PC Black', 'warp'], ['Spandex 840D', 'rubber'], ['40D Nylon Covering', 'covering'], ['150D Polyester', 'weft']]) {
    await M.RawMaterial.create({ name, category, unit: 'kg', stock: 0, minStock: 0, price: 100 });
  }
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('reading a tech sheet', () => {
  it('reads the construction and matches each yarn to its kind, never across a count', async () => {
    mockReply = {
      problem: null, name: '25mm Knitted Elastic Black', widthMm: 25, weaveType: 'Knitted', colour: 'Black',
      spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, hsn: '5806',
      warpSpandex: { text: 'spandex 840 D', weight: 0.6 }, spandexCovering: { text: '40D nylon covering', weight: 0.2 },
      weftYarn: { text: '150D polyester', weight: 0.7 }, warpYarn: [{ text: '40s PC black', weight: 0.9 }, { text: '20s cotton white', weight: 0.3 }],
      unclear: ['pick'],
    };
    const res = await readSpec();
    expect(res.status).toBe(200);
    expect(res.body.read).toMatchObject({ name: '25mm Knitted Elastic Black', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, hsn: '5806', unclear: ['pick'] });
    const m = res.body.matches;
    expect(m.warpSpandex.materialName).toBe('Spandex 840D');
    expect(m.spandexCovering.materialName).toBe('40D Nylon Covering');
    expect(m.weftYarn.materialName).toBe('150D Polyester');
    expect(m.warpYarn[0].materialName).toBe('40s PC Black');
    // Nothing on file at 20s: left to pick, and 30s/40s never offered for it.
    expect(m.warpYarn[1].materialId).toBeNull();
    expect(m.warpYarn[1].candidates.map((c) => c.name)).not.toContain('40s PC Black');
    expect(res.body.aiSuggestion).toBeTruthy();
    expect(await M.AiSuggestion.countDocuments({ surface: 'elastic-spec-ocr' })).toBe(1);
  });

  it('says when it is not a spec, and refuses no photo', async () => {
    mockReply = { problem: 'not_a_spec' };
    const res = await readSpec();
    expect(res.body).toMatchObject({ read: { problem: 'not_a_spec' }, aiSuggestion: null });
    expect((await request(app).post('/api/v2/elastic/read-spec').set('Cookie', cookie())).status).toBe(400);
  });
});
