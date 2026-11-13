'use strict';
// ══════════════════════════════════════════════════════════════════
//  MAILED BILLS READY TO ENTER IN ONE CLICK (services/billReady.js)
//
//  A bill from the mailbox is "ready" when a person has nothing left to
//  decide: found by GSTIN, adding up, every line on a goods receipt at
//  the PO's price, no red warning, an open period. A ready bill is
//  entered by POST /accounts/bills with the body the server proposes, so
//  it gets every check a typed bill does; sending it twice enters it once.
//  Each way a bill is held back says why.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'RawMaterial', 'PurchaseOrder', 'MaterialInward', 'SupplierBill', 'InboxBill', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'billready@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
async function scene() {
  n += 1;
  const supplier = await M.Supplier.create({ name: `Sri Yarn Traders ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5` });
  const nylon = await M.RawMaterial.create({ name: `Nylon 70D ${n}`, category: 'covering', unit: 'kg', stock: 0, price: 300 });
  const po = await M.PurchaseOrder.create({ supplier: supplier._id, poNo: 600 + n, items: [{ rawMaterial: nylon._id, price: 310, quantity: 100, receivedQuantity: 60 }] });
  const in1 = await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 60, unitPrice: 310, inwardDate: new Date('2026-07-01') });
  return { supplier, nylon, po, in1 };
}
const goodRead = (s, over = {}) => ({
  kind: 'bill', problem: null, supplierName: s.supplier.name, supplierGstin: s.supplier.gstin, billNo: `SY/${n}`, billDate: '2026-07-04', dueDate: null,
  lines: [{ description: 'Nylon 70D', hsn: '5402', quantity: 60, unit: 'kg', rate: 310, gstPercent: 5, amount: 18600, confidence: 0.9 }],
  totals: { taxable: 18600, cgst: 465, sgst: 465, igst: null, grand: 19530 }, confidence: 0.9, ...over,
});
let mid = 0;
const mailed = (read, extra = {}) => M.InboxBill.create({ messageId: `<m${++mid}@sriyarn.in>`, part: 1, status: 'new', from: 'accounts@sriyarn.in', filename: 'bill.pdf', contentType: 'application/pdf', read, receivedAt: new Date(), ...extra });
const whyOf = async (id) => (await get('/accounts/bill-inbox')).body.bills.find((b) => String(b._id) === String(id));

describe('a mailed bill that agrees with everything', () => {
  it('is ready, and is entered by the bill route with its receipts; twice enters it once', async () => {
    const s = await scene();
    const item = await mailed(goodRead(s));
    const row = await whyOf(item._id);
    expect(row).toMatchObject({ ready: true, readyWhy: [] });

    const ready = await get('/accounts/bill-inbox/ready');
    expect(ready.body.waiting).toBe(1);
    expect(ready.body.bills).toHaveLength(1);
    const { body, summary } = ready.body.bills[0];
    expect(summary).toMatchObject({ supplierName: s.supplier.name, billNo: `SY/${n}`, poNo: s.po.poNo, receipts: 1, grand: 19530 });
    expect(body).toMatchObject({ supplier: String(s.supplier._id), purchaseOrder: String(s.po._id), inwards: [String(s.in1._id)], inboxBill: String(item._id), requestId: `inbox-bill:${item._id}` });
    expect(body.lines[0]).toMatchObject({ rawMaterial: String(s.nylon._id), quantity: 60, rate: 310, gstPercent: 5 });

    const first = await post('/accounts/bills', body);
    expect(first.status).toBe(201);
    expect(first.body.bill.inwards).toEqual([String(s.in1._id)]);
    expect((await M.InboxBill.findById(item._id).lean()).status).toBe('entered');
    const again = await post('/accounts/bills', body);
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(await M.SupplierBill.countDocuments()).toBe(1);
    expect((await get('/accounts/bill-inbox/ready')).body.bills).toEqual([]);
  });
});

