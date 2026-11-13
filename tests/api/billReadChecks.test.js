'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SCANNED BILL: ITS GOODS RECEIPTS, AND WHETHER ITS FIGURES ADD UP
//
//  A bill photographed against a purchase order kept the lines the
//  reader saw: no material on them and none of the PO's receipts taken,
//  so those receipts still read "not billed" and could be billed again.
//  Its lines are now matched to the receipts (services/billMatch.js),
//  and the read is added up against its printed totals
//  (utils/billArithmetic.js). The model is mocked: these pin what is
//  done with its answer.
// ══════════════════════════════════════════════════════════════════
process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockRead = jest.fn();
jest.mock('../../utils/billOcr', () => ({ readBill: (...a) => mockRead(...a), SUPPORTED: new Set(['image/png', 'image/jpeg', 'application/pdf']) }));
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const { checkRead } = require('../../utils/billArithmetic');
const { nameScore, pickReceipts } = require('../../services/billMatch');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const scan = () => request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).attach('files', png, { filename: 'bill.png', contentType: 'image/png' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'RawMaterial', 'PurchaseOrder', 'MaterialInward', 'SupplierBill']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'billread@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  mockRead.mockReset();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
async function scene() {
  n += 1;
  const supplier = await M.Supplier.create({ name: `Sri Yarn Traders ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5` });
  const nylon = await M.RawMaterial.create({ name: `Nylon 70D ${n}`, category: 'covering', unit: 'kg', stock: 0, price: 300 });
  const rubber = await M.RawMaterial.create({ name: `Rubber thread 42 ${n}`, category: 'rubber', unit: 'kg', stock: 0, price: 400 });
  const po = await M.PurchaseOrder.create({ supplier: supplier._id, poNo: 800 + n, items: [{ rawMaterial: nylon._id, price: 310, quantity: 100, receivedQuantity: 60 }, { rawMaterial: rubber._id, price: 420, quantity: 50, receivedQuantity: 25 }] });
  const in1 = await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 40, unitPrice: 310, inwardDate: new Date('2026-07-01') });
  const in2 = await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 20, unitPrice: 310, inwardDate: new Date('2026-07-03') });
  const in3 = await M.MaterialInward.create({ rawMaterial: rubber._id, purchaseOrder: po._id, quantity: 25, unitPrice: 420, inwardDate: new Date('2026-07-02') });
  return { supplier, nylon, rubber, po, in1, in2, in3 };
}
const read = (s, lines, totals = {}) => ({
  kind: 'bill', problem: null, supplierName: s.supplier.name.toUpperCase(), supplierGstin: s.supplier.gstin, billNo: `SY/${n}`, billDate: '2026-07-04', dueDate: null,
  lines, totals, confidence: 0.9, model: 'test-vision', usage: {}, latencyMs: 5,
});
const line = (description, quantity, rate, gstPercent = 5, extra = {}) => ({ description, hsn: '', quantity, unit: 'kg', rate, gstPercent, amount: Math.round(quantity * rate * 100) / 100, confidence: 0.9, ...extra });

