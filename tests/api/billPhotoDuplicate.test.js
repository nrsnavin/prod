'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SAME BILL PHOTO, SENT TWICE
//
//    • a photo attached to a saved bill is fingerprinted
//    • the same photo scanned again — even recompressed and resized, as
//      WhatsApp does — says which bill it is already on
//    • a different photo says nothing; a scan's photo counts only once
//      the bill made from it is saved
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockReadBill = jest.fn();
jest.mock('../../utils/billOcr', () => ({ readBill: (...a) => mockReadBill(...a) }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const jpeg = require('jpeg-js');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, bill;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

/** A synthetic "bill photo": a pattern unique to `seed`, at a size and quality. */
function photo(seed, w = 800, h = 1100, quality = 90) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const X = (x * 800) / w; const Y = (y * 1100) / h; const i = (y * w + x) * 4;
    const v = (Math.sin(X / (17 + seed)) * 60 + Math.cos(Y / (23 + seed)) * 60 + 128) & 255;
    data[i] = v; data[i + 1] = (v * 0.8) & 255; data[i + 2] = 255 - v; data[i + 3] = 255;
  }
  return jpeg.encode({ data, width: w, height: h }, quality).data;
}
const scan = (buf) => request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).attach('files', buf, { filename: 'bill.jpg', contentType: 'image/jpeg' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  admin = await require('../../models/User.js').create({ name: 'Owner', email: 'bp@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const SupplierBill = require('../../models/SupplierBill.js');
  bill = new mongoose.Types.ObjectId();
  await SupplierBill.collection.insertOne({ _id: bill, billNo: 'B/26-27/0012', supplierName: 'Sri Yarn Traders', billDate: new Date('2026-10-03T06:30:00Z'), status: 'open', totals: { grand: 23100 }, attachments: [] });
  mockReadBill.mockResolvedValue({ kind: 'bill', problem: 'not_a_bill', model: 'v', usage: {}, latencyMs: 1 });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('the same bill photo, sent twice', () => {
  it('recognises a photo already on a saved bill, even recompressed and resized', async () => {
    const up = await request(app).post(`/api/v2/accounts/bills/${bill}/attachments`).set('Cookie', cookie()).attach('file', photo(1), { filename: 'b12.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(201);

    const again = await scan(photo(1, 400, 550, 45));
    expect(again.status).toBe(200);
    expect(again.body.samePhoto).toEqual([expect.objectContaining({ docType: 'SupplierBill', docNo: 'B/26-27/0012', partyName: 'Sri Yarn Traders', amount: 23100, exact: false })]);

    expect((await scan(photo(7))).body.samePhoto).toEqual([]);
  });

  it('counts a scanned photo only once the bill made from it is saved', async () => {
    const first = await scan(photo(3));
    expect(first.body.samePhoto).toEqual([]);
    expect((await scan(photo(3))).body.samePhoto).toEqual([]); // scanned, never saved
    const doc = new mongoose.Types.ObjectId();
    await require('../../services/billImages').link(first.body.aiSuggestion, { docType: 'Expense', docId: doc, docNo: 'EXP/0044', partyName: 'Indian Oil', amount: 960, date: new Date() });
    const third = await scan(photo(3));
    expect(third.body.samePhoto).toEqual([expect.objectContaining({ docType: 'Expense', docNo: 'EXP/0044', exact: true })]);
  });
});
