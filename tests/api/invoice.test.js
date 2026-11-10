'use strict';
// ══════════════════════════════════════════════════════════════════
//  TAX INVOICES, RAISED AGAINST AN ORDER'S CHALLANS
//
//    • the form is told which challans can go on an invoice, the
//      lines priced from the order, the HSN and GST % from Settings
//    • raising one draws INV/<FY>/0001, snapshots both parties, and
//      splits the tax CGST+SGST for a buyer in the seller's state and
//      IGST for one outside it
//    • a challan on an issued invoice cannot go on a second one; a
//      cancelled invoice frees it
//    • the PDF says what the invoice says; the INV-01 JSON is the
//      portal's shape
//    • the IRN: refused until the record is complete, refused with no
//      provider connected, accepted when pasted from the portal
//    • the order and customer pages get their cards
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.PDF_IN_THREAD = '1';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
// A replica set: an invoice and its row on the customer's account are
// written in one transaction.
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, Order, Customer, Elastic, DeliveryChallan, Invoice, User, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const asPdf = (r) => r.buffer(true).parse((res, cb) => {
  const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d)));
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Order = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic = require('../../models/Elastic');
  DeliveryChallan = require('../../models/DeliveryChallan');
  Invoice = require('../../models/Invoice');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'inv@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users'].includes(c.collectionName)) await c.deleteMany({});
  }
});

// The seller, as Settings holds it.
const seller = (over = {}) => put('/settings/document', {
  companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road', 'Perundurai'],
  phone: '9876543210',
  invoice: { city: 'Erode', pincode: '638052', defaultHsn: '5806', defaultGstPercent: 5,
    bank: { name: 'SBI', account: '1234567890', ifsc: 'SBIN0001234', branch: 'Erode', upiId: 'balu@sbi' }, ...over },
});