describe('a scanned bill takes the goods receipts its lines were for', () => {
  it('places each line on the PO: the material, and the receipts its quantity covers', async () => {
    const s = await scene();
    mockRead.mockResolvedValue(read(s, [line('NYLON YARN 70D/24F SD', 60, 310), line('Rubber thread no. 42', 25, 420), line('Freight', 1, 500, 18)]));
    const res = await scan();
    expect(res.status).toBe(200);
    const m = res.body.receiptMatch;
    expect(m.purchaseOrder).toMatchObject({ poNo: s.po.poNo });
    expect(m.lines).toEqual([
      expect.objectContaining({ index: 0, rawMaterial: String(s.nylon._id), inwards: [String(s.in1._id), String(s.in2._id)], quantityMatches: true, rateMatches: true }),
      expect.objectContaining({ index: 1, rawMaterial: String(s.rubber._id), inwards: [String(s.in3._id)], quantityMatches: true }),
    ]);
    // Freight is no receipt: it stays as read.
    expect(m.unmatched).toEqual([2]);
    expect(m.receiptsLeft).toEqual([]);
  });

  it('a bill for one delivery takes that delivery only, and leaves the rest to bill', async () => {
    const s = await scene();
    mockRead.mockResolvedValue(read(s, [line('Nylon 70D', 20, 310)]));
    const m = (await scan()).body.receiptMatch;
    expect(m.lines[0].inwards).toEqual([String(s.in2._id)]);
    expect(m.receiptsLeft).toEqual([expect.objectContaining({ material: s.rubber.name, quantity: 25 })]);
  });

  it('a quantity that fits no receipts keeps the material and takes none; the person picks', async () => {
    const s = await scene();
    mockRead.mockResolvedValue(read(s, [line('Nylon 70D', 33, 310)]));
    const m = (await scan()).body.receiptMatch;
    expect(m.lines[0]).toMatchObject({ rawMaterial: String(s.nylon._id), inwards: [], quantityMatches: false, quantityReceived: 60 });
  });

  it('nothing to place: no receipts unbilled, or nothing like them', async () => {
    const s = await scene();
    mockRead.mockResolvedValue(read(s, [line('Spares for loom 4', 1, 900, 18)]));
    expect((await scan()).body.receiptMatch).toBeNull();
  });

  it('the bill entered with those receipts marks them billed, and they cannot be billed again', async () => {
    const s = await scene();
    mockRead.mockResolvedValue(read(s, [line('Nylon 70D', 60, 310)]));
    const m = (await scan()).body.receiptMatch;
    const body = { supplier: s.supplier._id, supplierBillNo: 'SY/A', billDate: '2026-07-04', purchaseOrder: m.purchaseOrder._id, inwards: m.lines[0].inwards, lines: [{ rawMaterial: m.lines[0].rawMaterial, description: 'Nylon 70D', unit: 'kg', quantity: 60, rate: 310, gstPercent: 5 }], source: 'scan' };
    const res = await post('/accounts/bills', body);
    expect(res.status).toBe(201);
    const info = await get(`/accounts/bills/po-info?id=${s.po._id}`);
    expect(info.body.inwards.filter((i) => i.billedOn).map((i) => String(i._id)).sort()).toEqual([String(s.in1._id), String(s.in2._id)].sort());
    // The PO's lines are what they always were: no new field in the answer.
    expect(info.body.lines).toEqual([expect.objectContaining({ description: s.rubber.name, quantity: 25, inwards: [String(s.in3._id)] })]);
    expect(info.body.lines[0].receipts).toBeUndefined();
    expect((await post('/accounts/bills', { ...body, supplierBillNo: 'SY/B' })).status).toBe(409);
  });

  it('a receipt from another PO, or receipts with no PO, are refused', async () => {
    const s = await scene();
    const other = await M.PurchaseOrder.create({ supplier: s.supplier._id, poNo: 990 + n, items: [{ rawMaterial: s.nylon._id, price: 310, quantity: 10 }] });
    const stray = await M.MaterialInward.create({ rawMaterial: s.nylon._id, purchaseOrder: other._id, quantity: 10, unitPrice: 310 });
    const lines = [{ rawMaterial: s.nylon._id, description: 'Nylon 70D', quantity: 10, rate: 310, gstPercent: 5 }];
    const wrong = await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/C', billDate: '2026-07-04', purchaseOrder: s.po._id, inwards: [stray._id], lines });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(new RegExp(`not on PO #${s.po.poNo}`));
    const none = await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/D', billDate: '2026-07-04', inwards: [s.in1._id], lines });
    expect(none.status).toBe(400);
    expect(await M.SupplierBill.countDocuments()).toBe(0);
  });

  it('two POs with receipts: the one the bill fits', async () => {
    const s = await scene();
    const po2 = await M.PurchaseOrder.create({ supplier: s.supplier._id, poNo: 950 + n, items: [{ rawMaterial: s.nylon._id, price: 305, quantity: 15 }] });
    const in4 = await M.MaterialInward.create({ rawMaterial: s.nylon._id, purchaseOrder: po2._id, quantity: 15, unitPrice: 305 });
    mockRead.mockResolvedValue(read(s, [line('Nylon 70D', 15, 305)]));
    const m = (await scan()).body.receiptMatch;
    expect(m.purchaseOrder).toMatchObject({ poNo: po2.poNo });
    expect(m.lines[0].inwards).toEqual([String(in4._id)]);
  });
});

