'use strict';
// ══════════════════════════════════════════════════════════════════
//  EXPORT / SEZ INVOICES, AND THE SALES AND PURCHASE REGISTERS
//
//    Under LUT an export is zero-rated: no tax on any line, place of
//    supply 96, the buyer URP on the e-invoice with ExpDtls, table 6A
//    (WOPAY) in GSTR-1, the export sales ledger in Tally. With payment
//    it carries IGST whatever the buyer's state. Without an LUT on file
//    the zero-rated kind is refused. The shipping bill is added later.
//    The registers list every outward and inward document of a period
//    with its tax split, totals and status.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Elastic', 'Order', 'DeliveryChallan', 'Invoice', 'Supplier', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'reg3@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road'], phone: '9876543210', invoice: { city: 'Erode', pincode: '638052', defaultHsn: '5806', defaultGstPercent: 5, stateCode: '33' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let seq = 0;
const makeElastic = (over = {}) => M.Elastic.create({ name: `20mm Knitted ${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 5000, hsn: '5806', gstPercent: 5, ...over });
const makeCustomer = (over = {}) => M.Customer.create({ name: 'Hamburg Trims GmbH', contactName: 'Anna', phoneNumber: '9000000001', address: 'Hafenstrasse 4', city: 'Hamburg', pincode: '', country: 'Germany', currency: 'EUR', ...over });
const makeOrder = (customer, lines) => M.Order.create({ customer: customer._id, po: 'PO-DE-1', date: new Date('2026-10-01'), supplyDate: new Date('2026-10-20'), status: 'InProgress', elasticOrdered: lines.map((l) => ({ elastic: l.elastic._id, quantity: l.quantity, rate: l.rate })) });
let dcSeq = 0;
const makeDc = (order, items, over = {}) => M.DeliveryChallan.create({ dcNumber: `E-26/27-${String(++dcSeq).padStart(4, '0')}`, type: 'elastic', financialYear: '26/27', sequence: dcSeq, order: order._id, orderNo: order.orderNo, customerName: 'Hamburg Trims GmbH', status: 'dispatched', dispatchDate: new Date('2026-10-10'), items: items.map((i) => ({ elastic: i.elastic._id, elasticName: i.elastic.name, unit: 'm', quantity: i.quantity, rate: 0 })), totalQuantity: items.reduce((a, i) => a + i.quantity, 0), ...over });
async function scene(customerOver = {}) {
  const customer = await makeCustomer(customerOver);
  const a = await makeElastic();
  const order = await makeOrder(customer, [{ elastic: a, quantity: 1000, rate: 20 }]);
  const dc = await makeDc(order, [{ elastic: a, quantity: 1000 }]);
  return { customer, a, order, dc };
}
const lut = () => put('/accounts/settings', { lut: { number: 'AD330326000123K', validFrom: '2026-04-01', validTo: '2027-03-31' } });

describe('export invoices', () => {
  it('suggests export from the customer file, refuses LUT without one, and zero-rates under it', async () => {
    const { order, dc } = await scene();
    const info = (await get(`/invoice/order-info?id=${order._id}`)).body;
    expect(info.export.suggested).toBe('EXPWOP');
    expect(info.export.currency).toBe('EUR');
    expect(info.export.kinds.map((k) => k.kind)).toEqual(['EXPWP', 'EXPWOP', 'SEZWP', 'SEZWOP', 'DEXP']);

    const refused = await post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: '2026-10-12', export: { kind: 'EXPWOP', currency: 'EUR', exchangeRate: 90.5, countryCode: 'DE', portCode: 'INMAA1' } });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/Letter of Undertaking/);

    expect((await lut()).body.settings.lut.number).toBe('AD330326000123K');
    const r = await post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: '2026-10-12', export: { kind: 'EXPWOP', currency: 'EUR', exchangeRate: 90.5, countryCode: 'DE', portCode: 'INMAA1' } });
    expect(r.status).toBe(201);
    const inv = r.body.invoice;
    expect(inv.supplyType).toBe('export');
    expect(inv.placeOfSupply).toBe('96');
    expect(inv.totals).toMatchObject({ taxable: 20000, cgst: 0, sgst: 0, igst: 0, tax: 0, grand: 20000 });
    expect(inv.lines[0].gstPercent).toBe(0);
    expect(inv.export).toMatchObject({ kind: 'EXPWOP', currency: 'EUR', exchangeRate: 90.5, countryCode: 'DE', portCode: 'INMAA1', lut: { number: 'AD330326000123K' } });
    // No GSTIN or PIN abroad: the portal does not want them.
    expect(inv.einvoiceProblems).toEqual([]);

    const json = (await get(`/invoice/${inv._id}/einvoice.json`)).body;
    expect(json.TranDtls.SupTyp).toBe('EXPWOP');
    expect(json.BuyerDtls).toMatchObject({ Gstin: 'URP', Pos: '96', Stcd: '96', Pin: 999999 });
    expect(json.ExpDtls).toEqual({ Port: 'INMAA1', RefClm: 'N', ForCur: 'EUR', CntCode: 'DE' });
    expect(json.ValDtls.TotInvValFc).toBe(220.99);

    // The shipping bill comes from customs later.
    const sb = await post(`/invoice/${inv._id}/export`, { shippingBill: { number: '7745123', date: '2026-10-15' } });
    expect(sb.status).toBe(200);
    expect(sb.body.invoice.export.shippingBill.number).toBe('7745123');
    expect((await get(`/invoice/${inv._id}/einvoice.json`)).body.ExpDtls).toMatchObject({ ShipBNo: '7745123', ShipBDt: '15/10/2026' });

    const g1 = (await get('/accounts/gstr1?month=2026-10')).body;
    expect(g1.b2b).toEqual([]);
    expect(g1.exp).toEqual([expect.objectContaining({ exp_typ: 'WOPAY', inv: [expect.objectContaining({ inum: inv.invoiceNumber, val: 20000, sbnum: '7745123', sbpcode: 'INMAA1', itms: [{ txval: 20000, rt: 0, iamt: 0, csamt: 0 }] })] })]);
    expect(g1.summary.exp.txval).toBe(20000);
    const json1 = (await get('/accounts/gstr1/json?month=2026-10')).body;
    expect(json1.exp[0].inv[0].customer).toBeUndefined();

    const pdf = await request(app).get(`/api/v2/invoice/${inv._id}/pdf`).set('Cookie', cookie()).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 5).toString()).toBe('%PDF-');

    const tally = require('../../services/tallyExport');
    const built = await tally.build({ from: new Date('2026-10-01'), to: new Date('2026-10-31'), fresh: true, L: { sales: 'Sales', exportSales: 'Export Sales', roundOff: 'Round Off', outputCgst: 'Output CGST', outputSgst: 'Output SGST', outputIgst: 'Output IGST' } });
    const v = built.vouchers.find((x) => x.docType === 'Invoice');
    expect(v.placeOfSupply).toBe('Other Country');
    expect(v.lines.map((l) => [l.ledger, l.amount])).toEqual([['Hamburg Trims GmbH', 20000], ['Export Sales', -20000]]);
  });

  it('charges IGST on an export with payment, whatever the buyer state, and prices a credit note the same way', async () => {
    const { order, dc } = await scene();
    const r = await post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: '2026-10-12', export: { kind: 'EXPWP', currency: 'USD', exchangeRate: 84, countryCode: 'US' } });
    expect(r.status).toBe(201);
    expect(r.body.invoice.supplyType).toBe('export');
    expect(r.body.invoice.totals).toMatchObject({ taxable: 20000, igst: 1000, cgst: 0, grand: 21000 });
    const g1 = (await get('/accounts/gstr1?month=2026-10')).body;
    expect(g1.exp[0].exp_typ).toBe('WPAY');
    expect(g1.exp[0].inv[0].itms).toEqual([{ txval: 20000, rt: 5, iamt: 1000, csamt: 0 }]);

    const cn = await post('/accounts/notes', { kind: 'credit', against: { doc: r.body.invoice._id }, reason: 'Short shipped 100 m', lines: [{ description: '20mm', quantity: 100, rate: 20, gstPercent: 5 }], date: '2026-10-20' });
    expect(cn.status).toBe(201);
    expect(cn.body.note.supplyType).toBe('export');
    expect(cn.body.note.totals).toMatchObject({ taxable: 2000, igst: 100, cgst: 0, sgst: 0 });
  });

  it('treats an SEZ unit as B2B with the SEWOP marker and a deemed export as DE', async () => {
    await lut();
    const { order, dc } = await scene({ name: 'MEPZ Apparel', gstin: '33AAEPM1111F1Z2', pincode: '600045', country: '', currency: '', sez: true });
    expect((await get(`/invoice/order-info?id=${order._id}`)).body.export.suggested).toBe('SEZWOP');
    const r = await post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: '2026-10-12', export: { kind: 'SEZWOP' } });
    expect(r.status).toBe(201);
    expect(r.body.invoice.supplyType).toBe('sez');
    expect(r.body.invoice.placeOfSupply).toBe('33');
    expect(r.body.invoice.totals.tax).toBe(0);
    const g1 = (await get('/accounts/gstr1?month=2026-10')).body;
    expect(g1.b2b[0].inv[0].inv_typ).toBe('SEWOP');
    expect(g1.exp).toEqual([]);

    const s2 = await scene({ name: 'Tirupur EOU', gstin: '33AAEPE2222F1Z2', pincode: '641604', country: '', currency: '' });
    const d = await post('/invoice/create', { orderId: s2.order._id, dcIds: [s2.dc._id], invoiceDate: '2026-10-13', export: { kind: 'DEXP' } });
    expect(d.status).toBe(201);
    expect(d.body.invoice.supplyType).toBe('intra');
    expect(d.body.invoice.totals.cgst).toBe(500);
    const g = (await get('/accounts/gstr1?month=2026-10')).body;
    expect(g.b2b.find((x) => x.ctin === '33AAEPE2222F1Z2').inv[0].inv_typ).toBe('DE');
  });
});

describe('sales and purchase registers', () => {
  it("lists the period's documents with the tax split, marks cancelled ones, and totals the rest", async () => {
    const { order, dc } = await scene({ name: 'Sunrise Garments', gstin: '33AAEPS1111F1Z2', pincode: '641604', country: '', currency: '' });
    const inv = (await post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: '2026-10-12' })).body.invoice;
    expect(inv.totals.grand).toBe(21000);
    const cn = (await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference', lines: [{ description: '20mm', quantity: 100, rate: 2, gstPercent: 5 }], date: '2026-10-20' })).body.note;
    const sales = (await get('/accounts/registers/sales?from=2026-10-01&to=2026-10-31')).body;
    expect(sales.rows.map((r) => [r.kind, r.docNo])).toEqual([['Invoice', inv.invoiceNumber], ['Credit note', cn.noteNo]]);
    expect(sales.rows[0]).toMatchObject({ taxable: 20000, cgst: 500, sgst: 500, grand: 21000, byRate: { 5: 20000 }, state: 'Tamil Nadu', outstanding: 20790 });
    expect(sales.totals).toMatchObject({ count: 2, taxable: 19800, cgst: 495, sgst: 495, grand: 20790, byRate: { 5: 19800 } });

    const s = await M.Supplier.create({ name: 'Erode Dyers', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
    const b = (await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'D/9', kind: 'service', billDate: '2026-10-02', lines: [{ description: 'Dyeing', quantity: 1, rate: 8000, gstPercent: 5 }] })).body.bill;
    const b2 = (await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'D/10', kind: 'service', billDate: '2026-10-03', lines: [{ description: 'Dyeing', quantity: 1, rate: 1000, gstPercent: 5 }] })).body.bill;
    expect((await post(`/accounts/bills/${b2._id}/cancel`, { reason: 'Entered twice, duplicate' })).status).toBe(200);
    const pur = (await get('/accounts/registers/purchase?from=2026-10-01&to=2026-10-31')).body;
    expect(pur.rows.map((r) => [r.docNo, r.cancelled])).toEqual([[b.billNo, false], [b2.billNo, true]]);
    expect(pur.rows[0]).toMatchObject({ refNo: 'D/9', taxable: 8000, cgst: 200, sgst: 200, grand: 8400, itc: true, outstanding: 8400 });
    expect(pur.totals).toMatchObject({ count: 2, cancelled: 1, taxable: 8000, grand: 8400, itc: 400 });

    const xlsx = await request(app).get('/api/v2/accounts/registers/sales?from=2026-10-01&to=2026-10-31&format=xlsx').set('Cookie', cookie()).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.body.length).toBeGreaterThan(2000);
  });
});