let seq = 0;
const makeElastic = (over = {}) => Elastic.create({
  name: `20mm Knitted ${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 5000, ...over,
});
const makeCustomer = (over = {}) => Customer.create({
  name: 'Sunrise Garments', contactName: 'Ravi', phoneNumber: '9000000001', gstin: '33AAEPS1111F1Z2',
  address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604', ...over,
});
const makeOrder = (customer, lines) => Order.create({
  customer: customer._id, po: 'PO-77', date: new Date(), supplyDate: new Date(), status: 'InProgress',
  elasticOrdered: lines.map((l) => ({ elastic: l.elastic._id, quantity: l.quantity, rate: l.rate })),
});
let dcSeq = 0;
const makeDc = (order, items, over = {}) => DeliveryChallan.create({
  dcNumber: `E-26/27-${String(++dcSeq).padStart(4, '0')}`, type: 'elastic', financialYear: '26/27', sequence: dcSeq,
  order: order._id, orderNo: order.orderNo, customerName: 'Sunrise Garments', status: 'dispatched',
  dispatchDate: new Date('2026-07-10'),
  items: items.map((i) => ({ elastic: i.elastic._id, elasticName: i.elastic.name, unit: 'm', quantity: i.quantity, rate: 0 })),
  totalQuantity: items.reduce((a, i) => a + i.quantity, 0),
  ...over,
});

/** A customer, an order with two priced lines, two challans out. */
async function scene(customerOver = {}) {
  await seller();
  const customer = await makeCustomer(customerOver);
  const a = await makeElastic();
  const b = await makeElastic({ hsn: '5604', gstPercent: 12 });
  const order = await makeOrder(customer, [{ elastic: a, quantity: 1000, rate: 12.5 }, { elastic: b, quantity: 300, rate: 40 }]);
  const dc1 = await makeDc(order, [{ elastic: a, quantity: 600 }]);
  const dc2 = await makeDc(order, [{ elastic: a, quantity: 400 }, { elastic: b, quantity: 300 }]);
  const draft = await makeDc(order, [{ elastic: a, quantity: 50 }], { status: 'draft' });
  return { customer, a, b, order, dc1, dc2, draft };
}

describe('what an invoice for this order would hold', () => {
  it('lists the challans that have left and are not invoiced, with the lines priced from the order', async () => {
    const { order, dc1, dc2, draft, a, b } = await scene();
    const res = await get(`/invoice/order-info?id=${order._id}`);
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.dcs.map((d) => [d.dcNumber, d]));
    expect(by[dc1.dcNumber].eligible).toBe(true);
    expect(by[dc2.dcNumber].eligible).toBe(true);
    expect(by[draft.dcNumber].eligible).toBe(false);
    expect(res.body.supplyType).toBe('intra');
    expect(res.body.seller).toMatchObject({ gstin: '33AAECB1234F1Z5', stateCode: '33', city: 'Erode', pincode: '638052' });
    expect(res.body.buyer).toMatchObject({ name: 'Sunrise Garments', stateCode: '33', pincode: '641604' });
    // No consignee address on the challans: the goods went to the billing address.
    expect(res.body.shipTo).toBe('4 Kongu Nagar, Tiruppur - 641604');
    const lines = Object.fromEntries(res.body.lines.map((l) => [l.name, l]));
    // Merged across the two challans; HSN and GST from Settings unless the elastic says otherwise.
    expect(lines[a.name]).toMatchObject({ quantity: 1000, rate: 12.5, hsn: '5806', gstPercent: 5, rateSource: 'order' });
    expect(lines[a.name].dcNumbers).toEqual([dc1.dcNumber, dc2.dcNumber]);
    expect(lines[b.name]).toMatchObject({ quantity: 300, rate: 40, hsn: '5604', gstPercent: 12 });
    expect(res.body.problems).toEqual([]);
  });

  it('a bad order id is a 404', async () => {
    expect((await get('/invoice/order-info?id=nope')).status).toBe(404);
  });
});

describe('raising an invoice', () => {
  it('draws INV/<FY>/0001, snapshots both parties and splits CGST + SGST in-state', async () => {
    const { order, dc1, dc2, a, b, customer } = await scene();
    const res = await post('/invoice/create', {
      orderId: order._id, dcIds: [dc1._id, dc2._id], invoiceDate: '2026-07-12', requestId: 'r1',
      shipTo: 'Gate 2, Kongu Nagar, Tiruppur', lines: [{ elastic: b._id, boxes: 3 }],
    });
    expect(res.status).toBe(201);
    const inv = res.body.invoice;
    expect(inv.invoiceNumber).toBe('INV/2026-27/0001');
    expect(inv.shipTo).toBe('Gate 2, Kongu Nagar, Tiruppur');
    expect(inv.totalBoxes).toBe(3);
    expect(inv.status).toBe('issued');
    expect(inv.supplyType).toBe('intra');
    expect(inv.placeOfSupply).toBe('33');
    expect(inv.customerPo).toBe('PO-77');
    expect(inv.buyer).toMatchObject({ name: 'Sunrise Garments', gstin: '33AAEPS1111F1Z2', address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604', stateCode: '33' });
    expect(inv.seller).toMatchObject({ name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road, Perundurai', stateCode: '33' });
    expect(inv.dcs.map((d) => d.dcNumber)).toEqual([dc1.dcNumber, dc2.dcNumber]);
    const la = inv.lines.find((l) => l.name === a.name);
    const lb = inv.lines.find((l) => l.name === b.name);
    // 1000 × 12.5 = 12,500 at 5% → 312.50 CGST + 312.50 SGST
    expect(la).toMatchObject({ quantity: 1000, rate: 12.5, taxable: 12500, gstPercent: 5, cgst: 312.5, sgst: 312.5, igst: 0, amount: 13125 });
    // 300 × 40 = 12,000 at 12% → 720 + 720
    expect(lb).toMatchObject({ taxable: 12000, gstPercent: 12, cgst: 720, sgst: 720, amount: 13440, boxes: 3 });
    expect(inv.totals).toMatchObject({ taxable: 24500, cgst: 1032.5, sgst: 1032.5, igst: 0, tax: 2065, roundOff: 0, grand: 26565 });
    expect(inv.amountInWords).toBe('Rupees Twenty Six Thousand Five Hundred Sixty Five Only');
    expect(inv.einvoice.status).toBe('pending');
    expect(inv.einvoiceProblems).toEqual([]);
    expect(inv.fingerprints[0].code).toBe('INVOICE_CREATED');
    expect(String(inv.customer)).toBe(String(customer._id));

    // The same request again is the same invoice, not a second number.
    const again = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id, dc2._id], requestId: 'r1' });
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    expect(await Invoice.countDocuments()).toBe(1);
  });

  it('a buyer in another state gets IGST, and a rate typed on the form wins', async () => {
    const { order, dc1, a } = await scene({ gstin: '29AAEPS1111F1Z2', stateCode: '' });
    const res = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id], lines: [{ elastic: a._id, rate: 10, hsn: '58063990' }] });
    expect(res.status).toBe(201);
    const inv = res.body.invoice;
    expect(inv.supplyType).toBe('inter');
    expect(inv.placeOfSupply).toBe('29');
    expect(inv.buyer.stateCode).toBe('29');
    // 600 × 10 = 6,000 at 5% → 300 IGST
    expect(inv.lines[0]).toMatchObject({ rate: 10, hsn: '58063990', taxable: 6000, igst: 300, cgst: 0, sgst: 0, amount: 6300 });
    expect(inv.totals).toMatchObject({ igst: 300, grand: 6300 });
  });

  it('numbers run on within the year and the total rounds to the rupee', async () => {
    const { order, dc1, dc2, a } = await scene();
    const one = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id], lines: [{ elastic: a._id, rate: 12.345 }] });
    expect(one.status).toBe(201);
    // 600 × 12.345 = 7,407 at 5% → 370.35 → 7,777.35 → 7,777 with −0.35 off
    expect(one.body.invoice.totals).toMatchObject({ taxable: 7407, tax: 370.35, roundOff: -0.35, grand: 7777 });
    const two = await post('/invoice/create', { orderId: order._id, dcIds: [dc2._id] });
    expect(two.status).toBe(201);
    expect(two.body.invoice.invoiceNumber).toBe('INV/2026-27/0002');
  });

  it('refuses a challan already invoiced, a draft one, one of another order, and an unpriced line', async () => {
    const { order, dc1, dc2, draft, a, customer } = await scene();
    expect((await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] })).status).toBe(201);
    const twice = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] });
    expect(twice.status).toBe(409);
    expect(twice.body.message).toMatch(/already on invoice INV\/2026-27\/0001/);
    const d = await post('/invoice/create', { orderId: order._id, dcIds: [draft._id] });
    expect(d.status).toBe(409);
    expect(d.body.message).toMatch(/is draft/);
    const other = await makeOrder(customer, [{ elastic: a, quantity: 10, rate: 1 }]);
    expect((await post('/invoice/create', { orderId: other._id, dcIds: [dc2._id] })).status).toBe(400);
    const unpriced = await makeOrder(customer, [{ elastic: a, quantity: 10, rate: 0 }]);
    const dcu = await makeDc(unpriced, [{ elastic: a, quantity: 10 }]);
    const u = await post('/invoice/create', { orderId: unpriced._id, dcIds: [dcu._id] });
    expect(u.status).toBe(409);
    expect(u.body.message).toMatch(/No rate for/);
    expect((await post('/invoice/create', { orderId: order._id, dcIds: [] })).status).toBe(400);
    expect((await post('/invoice/create', { orderId: order._id, dcIds: [dc2._id], invoiceDate: 'soon' })).status).toBe(400);
  });
});

describe('the printed invoice and the e-invoice JSON', () => {
  it('the PDF carries the number, both GSTINs, the HSN and the tax split', async () => {
    const { order, dc1, dc2 } = await scene();
    const { body: { invoice: inv } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id, dc2._id] });
    const res = await asPdf(get(`/invoice/${inv._id}/pdf`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(res.body);
    expect(text).toMatch(/TAX INVOICE/);
    expect(text).toMatch(/INV\/2026-27\/0001/);
    expect(text).toMatch(/33AAECB1234F1Z5/);
    expect(text).toMatch(/33AAEPS1111F1Z2/);
    expect(text).toMatch(/5806/);
    expect(text).toMatch(/5604/);
    expect(text).toMatch(/CGST/);
    expect(text).toMatch(/26,565\.00/);
    expect(text).toMatch(/Twenty Six Thousand Five Hundred Sixty Five/);
    expect(text).toMatch(/SBIN0001234/);
    expect(text).toMatch(new RegExp(dc1.dcNumber.replace(/[-/]/g, '\\$&')));
    // Not registered yet: no IRN on the paper.
    expect(text).not.toMatch(/Ack no/i);
  });

  it('the JSON is the portal\'s INV-01 shape', async () => {
    const { order, dc1, dc2, a } = await scene();
    const { body: { invoice: inv } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id, dc2._id], invoiceDate: '2026-07-12' });
    const res = await get(`/invoice/${inv._id}/einvoice.json`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/INV-2026-27-0001-einvoice\.json/);
    const j = JSON.parse(res.text);
    expect(j.Version).toBe('1.1');
    expect(j.TranDtls).toEqual({ TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' });
    expect(j.DocDtls).toEqual({ Typ: 'INV', No: 'INV/2026-27/0001', Dt: '12/07/2026' });
    expect(j.SellerDtls).toMatchObject({ Gstin: '33AAECB1234F1Z5', LglNm: 'Balu Elastics', Loc: 'Erode', Pin: 638052, Stcd: '33' });
    expect(j.BuyerDtls).toMatchObject({ Gstin: '33AAEPS1111F1Z2', Pos: '33', Pin: 641604, Stcd: '33' });
    const item = j.ItemList.find((i) => i.PrdDesc === a.name);
    expect(item).toMatchObject({ IsServc: 'N', HsnCd: '5806', Qty: 1000, Unit: 'MTR', UnitPrice: 12.5, AssAmt: 12500, GstRt: 5, CgstAmt: 312.5, SgstAmt: 312.5, IgstAmt: 0, TotItemVal: 13125 });
    expect(j.ValDtls).toEqual({ AssVal: 24500, CgstVal: 1032.5, SgstVal: 1032.5, IgstVal: 0, RndOffAmt: 0, TotInvVal: 26565 });
    expect(j.RefDtls.ContrDtls[0].PoRefr).toBe('PO-77');
  });
});

describe('the IRN', () => {
  it('is refused until the record is complete, naming what to fix', async () => {
    const { order, dc1 } = await scene({ pincode: '', address: '' });
    const { body: { invoice: inv } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] });
    expect(inv.einvoiceProblems).toEqual(expect.arrayContaining([
      expect.stringMatching(/Sunrise Garments has no PIN code/),
      expect.stringMatching(/Sunrise Garments has no billing address/),
    ]));
    const res = await post(`/invoice/${inv._id}/register-irn`, {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EINVOICE_NOT_READY');
    expect(res.body.details.problems).toHaveLength(2);
  });

  it('with no provider connected, says so and offers the paste route', async () => {
    const { order, dc1 } = await scene();
    const { body: { invoice: inv } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] });
    const res = await post(`/invoice/${inv._id}/register-irn`, {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EINVOICE_NOT_CONFIGURED');
    expect(res.body.message).toMatch(/paste the IRN/);
  });

  it('pasted from the portal: checked, stored once, printed with its QR', async () => {
    const { order, dc1, dc2 } = await scene();
    const { body: { invoice: inv } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] });
    expect((await post(`/invoice/${inv._id}/irn`, { irn: 'not-an-irn' })).status).toBe(400);
    const irn = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
    const ok = await post(`/invoice/${inv._id}/irn`, { irn: irn.toUpperCase(), ackNo: '112010012345678', ackDate: '2026-07-12T10:30:00Z', signedQr: 'eyJhbGciOiJSUzI1NiJ9.signed.qr' });
    expect(ok.status).toBe(200);
    expect(ok.body.invoice.einvoice).toMatchObject({ status: 'registered', irn, ackNo: '112010012345678', provider: 'manual', signedQr: 'eyJhbGciOiJSUzI1NiJ9.signed.qr' });
    expect(ok.body.invoice.fingerprints.map((f) => f.code)).toEqual(['INVOICE_CREATED', 'INVOICE_IRN_REGISTERED']);
    expect((await post(`/invoice/${inv._id}/irn`, { irn })).status).toBe(409);

    const { body: { invoice: second } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc2._id] });
    const clash = await post(`/invoice/${second._id}/irn`, { irn });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/already on invoice INV\/2026-27\/0001/);

    const pdf = await asPdf(get(`/invoice/${inv._id}/pdf`));
    const text = pdfText(pdf.body);
    expect(text).toMatch(/IRN/);
    expect(text).toMatch(/Ack No/);
    expect(text).toMatch(new RegExp(irn));
    expect(text).toMatch(/112010012345678/);
    // The QR is an image on the page.
    expect(pdf.body.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  });
});

describe('cancelling', () => {
  it('needs a reason, frees the challans, and says to cancel a pasted IRN at the portal', async () => {
    const { order, dc1 } = await scene();
    const { body: { invoice: inv } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] });
    await post(`/invoice/${inv._id}/irn`, { irn: 'b'.repeat(64) });
    expect((await post(`/invoice/${inv._id}/cancel`, { reason: 'typo' })).status).toBe(400);
    const res = await post(`/invoice/${inv._id}/cancel`, { reason: 'Wrong rate agreed with the buyer' });
    expect(res.status).toBe(200);
    expect(res.body.invoice.status).toBe('cancelled');
    expect(res.body.invoice.einvoice.status).toBe('cancelled');
    expect(res.body.portalNote).toMatch(/cancel it on the e-invoice portal/);
    expect((await post(`/invoice/${inv._id}/cancel`, { reason: 'Wrong rate agreed with the buyer' })).status).toBe(409);
    expect((await post(`/invoice/${inv._id}/irn`, { irn: 'c'.repeat(64) })).status).toBe(409);

    // The challan is free again, and the next invoice takes the next number.
    const info = await get(`/invoice/order-info?id=${order._id}`);
    expect(info.body.dcs.find((d) => d.dcNumber === dc1.dcNumber).eligible).toBe(true);
    const again = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] });
    expect(again.status).toBe(201);
    expect(again.body.invoice.invoiceNumber).toBe('INV/2026-27/0002');

    const pdf = await asPdf(get(`/invoice/${inv._id}/pdf`));
    expect(pdfText(pdf.body)).toMatch(/CANCELLED/);
  });
});

describe('the lists and the cards', () => {
  it('the list searches by number, buyer and challan; the order and customer cards add up', async () => {
    const { order, dc1, dc2, customer } = await scene();
    const { body: { invoice: one } } = await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] });
    await post('/invoice/create', { orderId: order._id, dcIds: [dc2._id] });
    await post(`/invoice/${one._id}/cancel`, { reason: 'Raised against the wrong challan' });

    const list = await get('/invoice/list?search=0002');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.invoices[0].invoiceNumber).toBe('INV/2026-27/0002');
    // What the list needs to say paid, part paid or overdue.
    expect(list.body.invoices[0]).toEqual(expect.objectContaining({ paidAmount: 0 }));
    expect(list.body.invoices[0]).toHaveProperty('dueDate');
    expect((await get('/invoice/list?search=Sunrise')).body.total).toBe(2);
    expect((await get(`/invoice/list?search=${dc1.dcNumber}`)).body.total).toBe(1);
    expect((await get('/invoice/list?status=cancelled')).body.total).toBe(1);

    const byOrder = await get(`/invoice/by-order?id=${order._id}`);
    expect(byOrder.body.totals).toMatchObject({ count: 2, cancelled: 1, registered: 0 });
    // dc2: 400 × 12.5 = 5,000 + 300 × 40 = 12,000 → 17,000 + 5% / 12% → 5,250 + 13,440
    expect(byOrder.body.totals.invoiced).toBe(18690);
    expect(byOrder.body.uninvoicedDcs.map((d) => d.dcNumber)).toEqual([dc1.dcNumber]);

    const byCustomer = await get(`/invoice/by-customer?id=${customer._id}`);
    expect(byCustomer.body.total).toBe(2);
    expect(byCustomer.body.invoiced).toEqual({ amount: 18690, count: 1 });

    const recent = await get(`/customer/${customer._id}/recent`);
    expect(recent.status).toBe(200);
    expect(recent.body.orders.map((o) => o.orderNo)).toEqual([order.orderNo]);
    expect(recent.body.dcs).toHaveLength(3);
    expect(recent.body.dcs.map((d) => d.dcNumber)).toEqual(expect.arrayContaining([dc1.dcNumber, dc2.dcNumber]));
    expect(recent.body.dcTotal).toBe(3);
    expect(recent.body.invoices).toHaveLength(2);
    expect(recent.body.invoiced).toEqual({ amount: 18690, count: 1 });

    expect((await get('/invoice/detail?id=nope')).status).toBe(404);
    expect((await get(`/invoice/detail?id=${one._id}`)).body.invoice.customer.name).toBe('Sunrise Garments');
  });
});

describe('invoice settings', () => {
  it('store the defaults and the bank, keep the GSP secret to themselves, and say when one is connected', async () => {
    const res = await seller({ gsp: { provider: 'http-json', baseUrl: 'https://gsp.example/api', clientId: 'id-1', clientSecret: 's3cret' } });
    expect(res.status).toBe(200);
    expect(res.body.settings.invoice).toMatchObject({ defaultHsn: '5806', defaultGstPercent: 5, city: 'Erode', pincode: '638052' });
    expect(res.body.settings.invoice.bank).toMatchObject({ ifsc: 'SBIN0001234', upiId: 'balu@sbi' });
    expect(res.body.settings.invoice.gsp).toMatchObject({ provider: 'http-json', clientId: 'id-1', configured: true });
    expect(res.body.settings.invoice.gsp.clientSecret).toBeUndefined();

    // Saving the HSN again does not wipe the secret.
    const again = await put('/settings/document', { invoice: { defaultHsn: '5807', gsp: { clientSecret: '' } } });
    expect(again.body.settings.invoice.defaultHsn).toBe('5807');
    expect(again.body.settings.invoice.bank.ifsc).toBe('SBIN0001234');
    expect(again.body.settings.invoice.gsp.configured).toBe(true);
    const got = await get('/settings/document');
    expect(got.body.settings.invoice.gsp.configured).toBe(true);
    expect(got.body.settings.invoice.gsp.clientSecret).toBeUndefined();

    expect((await put('/settings/document', { invoice: { pincode: '12' } })).status).toBe(400);
    expect((await put('/settings/document', { invoice: { defaultGstPercent: 120 } })).status).toBe(400);
  });
});

describe('raised once, whole or not at all', () => {
  const PartyLedgerEntry = () => require('../../models/PartyLedgerEntry');
  const create = (order, dcs, extra = {}) => post('/invoice/create', { orderId: order._id, dcIds: dcs.map((d) => d._id), ...extra });

  it('two people invoicing the same challan at the same moment: one invoice, the other is told it is taken', async () => {
    // Which challans are free was worked out and then the invoice created,
    // so both found the challan free and both invoiced it.
    const { order, dc1 } = await scene();
    const [x, y] = await Promise.all([create(order, [dc1]), create(order, [dc1])]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const refused = x.status === 409 ? x : y;
    expect(refused.body.message).toMatch(/is already on invoice INV\//);
    expect(await Invoice.countDocuments({})).toBe(1);
    expect(await PartyLedgerEntry().countDocuments({ docType: 'Invoice' })).toBe(1);
  });

  it('the same request sent twice at once is one invoice, handed to both, and uses one number', async () => {
    const { order, dc1, dc2 } = await scene();
    const [x, y] = await Promise.all([create(order, [dc1], { requestId: 'tap-1' }), create(order, [dc1], { requestId: 'tap-1' })]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.invoice.invoiceNumber).toBe(y.body.invoice.invoiceNumber);
    expect(await Invoice.countDocuments({})).toBe(1);

    // No number was drawn and thrown away: the next invoice is the next number.
    const first = Number(x.body.invoice.invoiceNumber.split('/').pop());
    const next = await create(order, [dc2]);
    expect(next.status).toBe(201);
    expect(Number(next.body.invoice.invoiceNumber.split('/').pop())).toBe(first + 1);
  });

  it('CONTROL: two different orders are invoiced side by side', async () => {
    const one = await scene();
    const customer = await makeCustomer({ name: 'Zenith Apparel', gstin: '33AAEPZ2222F1Z9' });
    const el = await makeElastic();
    const other = await makeOrder(customer, [{ elastic: el, quantity: 100, rate: 10 }]);
    const dc = await makeDc(other, [{ elastic: el, quantity: 100 }]);
    const [x, y] = await Promise.all([create(one.order, [one.dc1]), create(other, [dc])]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body.invoice.invoiceNumber).not.toBe(y.body.invoice.invoiceNumber);
  });

  it('an invoice that could not be put on the customer\'s account was not issued', async () => {
    // They were two writes. The second failing left an invoice the
    // customer's balance did not know about.
    const partyLedger = require('../../services/partyLedger');
    const { order, dc1 } = await scene();
    const spy = jest.spyOn(partyLedger, 'post').mockImplementation(() => Promise.reject(Object.assign(new Error('write refused'), { name: 'MongoServerError' })));
    const failed = await create(order, [dc1], { requestId: 'tap-2' });
    spy.mockRestore();
    expect(failed.status).toBe(500);
    expect(await Invoice.countDocuments({})).toBe(0);
    expect(await PartyLedgerEntry().countDocuments({})).toBe(0);

    // Sent again, it goes through — whole.
    const again = await create(order, [dc1], { requestId: 'tap-2' });
    expect(again.status).toBe(201);
    const row = await PartyLedgerEntry().findOne({ docType: 'Invoice', doc: again.body.invoice._id }).lean();
    expect(row).toMatchObject({ docNo: again.body.invoice.invoiceNumber, debit: again.body.invoice.totals.grand });
  });
});

// ══════════════════════════════════════════════════════════════════
//  One step at a time with the tax portal.
//
//  Registering reads the invoice, calls the provider (seconds), then
//  writes. Nothing held the invoice in between: a second click read "not
//  registered" too and registered it at the portal again, and a cancel
//  landing in the gap cancelled an invoice whose IRN then arrived live.
// ══════════════════════════════════════════════════════════════════
describe('two requests for one invoice at the portal', () => {
  const IRN = 'b'.repeat(64);
  let calls;
  const connect = async () => {
    const { PROVIDERS } = require('../../services/einvoiceProvider');
    calls = { register: 0, cancel: [] };
    PROVIDERS.slow = () => ({
      async register() {
        calls.register++;
        await new Promise((r) => setTimeout(r, 250)); // the portal takes its time
        return { irn: IRN, ackNo: '112010099', ackDate: new Date('2026-07-12T10:30:00Z'), signedQr: 'signed.qr' };
      },
      async cancel(irn) { calls.cancel.push(irn); },
    });
    await put('/settings/document', { invoice: { gsp: { provider: 'slow', baseUrl: 'https://t', clientId: 'x', clientSecret: 'y' } } });
  };
  afterEach(() => { delete require('../../services/einvoiceProvider').PROVIDERS.slow; });

  const anInvoice = async () => {
    const { order, dc1 } = await scene();
    await connect();
    return (await post('/invoice/create', { orderId: order._id, dcIds: [dc1._id] })).body.invoice;
  };

  it('a second click on Register does not register it at the portal again', async () => {
    const inv = await anInvoice();
    const both = await Promise.all([
      post(`/invoice/${inv._id}/register-irn`, {}),
      post(`/invoice/${inv._id}/register-irn`, {}),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409).body.message).toBe(`Already registered — IRN ${IRN}`);
    expect(calls.register).toBe(1);
    const stored = await Invoice.findById(inv._id).lean();
    expect(stored.einvoice).toMatchObject({ status: 'registered', irn: IRN });
    expect(stored.fingerprints.filter((f) => f.code === 'INVOICE_IRN_REGISTERED')).toHaveLength(1);
  });

  it('a cancel sent while it is being registered waits, and takes the IRN with it', async () => {
    const inv = await anInvoice();
    const registering = post(`/invoice/${inv._id}/register-irn`, {}).then((r) => r);
    await new Promise((r) => setTimeout(r, 60)); // the registration is at the portal now
    const cancelled = await post(`/invoice/${inv._id}/cancel`, { reason: 'raised against the wrong challan' });
    expect((await registering).status).toBe(200);
    expect(cancelled.status).toBe(200);

    // Cancelled at the portal as well — not left there with a live IRN.
    expect(calls.cancel).toEqual([IRN]);
    const stored = await Invoice.findById(inv._id).lean();
    expect(stored.status).toBe('cancelled');
    expect(stored.einvoice).toMatchObject({ status: 'cancelled', irn: IRN });
  });

  it('CONTROL: one request is answered as it always was, and leaves no lease behind', async () => {
    const inv = await anInvoice();
    const res = await post(`/invoice/${inv._id}/register-irn`, {});
    expect(res.status).toBe(200);
    expect(res.body.invoice.einvoice).toMatchObject({ status: 'registered', irn: IRN, provider: 'slow' });
    // The lease is let go just after the answer is sent, so it is given a moment.
    const leases = () => mongoose.connection.collection('leases').countDocuments({});
    for (let i = 0; i < 100 && (await leases()) > 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await leases()).toBe(0);
    // An id that is nobody's is still simply not found.
    expect((await post(`/invoice/${new mongoose.Types.ObjectId()}/register-irn`, {})).status).toBe(404);
    expect((await post('/invoice/not-an-id/register-irn', {})).status).toBeGreaterThanOrEqual(400);
  });
});