describe('what keeps a mailed bill for a person', () => {
  const held = async (read, extra) => (await whyOf((await mailed(read, extra))._id));

  it('a supplier matched by name only, or not on file', async () => {
    const s = await scene();
    expect((await held(goodRead(s, { supplierGstin: '' }))).readyWhy).toContain('The supplier was matched by name only');
    expect((await held(goodRead(s, { supplierGstin: '29AAACZ9999F1Z1', supplierName: 'Somebody Else' }))).readyWhy).toContain('No supplier on file has this GSTIN');
  });

  it('a misread figure, or a figure not read', async () => {
    const s = await scene();
    const misread = await held(goodRead(s, { lines: [{ description: 'Nylon 70D', quantity: 60, unit: 'kg', rate: 310, gstPercent: 5, amount: 16600, confidence: 0.9 }] }));
    expect(misread.ready).toBe(false);
    expect(misread.readyWhy).toContain('Line 1: 60 × 310 is 18,600, the bill says 16,600');
    expect((await held(goodRead(s, { totals: { taxable: 18600 } }))).readyWhy).toContain('Some figures were not read');
  });

  it('a line on no goods receipt, a quantity not received, a rate off the PO', async () => {
    const s = await scene();
    const freight = await held(goodRead(s, {
      lines: [goodRead(s).lines[0], { description: 'Freight', quantity: 1, unit: '', rate: 500, gstPercent: 18, amount: 500, confidence: 0.9 }],
      totals: { taxable: 19100, cgst: 510, sgst: 510, grand: 20120 },
    }));
    expect(freight.readyWhy).toContain('"Freight" is not on a goods receipt');
    const short = await held(goodRead(s, { lines: [{ description: 'Nylon 70D', quantity: 55, unit: 'kg', rate: 310, gstPercent: 5, amount: 17050, confidence: 0.9 }], totals: { taxable: 17050, cgst: 426.25, sgst: 426.25, grand: 17902.5 } }));
    expect(short.readyWhy).toContain('"Nylon 70D" is 55; 60 was received');
    const dear = await held(goodRead(s, { lines: [{ description: 'Nylon 70D', quantity: 60, unit: 'kg', rate: 330, gstPercent: 5, amount: 19800, confidence: 0.9 }], totals: { taxable: 19800, cgst: 495, sgst: 495, grand: 20790 } }));
    expect(dear.readyWhy).toContain('₹1200.00 off the PO price or the receipts');
  });

  it('entered already, a receipt, an unsure read, a closed period', async () => {
    const s = await scene();
    await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/OLD', billDate: '2026-07-02', lines: [{ description: 'x', quantity: 1, rate: 1, gstPercent: 0 }] });
    expect((await held(goodRead(s, { billNo: 'SY/OLD' }))).readyWhy).toEqual(expect.arrayContaining([expect.stringMatching(/^Already entered as PB\//)]));
    expect((await held(goodRead(s, { kind: 'receipt' }))).readyWhy).toContain('A receipt, not a tax invoice: enter it as an expense');
    expect((await held(goodRead(s, { confidence: 0.4 }))).readyWhy).toContain('The reader was only 40% sure');
    await M.AccountsSettings.updateOne({ key: 'accounts' }, { $set: { lockDate: new Date('2026-07-31T00:00:00Z') } }, { upsert: true });
    expect((await held(goodRead(s))).readyWhy).toContain('The books are closed for 2026-07-04');
  });

  it('only waiting bills are listed as ready, and the other lists carry no readiness', async () => {
    const s = await scene();
    const item = await mailed(goodRead(s), { status: 'dismissed' });
    expect((await get('/accounts/bill-inbox/ready')).body.bills).toEqual([]);
    const dismissed = (await get('/accounts/bill-inbox?status=dismissed')).body.bills;
    expect(dismissed.map((b) => String(b._id))).toEqual([String(item._id)]);
    expect(dismissed[0].ready).toBeUndefined();
  });
});
