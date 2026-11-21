'use strict';
// ══════════════════════════════════════════════════════════════════
//  GST ON PURCHASE ORDERS AND RAW MATERIALS
//
//  A material carries its HSN and GST rate; a PO line carries its own
//  copy, taken from the material when the PO is raised (or typed on the
//  line). Read in one order everywhere — the line's, else the
//  material's, else the default in Settings — and priced the way the
//  supplier's bill will be: CGST + SGST from a supplier in our state,
//  IGST from one outside it, nothing from a composition dealer or an
//  unregistered supplier (services/purchaseTax.js).
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, Supplier, PurchaseOrder, MaterialInward, DocumentSettings, User, admin;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const call = (method, url, body) => request(app)[method](`/api/v2${url}`).set('Cookie', cookie()).send(body);
const post = (url, body) => call('post', url, body);
const put = (url, body) => call('put', url, body);
const get = (url) => call('get', url);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  Supplier = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  MaterialInward = require('../../models/MaterialInward');
  DocumentSettings = require('../../models/DocumentSettings');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'po-gst@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

// Our state is Tamil Nadu (33) and the default rate 12%, so a line that
// fell back to the default is told apart from one at a material's 5%.
async function settings(over = {}) {
  await DocumentSettings.findOneAndUpdate(
    { key: 'document' },
    { $set: { companyName: 'Balu Elastics', gstin: '33AABFB1234C1Z5', 'invoice.defaultGstPercent': 12, ...over } },
    { upsert: true }
  );
  require('../../services/documentSettings').invalidate();
}

beforeEach(() => settings());
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
  require('../../services/documentSettings').invalidate();
});

let n = 0;
const material = (over = {}) => RawMaterial.create({ name: `Nylon 70D ${++n}`, category: 'warp', stock: 0, price: 320, ...over });
const supplier = (over = {}) => Supplier.create({ name: `Kumar Yarns ${++n}`, phoneNumber: '9000000000', ...over });
const local = () => supplier({ gstin: '33AAACK1234M1Z2' });      // Tamil Nadu, as we are
const outside = () => supplier({ gstin: '27AAACK1234M1Z9' });    // Maharashtra
const line = (m, over = {}) => ({ rawMaterial: String(m._id), quantity: 100, price: 200, ...over });
const raise = (s, items) => post('/supplier/create-po', { supplier: String(s._id), items });
const detail = (po) => get(`/supplier/get-po-detail?id=${po._id}`);