describe('the read bill is added up against what it prints', () => {
  it('a bill that adds up passes; the scan says so', async () => {
    const s = await scene();
    mockRead.mockResolvedValue(read(s, [line('Nylon 70D', 60, 310)], { taxable: 18600, cgst: 465, sgst: 465, igst: null, grand: 19530 }));
    const res = await scan();
    expect(res.body.checks).toMatchObject({ ok: true, issues: [], computed: { taxable: 18600, tax: 930, grand: 19530 } });
  });

  it('one misread digit is caught on the line and on the total', async () => {
    const s = await scene();
    // 18,600 printed; the reader saw 16,600 on the line.
    mockRead.mockResolvedValue(read(s, [line('Nylon 70D', 60, 310, 5, { amount: 16600 })], { taxable: 18600, cgst: 465, sgst: 465, grand: 19530 }));
    const { checks } = (await scan()).body;
    expect(checks.ok).toBe(false);
    expect(checks.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['LINE_MATH', 'TAXABLE', 'TAX', 'GRAND']));
    expect(checks.issues.find((i) => i.code === 'LINE_MATH').message).toBe('Line 1: 60 × 310 is 18,600, the bill says 16,600');
  });
});

describe('checkRead', () => {
  const r = (lines, totals = {}, gstin = '33AAAPS0001F1Z5') => ({ supplierGstin: gstin, lines, totals });
  it('rounding to the rupee on the total is not a mistake', () => {
    expect(checkRead(r([{ quantity: 3, rate: 333.33, amount: 999.99, gstPercent: 5 }], { grand: 1050 })).ok).toBe(true);
  });
  it('6% is half of a GST rate', () => {
    const x = checkRead(r([{ quantity: 1, rate: 100, amount: 100, gstPercent: 6 }]));
    expect(x.issues).toEqual([expect.objectContaining({ code: 'GST_RATE', severity: 'warning', message: 'Line 1: 6% is not a GST rate — is it CGST 6% + SGST 6%, that is 12%?' })]);
    expect(x.ok).toBe(true);
  });
  it('CGST and SGST must be equal; the state decides IGST', () => {
    const codes = (x) => x.issues.map((i) => i.code);
    expect(codes(checkRead(r([], { cgst: 465, sgst: 456 })))).toEqual(['SPLIT']);
    expect(codes(checkRead(r([], { igst: 930 }), { ourStateCode: '33' }))).toEqual(['SUPPLY']);
    expect(codes(checkRead(r([], { cgst: 465, sgst: 465 }, '29AAAPS0001F1Z5'), { ourStateCode: '33' }))).toEqual(['SUPPLY']);
    expect(codes(checkRead(r([], { igst: 930 }, '29AAAPS0001F1Z5'), { ourStateCode: '33' }))).toEqual([]);
  });
  it('a figure not read is not compared', () => {
    expect(checkRead(r([{ quantity: 2, rate: 50, amount: null, gstPercent: null }], { grand: 9999 })).issues).toEqual([]);
  });
});

describe('matching words and quantities', () => {
  it('the material name inside the bill line, with 70D read as 70 too', () => {
    expect(nameScore('NYLON YARN 70D/24F SD', 'Nylon 70D')).toBe(1);
    expect(nameScore('Nylon yarn 70 denier', 'Nylon 70D')).toBe(1);
    expect(nameScore('Polyester 150D', 'Nylon 70D')).toBe(0);
  });
  it('all the receipts, one of them, or the first few; within 1%', () => {
    const rs = [{ _id: 'a', quantity: 40 }, { _id: 'b', quantity: 20 }, { _id: 'c', quantity: 15 }];
    expect(pickReceipts(75, rs).ids).toEqual(['a', 'b', 'c']);
    expect(pickReceipts(20.1, rs).ids).toEqual(['b']);
    expect(pickReceipts(60.4, rs).ids).toEqual(['a', 'b']);
    expect(pickReceipts(50, rs)).toMatchObject({ ids: [], exact: false });
  });
});
