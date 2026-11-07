'use strict';
// ══════════════════════════════════════════════════════════════════
//  GOODS RECEIVED, READ FROM THE SUPPLIER'S CHALLAN AND THE CONE LABELS
//
//    • each line read is matched to this PO's materials, with what is
//      still pending on it; two lots of one yarn stay two lines
//    • a yarn of another count is never matched to the PO's 40s
//    • the PO is found from the number the challan quotes when the form
//      did not say which
//    • not a receipt: said so; nothing is received by reading
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

let mongo, app, M, admin, po, pc40, spandex;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const read = (q = '') => request(app).post(`/api/v2/supplier/inward/read${q}`).set('Cookie', cookie())
  .attach('files', photo, { filename: 'dc.jpg', contentType: 'image/jpeg' }).attach('files', photo, { filename: 'label.jpg', contentType: 'image/jpeg' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'RawMaterial', 'PurchaseOrder', 'MaterialInward']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ir@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const s = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode', phoneNumber: '9840000000' });
  pc40 = await M.RawMaterial.create({ name: '40s PC Black', category: 'warp', unit: 'kg', stock: 0, minStock: 0, price: 220 });
  spandex = await M.RawMaterial.create({ name: 'Spandex 840D', category: 'rubber', unit: 'kg', stock: 0, minStock: 0, price: 900 });
  po = await M.PurchaseOrder.create({ poNo: 118, supplier: s._id, status: 'Open', items: [{ rawMaterial: pc40._id, quantity: 500, price: 220, receivedQuantity: 100 }, { rawMaterial: spandex._id, quantity: 50, price: 900 }] });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('reading goods received', () => {
  it('matches each line to the PO, keeps two lots apart, and never matches another count', async () => {
    mockReply = { problem: null, supplierName: 'Sri Yarn Traders', dcNo: 'SY/DC/412', poNumber: 'PO-118', date: '2026-11-06', lines: [
      { description: '40s PC black', quantity: 150.5, unit: 'kg', rate: 220, lotNo: 'L2611', shade: 'Black 1102', packages: 6 },
      { description: '40s PC black', quantity: 99.5, unit: 'kg', rate: 220, lotNo: 'L2612', shade: 'Black 1102', packages: 4 },
      { description: 'Spandex 840 D', quantity: 20, unit: 'kg', lotNo: 'SP77' },
      { description: '30s PC black', quantity: 10, unit: 'kg' },
    ] };
    const res = await read(`?poId=${po._id}`);
    expect(res.status).toBe(200);
    expect(res.body.read).toMatchObject({ dcNo: 'SY/DC/412', poNumber: 'PO-118' });
    expect(res.body.po.poNo).toBe(118);
    expect(res.body.rows.map((r) => [r.materialName, r.quantity, r.lotNo, r.pending])).toEqual([
      ['40s PC Black', 150.5, 'L2611', 400],
      ['40s PC Black', 99.5, 'L2612', 400],
      ['Spandex 840D', 20, 'SP77', 50],
      [null, 10, '', null],
    ]);
    // Reading receives nothing.
    expect(await M.MaterialInward.countDocuments()).toBe(0);
    expect((await M.PurchaseOrder.findById(po._id).lean()).items[0].receivedQuantity).toBe(100);
  });

  it('finds the PO from the number the challan quotes', async () => {
    mockReply = { problem: null, poNumber: 'PO 118', lines: [{ description: '40s PC Black', quantity: 50, unit: 'kg' }] };
    const res = await read();
    expect(res.body.po.poNo).toBe(118);
    expect(res.body.rows[0].materialName).toBe('40s PC Black');
  });

  it('says when it is not a receipt, and refuses no photo', async () => {
    mockReply = { problem: 'not_a_receipt' };
    expect((await read()).body).toMatchObject({ read: { problem: 'not_a_receipt' }, rows: [] });
    expect((await request(app).post('/api/v2/supplier/inward/read').set('Cookie', cookie())).status).toBe(400);
  });
});