// ══════════════════════════════════════════════════════════════════
describe('a raw material carries its HSN and GST rate', () => {
  const create = (over = {}) => post('/materials/create-raw-material', {
    name: `Spandex ${++n}`, category: 'warp', supplier: String(over.supplier), ...over,
  });

  it('is saved on create and changed on edit; blank goes back to the default', async () => {
    const s = await supplier();
    const made = await create({ supplier: s._id, hsn: '5402', gstPercent: 5 });
    expect(made.status).toBe(201);
    expect(made.body.material).toMatchObject({ hsn: '5402', gstPercent: 5 });

    const edited = await put('/materials/edit-raw-material', { _id: made.body.material._id, hsn: ' 54023300 ', gstPercent: '18' });
    expect(edited.status).toBe(200);
    expect(edited.body.material).toMatchObject({ hsn: '54023300', gstPercent: 18 });

    const cleared = await put('/materials/edit-raw-material', { _id: made.body.material._id, hsn: '', gstPercent: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.material).toMatchObject({ hsn: '', gstPercent: null });

    // A material made without either is "the default", not 0%.
    const plain = await create({ supplier: s._id });
    expect(plain.body.material).toMatchObject({ hsn: '', gstPercent: null });
  });

  it.each([
    [{ hsn: '54' }, /HSN is 4 to 8 digits/],
    [{ hsn: '5402A' }, /HSN is 4 to 8 digits/],
    [{ gstPercent: 120 }, /GST % must be between 0 and 100/],
    [{ gstPercent: -5 }, /GST % must be between 0 and 100/],
    [{ gstPercent: 'five' }, /GST % must be between 0 and 100/],
  ])('refuses %j', async (bad, message) => {
    const s = await supplier();
    const made = await create({ supplier: s._id, ...bad });
    expect(made.status).toBe(400);
    expect(made.body.message).toMatch(message);
    const m = await material();
    const edited = await put('/materials/edit-raw-material', { _id: String(m._id), ...bad });
    expect(edited.status).toBe(400);
    expect((await RawMaterial.findById(m._id).lean())).toMatchObject({ hsn: '', gstPercent: null });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('each PO line keeps the HSN and rate it was raised at', () => {
  it('takes the material\'s, else the default in Settings, unless the line states its own', async () => {
    const taxed = await material({ hsn: '5402', gstPercent: 5 });
    const untaxed = await material();
    const exempt = await material({ hsn: '4007', gstPercent: 18 });
    const res = await raise(await local(), [
      line(taxed),
      line(untaxed),
      line(exempt, { hsn: '40070010', gstPercent: 0 }),   // 0 is a rate, not "not given"
    ]);
    expect(res.status).toBe(201);
    const stored = (await PurchaseOrder.findById(res.body.po._id).lean()).items;
    expect(stored.map((l) => [l.hsn, l.gstPercent])).toEqual([['5402', 5], ['', 12], ['40070010', 0]]);

    // Changing the material later does not restate the PO.
    await RawMaterial.updateOne({ _id: taxed._id }, { gstPercent: 18 });
    const again = (await detail(res.body.po)).body.po.items[0];
    expect(again.gstPercent).toBe(5);
  });

  it.each([
    [{ hsn: '12' }, /Line 1: the HSN is 4 to 8 digits/],
    [{ gstPercent: 101 }, /Line 1: GST % must be between 0 and 100/],
  ])('refuses a line with %j', async (bad, message) => {
    const m = await material();
    const res = await raise(await local(), [line(m, bad)]);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(await PurchaseOrder.countDocuments()).toBe(0);
  });

  it('the phone\'s Raise PO, which sends no GST, gets the material\'s', async () => {
    const m = await material({ hsn: '5402', gstPercent: 5 });
    const s = await local();
    const res = await post('/materials/raise-po', { supplier: String(s._id), items: [line(m)] });
    expect(res.status).toBe(201);
    expect((await PurchaseOrder.findById(res.body.po._id).lean()).items[0]).toMatchObject({ hsn: '5402', gstPercent: 5 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the tax on a PO, as the supplier\'s bill will charge it', () => {
  it('from a supplier in our state: CGST and SGST, half the rate each', async () => {
    const a = await material({ hsn: '5402', gstPercent: 5 });
    const b = await material({ hsn: '4007', gstPercent: 18 });
    const res = await raise(await local(), [line(a, { quantity: 100, price: 200 }), line(b, { quantity: 10, price: 150.5 })]);
    const po = (await detail(res.body.po)).body.po;
    expect(po.tax.supplyType).toBe('intra');
    expect(po.tax.noGst).toBe('');
    expect(po.items[0]).toMatchObject({ hsn: '5402', gstPercent: 5, taxable: 20000, cgst: 500, sgst: 500, igst: 0, amount: 21000 });
    // 1505 at 18% is 270.90: 135.45 each.
    expect(po.items[1]).toMatchObject({ gstPercent: 18, taxable: 1505, cgst: 135.45, sgst: 135.45, igst: 0 });
    expect(po.tax.totals).toEqual({ taxable: 21505, cgst: 635.45, sgst: 635.45, igst: 0, tax: 1270.9, roundOff: 0.1, grand: 22776 });
    // What has arrived is still said alongside.
    expect(po.items[0]).toMatchObject({ received: 0, pending: 100 });
  });

  it('from a supplier in another state: IGST at the full rate', async () => {
    const a = await material({ gstPercent: 5 });
    const res = await raise(await outside(), [line(a)]);
    const po = (await detail(res.body.po)).body.po;
    expect(po.tax.supplyType).toBe('inter');
    expect(po.tax.totals).toMatchObject({ taxable: 20000, cgst: 0, sgst: 0, igst: 1000, grand: 21000 });
  });

  it.each(['composition', 'unregistered'])('from a %s supplier: none, and says why — the line keeps its rate', async (reg) => {
    const a = await material({ gstPercent: 5 });
    const s = await supplier({ gstRegistration: reg });
    const res = await raise(s, [line(a)]);
    const po = (await detail(res.body.po)).body.po;
    expect(po.tax.noGst).toMatch(reg === 'composition' ? /composition dealer/ : /not registered for GST/);
    expect(po.tax.totals).toMatchObject({ taxable: 20000, tax: 0, grand: 20000 });
    // An edit form loading this line must not save 0 over the goods' rate.
    expect(po.items[0].gstPercent).toBe(5);
  });

  it('a line written before PO lines carried GST is priced at the material\'s rate, else the default', async () => {
    const a = await material({ hsn: '5402', gstPercent: 5 });
    const b = await material();
    const s = await local();
    const old = await PurchaseOrder.collection.insertOne({
      supplier: s._id, poNo: 900, status: 'Open', date: new Date(),
      items: [
        { rawMaterial: a._id, price: 100, quantity: 10, receivedQuantity: 0 },
        { rawMaterial: b._id, price: 100, quantity: 10, receivedQuantity: 0 },
      ],
    });
    const po = (await detail({ _id: old.insertedId })).body.po;
    expect(po.items.map((l) => [l.hsn, l.gstPercent, l.cgst])).toEqual([['5402', 5, 25], ['', 12, 60]]);
    expect(po.tax.totals.grand).toBe(2170);
  });

  it('the list carries each PO\'s total with GST, worked out the same way', async () => {
    const a = await material({ gstPercent: 5 });
    await raise(await local(), [line(a)]);
    await raise(await supplier({ gstRegistration: 'composition' }), [line(a)]);
    const res = await get('/supplier/get-pos');
    expect(res.status).toBe(200);
    const grands = res.body.pos.map((p) => p.tax.totals.grand).sort((x, y) => x - y);
    expect(grands).toEqual([20000, 21000]);
    // The list's existing shape is unchanged.
    expect(res.body.pos[0].supplier.name).toMatch(/Kumar Yarns/);
    expect(res.body.pos[0].items[0].rawMaterial.name).toMatch(/Nylon/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('editing and cloning a PO', () => {
  it('an edit can change a line\'s HSN and rate, and the trail says so', async () => {
    const a = await material({ hsn: '5402', gstPercent: 5 });
    const created = (await raise(await local(), [line(a)])).body.po;
    const res = await put('/supplier/edit-po', {
      poId: created._id, auditReason: 'Supplier billed 12%',
      items: [line(a, { hsn: '54024700', gstPercent: 12 })],
    });
    expect(res.status).toBe(200);
    const stored = await PurchaseOrder.findById(created._id).lean();
    expect(stored.items[0]).toMatchObject({ hsn: '54024700', gstPercent: 12 });
    const trail = stored.fingerprints.at(-1).meta;
    expect(trail.before.items[0]).toMatchObject({ hsn: '5402', gstPercent: 5 });
    expect(trail.after.items[0]).toMatchObject({ hsn: '54024700', gstPercent: 12 });
  });

  it('a clone is bought at the same rates; an old source line takes the material\'s', async () => {
    const a = await material({ hsn: '5402', gstPercent: 5 });
    const b = await material({ hsn: '4007', gstPercent: 18 });
    const s = await local();
    const typed = (await raise(s, [line(a, { gstPercent: 12, hsn: '54024700' })])).body.po;
    const cloned = await post('/supplier/clone-po', { id: typed._id });
    expect(cloned.status).toBe(201);
    expect((await PurchaseOrder.findById(cloned.body.po._id).lean()).items[0]).toMatchObject({ hsn: '54024700', gstPercent: 12 });

    const old = await PurchaseOrder.collection.insertOne({
      supplier: s._id, poNo: 901, status: 'Completed', date: new Date(),
      items: [{ rawMaterial: b._id, price: 100, quantity: 10, receivedQuantity: 10 }],
    });
    const fromOld = await post('/supplier/clone-po', { id: String(old.insertedId) });
    expect(fromOld.status).toBe(201);
    expect((await PurchaseOrder.findById(fromOld.body.po._id).lean()).items[0]).toMatchObject({ hsn: '4007', gstPercent: 18, receivedQuantity: 0 });
  });

  it('a PO raised from a shortfall takes each material\'s rate', async () => {
    const a = await material({ hsn: '5402', gstPercent: 5 });
    const b = await material();
    const s = await local();
    const { createShortfallPos } = require('../../services/shortfallPo');
    const [made] = await createShortfallPos([
      { rawMaterial: a._id, supplierId: String(s._id), supplierName: s.name, name: a.name, toBuy: 10, unitPrice: 300 },
      { rawMaterial: b._id, supplierId: String(s._id), supplierName: s.name, name: b.name, toBuy: 5, unitPrice: 100 },
    ]);
    const stored = await PurchaseOrder.findById(made.poId).lean();
    expect(stored.items.map((l) => [l.hsn, l.gstPercent])).toEqual([['5402', 5], ['', 12]]);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a bill against the PO is pre-filled at its rates', () => {
  async function received(s, items) {
    const po = (await raise(s, items)).body.po;
    for (const it of items) {
      const r = await post('/supplier/inward-stock', { poId: po._id, items: [{ rawMaterial: it.rawMaterial, quantity: it.quantity }] });
      expect(r.status).toBeLessThan(300);
    }
    return po;
  }

  it('each line at the PO line\'s HSN and rate', async () => {
    const a = await material({ hsn: '5402', gstPercent: 5 });
    const b = await material({ hsn: '4007', gstPercent: 18 });
    const po = await received(await local(), [line(a, { quantity: 10 }), line(b, { quantity: 4, gstPercent: 12, hsn: '40070010' })]);
    const res = await get(`/accounts/bills/po-info?id=${po._id}`);
    expect(res.status).toBe(200);
    const byMaterial = Object.fromEntries(res.body.lines.map((l) => [l.rawMaterial, [l.hsn, l.gstPercent]]));
    expect(byMaterial[String(a._id)]).toEqual(['5402', 5]);
    expect(byMaterial[String(b._id)]).toEqual(['40070010', 12]);
  });

  it('at 0% from a composition dealer, whose bill with GST on it would be refused', async () => {
    const a = await material({ hsn: '5402', gstPercent: 5 });
    const po = await received(await supplier({ gstRegistration: 'composition' }), [line(a, { quantity: 10 })]);
    const res = await get(`/accounts/bills/po-info?id=${po._id}`);
    expect(res.body.lines[0]).toMatchObject({ hsn: '5402', gstPercent: 0 });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the PO document', () => {
  const { poToContext } = require('../../services/pdf/poContext');

  it('prints HSN and rate on each line, and the GST under the taxable value', () => {
    const ctx = poToContext({
      poNo: 5, supplier: { name: 'Kumar', gstin: '33AAACK1234M1Z2' },
      items: [
        { rawMaterial: { name: 'Nylon', unit: 'kg', hsn: '5402', gstPercent: 5 }, quantity: 100, price: 200 },
        { rawMaterial: { name: 'Rubber', unit: 'kg' }, quantity: 10, price: 100, hsn: '4007', gstPercent: 5 },
      ],
    }, {}, { ourState: '33', defaultGst: 12 });
    expect(ctx.rows[0]).toMatchObject({ hsn: '5402', gst: '5%', amount: 20000, taxAmount: 1000, total: 21000 });
    expect(ctx.rows[1]).toMatchObject({ hsn: '4007', gst: '5%', amount: 1000, taxAmount: 50, total: 1050 });
    expect(ctx.fields).toMatchObject({
      totalAmount: 'Rs. 21,000', taxableAmount: 'Rs. 21,000',
      tax1Label: 'CGST @ 2.5%', tax1Amount: 'Rs. 525', tax2Label: 'SGST @ 2.5%', tax2Amount: 'Rs. 525',
      taxAmount: 'Rs. 1,050', grandTotal: 'Rs. 22,050', roundOffLabel: '', roundOff: '',
      amountInWords: 'Rupees Twenty Two Thousand Fifty Only',
    });
  });

  it('one IGST line for a supplier outside our state; no rate in the label when the lines differ', () => {
    const ctx = poToContext({
      poNo: 6, supplier: { name: 'Mumbai Yarns', gstin: '27AAACK1234M1Z9' },
      items: [
        { rawMaterial: { name: 'A' }, quantity: 1, price: 100, gstPercent: 5 },
        { rawMaterial: { name: 'B' }, quantity: 1, price: 100, gstPercent: 18 },
      ],
    }, {}, { ourState: '33' });
    expect(ctx.fields).toMatchObject({ tax1Label: 'IGST', tax1Amount: 'Rs. 23', tax2Label: '', tax2Amount: '', grandTotal: 'Rs. 223' });
  });

  it('says there is no GST from a composition dealer', () => {
    const ctx = poToContext({
      poNo: 7, supplier: { name: 'Small Mill', gstRegistration: 'composition' },
      items: [{ rawMaterial: { name: 'A', gstPercent: 5 }, quantity: 2, price: 100 }],
    }, {}, { ourState: '33' });
    expect(ctx.rows[0].gst).toBe('—');
    expect(ctx.fields).toMatchObject({ tax1Label: expect.stringMatching(/No GST/), grandTotal: 'Rs. 200' });
  });

  it('the rendered PDF carries them', async () => {
    const { pdfText } = require('../helpers/pdfText');
    const a = await material({ name: 'Nylon 40D', hsn: '5402', gstPercent: 5 });
    const po = (await raise(await local(), [line(a, { quantity: 100, price: 200 })])).body.po;
    const res = await request(app).get(`/api/v2/supplier/po/${po._id}/pdf`).set('Cookie', cookie())
      .buffer(true).parse((r, cb) => { const d = []; r.on('data', (c) => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    for (const s of ['5402', '5%', 'CGST @ 2.5%', 'SGST @ 2.5%', 'Rs. 500', 'GRAND TOTAL', 'Rs. 21,000', 'Twenty One Thousand']) {
      expect(text).toContain(s);
    }
  });
});
