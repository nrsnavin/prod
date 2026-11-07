'use strict';
// ══════════════════════════════════════════════════════════════════
//  A STOREKEEPER'S LINE, INTO A STOCK MOVEMENT
//
//    • "issue 20 kg 40s black to job 512" read by rule: the material
//      matched (30s never), the job found; nothing moves by reading
//    • confirmed: stock down, the issue on the job as its consumption,
//      the reading scored
//    • what does not fit is said: too little stock, no such job, the
//      wrong unit, a lot that is not this material's
//    • a line the rules cannot read goes to the model
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = null;
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockReply ? { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(mockReply) }], usage: { input_tokens: 5, output_tokens: 5 } }) } } : null),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, pc40, job;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const say = (text) => request(app).post('/api/v2/materials/command').set('Cookie', cookie()).send({ text });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'RawMaterial', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  M.Out = require('../../models/MaterialOut.cjs');
  admin = await M.User.create({ name: 'Owner', email: 'sc@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  pc40 = await M.RawMaterial.create({ name: '40s PC Black', category: 'warp', unit: 'kg', stock: 50, price: 220, avgCost: 220 });
  await M.RawMaterial.create({ name: '30s PC Black', category: 'warp', unit: 'kg', stock: 80, price: 200 });
  await M.RawMaterial.create({ name: 'Paper cones', category: 'packing', unit: 'nos', stock: 1000, price: 2 });
  job = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('joborders').insertOne({ _id: job, jobOrderNo: 512, order: new mongoose.Types.ObjectId(), customer: new mongoose.Types.ObjectId(), status: 'weaving' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('a storekeeper\'s line', () => {
  it('is read by rule into an issue to the job, and nothing moves until confirmed', async () => {
    const res = await say('issue 20 kg 40s black to job 512');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ by: 'rules', problems: [], draft: { action: 'issue', quantity: 20, unit: 'kg', material: { name: '40s PC Black', stock: 50 }, job: { jobOrderNo: 512 } } });
    expect((await M.RawMaterial.findById(pc40._id).lean()).stock).toBe(50);

    const done = await request(app).post('/api/v2/materials/bulk-adjust-stock').set('Cookie', cookie())
      .send({ adjustments: [{ _id: String(pc40._id), adjustment: -20, reason: 'Spoken: issue 20 kg 40s black to job 512', job: String(job), action: 'issue' }], aiSuggestion: res.body.aiSuggestion });
    expect(done.status).toBe(200);
    expect((await M.RawMaterial.findById(pc40._id).lean()).stock).toBe(30);
    const out = await M.Out.findOne({ rawMaterial: pc40._id }).lean();
    expect(out).toMatchObject({ type: 'JOB_CONSUMPTION', quantity: 20, remarks: 'Issued to J-512: Spoken: issue 20 kg 40s black to job 512' });
    expect(String(out.job)).toBe(String(job));
    expect((await M.AiSuggestion.findById(res.body.aiSuggestion).lean()).outcome).toBe('accepted');
  });

  it('says what does not fit', async () => {
    let r = (await say('issue 45 kg 40s pc black to job 999')).body;
    expect(r.problems).toEqual(['There is no job 999.', 'Only 30 kg of 40s PC Black in stock.']);
    r = (await say('issue 3 cones 40s pc black')).body;
    expect(r.problems).toEqual(['40s PC Black is kept in kg, not cones.']);
    r = (await say('issue 2 kg 40s pc black lot L99')).body;
    expect(r.problems).toEqual(['40s PC Black has no lot L99.']);
    r = (await say('issue 5 kg 50s blue')).body;
    expect(r.draft.material).toBe(null);
    expect(r.problems[0]).toMatch(/No material like|Which material/);
    // 30s is never taken for 40s, nor 40s for 30s.
    r = (await say('give 5 kg 30s black')).body;
    expect(r.draft.material.name).toBe('30s PC Black');
  });

  it('a stock issue naming a missing job is refused, leaving stock alone', async () => {
    const r = await request(app).post('/api/v2/materials/bulk-adjust-stock').set('Cookie', cookie())
      .send({ adjustments: [{ _id: String(pc40._id), adjustment: -1, reason: 'x', job: String(new mongoose.Types.ObjectId()) }] });
    expect(r.body.errors[0].error).toBe('That job is not there');
    expect((await M.RawMaterial.findById(pc40._id).lean()).stock).toBe(30);
  });

  it('goes to the model when the rules cannot read it', async () => {
    mockReply = { action: 'issue', quantity: 10, unit: 'kg', material: '40s PC black', jobNo: 512, lotNo: null };
    const r = (await say('job 512 ku pathu kilo forty count black kudu')).body;
    expect(r).toMatchObject({ by: 'model', draft: { action: 'issue', quantity: 10, material: { name: '40s PC Black' }, job: { jobOrderNo: 512 } } });
    mockReply = null;
  });
});
