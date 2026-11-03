'use strict';
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS OUTSIDE ITS TAB
//
//    • credit control: a customer over their limit or too long overdue
//      is held at order, challan and invoice; an admin releases it with
//      a reason, which is kept
//    • the three-way match: a bill off the PO rate or over the received
//      quantity needs a note, and the variance is kept on the bill
//    • a composition supplier cannot charge GST; reverse charge puts the
//      tax on us, in the GST report and in Tally
//    • a credit note prints as a GST document and builds the portal's
//      CRN JSON naming the invoice; a receipt and a statement print
//    • collections remember: a reminder sent is logged, a promise takes
//      the customer off the list, the ladder picks the tone
//    • anyone files an expense claim; Accounts approves and pays it back
//    • attachments live outside the document
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: jest.fn(async () => ({ sent: true, provider: 'twilio' })), isConfigured: () => true }));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, M, admin, clerk, worker;
const cookie = (u = admin) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const get = (url, u) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u));

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'BankAccount', 'ExpenseCategory', 'Order', 'Elastic', 'RawMaterial', 'PurchaseOrder', 'MaterialInward', 'CollectionNote', 'AccountFile']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'out@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Clerk', email: 'out-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  worker = await M.User.create({ name: 'Murugan', email: 'out-sup@t.co', password: 'pass1234', role: 'production', department: 'production' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road'], invoice: { defaultGstPercent: 5, city: 'Tiruppur', pincode: '641601' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
async function customerWithInvoice({ limit = 0, maxOverdueDays = 0, invoiceDate = '2026-06-01', grand = 10500 } = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'Ravi', gstin: `33AAEPS${1000 + n}F1Z2`, address: '4 Market St', city: 'Erode', pincode: '638001', paymentTerms: '30', phoneNumber: '9677707535', creditLimit: limit, maxOverdueDays });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(invoiceDate), dueDate: new Date(new Date(invoiceDate).getTime() + 30 * 86_400_000),
    order: new mongoose.Types.ObjectId(), orderNo: 70 + n, customer: customer._id,
    seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road', city: 'Tiruppur', pincode: '641601', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, address: '4 Market St', city: 'Erode', pincode: '638001', stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand });
  return { customer, inv };
}

describe('credit control', () => {
  it('holds an order, a challan and an invoice for a customer over the limit, unless an admin releases it', async () => {
    const { customer } = await customerWithInvoice({ limit: 10000 });
    const pos = await get(`/customer/credit/${customer._id}`);
    expect(pos.status).toBe(200);
    expect(pos.body).toMatchObject({ outstanding: 10500, limit: 10000, onHold: true });
    expect(pos.body.reasons[0]).toMatch(/over the ₹10,000 credit limit/);

    const elastic = await M.Elastic.create({ name: `E ${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
    const order = { date: '2026-07-01', po: 'PO-9', customer: customer._id, supplyDate: '2026-07-20', elasticOrdered: [{ elastic: elastic._id, quantity: 100, rate: 10 }] };
    const held = await post('/order/create-order', order, clerk);
    expect(held.status).toBe(409);
    expect(held.body.message).toMatch(/is on credit hold/);
    // A clerk's reason is not enough; an admin's is.
    expect((await post('/order/create-order', { ...order, creditOverride: 'Owner agreed on the phone' }, clerk)).status).toBe(409);
    const ok = await post('/order/create-order', { ...order, creditOverride: 'Owner agreed on the phone' });
    expect(ok.status).toBe(201);
    const saved = await M.Order.findOne({ po: 'PO-9' }).lean();
    expect(saved.creditOverride).toMatchObject({ reason: 'Owner agreed on the phone', outstanding: 10500 });
  });

  it('holds a customer whose oldest invoice is too long overdue; no limit set holds no one', async () => {
    const a = await customerWithInvoice({ maxOverdueDays: 30, invoiceDate: '2026-01-01' });
    expect((await get(`/customer/credit/${a.customer._id}`)).body).toMatchObject({ onHold: true });
    const b = await customerWithInvoice({ invoiceDate: '2026-01-01' });
    expect((await get(`/customer/credit/${b.customer._id}`)).body).toMatchObject({ onHold: false, limit: 0, available: null });
  });
});

describe('the three-way match, and what a supplier may charge', () => {
  async function poScene(extra = {}) {
    n += 1;
    const supplier = await M.Supplier.create({ name: `Sri Yarn ${n}`, gstin: `33AAAPS${1000 + n}F1Z5`, ...extra });
    const nylon = await M.RawMaterial.create({ name: `Nylon ${n}`, category: 'covering', unit: 'kg', stock: 0, price: 300 });
    const po = await M.PurchaseOrder.create({ supplier: supplier._id, poNo: 800 + n, items: [{ rawMaterial: nylon._id, price: 310, quantity: 100, receivedQuantity: 60 }] });
    const inward = await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 60, unitPrice: 310, inwardDate: new Date('2026-07-01') });
    return { supplier, nylon, po, inward };
  }

  it('a bill off the PO rate, or for more than was received, needs a note and keeps its variance', async () => {
    const s = await poScene();
    const body = { supplier: s.supplier._id, supplierBillNo: 'SY/1', billDate: '2026-07-04', purchaseOrder: s.po._id, inwards: [s.inward._id], lines: [{ rawMaterial: s.nylon._id, description: 'Nylon', quantity: 62, rate: 320, gstPercent: 5 }] };
    const res = await post('/accounts/bills', body);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/does not match the PO or the receipts/);
    const res2 = await post('/accounts/bills', { ...body, varianceNote: 'Rate revised by phone, 2 kg extra sent' });
    expect(res2.status).toBe(201);
    // 60 kg × ₹10 over the PO + 2 kg not received × ₹320
    expect(res2.body.bill.variance).toMatchObject({ total: 1240, note: 'Rate revised by phone, 2 kg extra sent', lines: [expect.objectContaining({ poRate: 310, billRate: 320, receivedQty: 60, billedQty: 62, rateOffPercent: 3.23 })] });
    // Within the tolerance: no note needed.
    const s2 = await poScene();
    expect((await post('/accounts/bills', { supplier: s2.supplier._id, supplierBillNo: 'SY/2', purchaseOrder: s2.po._id, inwards: [s2.inward._id], lines: [{ rawMaterial: s2.nylon._id, description: 'Nylon', quantity: 60, rate: 315, gstPercent: 5 }] })).status).toBe(201);
  });

  it('a composition supplier cannot charge GST; under reverse charge the tax is ours, in the GST report too', async () => {
    const comp = await poScene({ gstRegistration: 'composition' });
    const refused = await post('/accounts/bills', { supplier: comp.supplier._id, supplierBillNo: 'C/1', lines: [{ description: 'Tea', quantity: 1, rate: 1000, gstPercent: 5 }] });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/composition dealer/);
    expect((await post('/accounts/bills', { supplier: comp.supplier._id, supplierBillNo: 'C/1', lines: [{ description: 'Tea', quantity: 1, rate: 1000, gstPercent: 0 }] })).status).toBe(201);

    const gta = await poScene({ gstRegistration: 'unregistered' });
    const rcm = await post('/accounts/bills', { supplier: gta.supplier._id, supplierBillNo: 'LR/77', billDate: '2026-07-05', kind: 'service', reverseCharge: true, lines: [{ description: 'Freight', quantity: 1, rate: 10000, gstPercent: 5 }] });
    expect(rcm.status).toBe(201);
    expect(rcm.body.bill).toMatchObject({ reverseCharge: true, totals: { taxable: 10000, tax: 0, grand: 10000 }, rcm: { tax: 500 }, itc: { amount: 500 } });
    const gst = (await get('/accounts/reports/gst?from=2026-07-01&to=2026-07-31')).body;
    expect(gst.output.reverseCharge).toEqual([expect.objectContaining({ rate: 5, taxable: 10000, tax: 500 })]);
    expect(gst.totals.netOutput.cgst).toBe(250);
    expect(gst.totals.netInput.cgst).toBe(250);
    const tally = (await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body;
    const v = tally.sample.find((x) => x.type === 'Purchase' && x.lines.some((l) => l.ledger === 'Output CGST'));
    expect(v.lines).toEqual(expect.arrayContaining([expect.objectContaining({ ledger: 'Input CGST', debit: 250 }), expect.objectContaining({ ledger: 'Output CGST', credit: 250 })]));
    // A service bill with no head is flagged, not blocked.
    expect(tally.warnings).toEqual([expect.stringMatching(/service bill with no expense head — it posts to Purchase/)]);

    // With reverse-charge ledgers named, the tax we owe goes there.
    expect((await request(app).put('/api/v2/accounts/settings').set('Cookie', cookie()).send({ tally: { rcmCgst: 'RCM CGST Payable', rcmSgst: 'RCM SGST Payable' } })).status).toBe(200);
    const named = (await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body;
    const rv = named.sample.find((x) => x.number === rcm.body.bill.billNo);
    expect(rv.lines).toEqual(expect.arrayContaining([expect.objectContaining({ ledger: 'Input CGST', debit: 250 }), expect.objectContaining({ ledger: 'RCM CGST Payable', credit: 250 }), expect.objectContaining({ ledger: 'RCM SGST Payable', credit: 250 })]));
    expect(rv.lines.some((l) => l.ledger === 'Output CGST')).toBe(false);
    await request(app).put('/api/v2/accounts/settings').set('Cookie', cookie()).send({ tally: { rcmCgst: '', rcmSgst: '' } });
  });
});

describe('documents the other side receives', () => {
  it('a credit note prints as a GST document and builds the portal JSON naming the invoice', async () => {
    const { customer, inv } = await customerWithInvoice();
    const cn = (await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference', date: '2026-07-05', lines: [{ description: 'Rate difference', hsn: '5806', unit: 'm', quantity: 1000, rate: 1, gstPercent: 5 }] })).body.note;
    const pdf = await request(app).get(`/api/v2/accounts/notes/${cn._id}/pdf`).set('Cookie', cookie()).buffer(true).parse((res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(pdf.status).toBe(200);
    const text = await pdfText(pdf.body);
    expect(text).toMatch(/CREDIT NOTE/);
    expect(text).toContain(inv.invoiceNumber);
    expect(text).toContain(customer.name);
    const json = JSON.parse((await get(`/accounts/notes/${cn._id}/einvoice.json`)).text);
    expect(json.DocDtls).toMatchObject({ Typ: 'CRN', No: cn.noteNo, Dt: '05/07/2026' });
    expect(json.RefDtls.PrecDocDtls).toEqual([{ InvNo: inv.invoiceNumber, InvDt: '01/06/2026' }]);
    expect(json.ValDtls).toMatchObject({ AssVal: 1000, CgstVal: 25, TotInvVal: 1050 });
    const irn = 'a'.repeat(64);
    expect((await post(`/accounts/notes/${cn._id}/irn`, { irn, ackNo: '1122' })).status).toBe(200);
    expect((await M.AccountNote.findById(cn._id).lean()).einvoice).toMatchObject({ status: 'registered', irn, provider: 'manual' });
  });

  it('a receipt and a statement of account print, and a WhatsApp draft says what was received', async () => {
    const { customer, inv } = await customerWithInvoice();
    const acct = (await get('/accounts/bank-accounts')).body.accounts[0];
    const r = (await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10500, mode: 'bank', account: acct._id, reference: 'UTR55', date: '2026-07-06', allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] })).body.payment;
    const binary = (res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };
    const rp = await request(app).get(`/api/v2/accounts/payments/${r._id}/pdf`).set('Cookie', cookie()).buffer(true).parse(binary);
    const rt = await pdfText(rp.body);
    expect(rt).toMatch(/RECEIPT/);
    expect(rt).toContain(r.voucherNo);
    expect(rt).toContain(inv.invoiceNumber);
    const sp = await request(app).get(`/api/v2/accounts/statement/pdf?partyType=customer&party=${customer._id}`).set('Cookie', cookie()).buffer(true).parse(binary);
    const st = await pdfText(sp.body);
    expect(st).toMatch(/STATEMENT OF ACCOUNT/);
    expect(st).toMatch(/Closing balance/);
    const draft = await post('/accounts/share/draft', { kind: 'payment', id: r._id });
    expect(draft.body).toMatchObject({ to: '+919677707535' });
    expect(draft.body.message).toMatch(/we have received ₹10,500.00/);
  });
});

describe('collections remember', () => {
  it('logs a reminder sent, takes a customer with a live promise off the list, and climbs the ladder', async () => {
    const { customer } = await customerWithInvoice({ invoiceDate: '2026-01-01' });
    let list = (await get('/accounts/collections')).body.rows;
    expect(list[0]).toMatchObject({ partyName: customer.name, next: { action: 'call', tone: 'firm' }, lastContact: null, recentlyContacted: false });
    const draft = await post('/accounts/collections/draft', { customer: customer._id });
    expect(draft.body.tone).toBe('firm');
    await post('/accounts/collections/send', { customer: customer._id, to: draft.body.to, message: draft.body.message, tone: 'firm' });
    list = (await get('/accounts/collections')).body.rows;
    expect(list[0]).toMatchObject({ lastContact: expect.objectContaining({ kind: 'reminder', channel: 'whatsapp' }), recentlyContacted: true });
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect((await post('/accounts/collections/log', { customer: customer._id, kind: 'promise', promiseDate: soon, promiseAmount: 10500, note: 'Accountant will pay Friday' })).status).toBe(201);
    expect((await get('/accounts/collections')).body.rows).toEqual([]);
    expect((await get('/accounts/collections?held=true')).body.rows[0]).toMatchObject({ held: true, promise: expect.objectContaining({ amount: 10500, live: true }) });
    expect((await get(`/accounts/collections/${customer._id}/history`)).body.history.map((h) => h.kind)).toEqual(['promise', 'reminder']);
  });
});

describe('expense claims', () => {
  it('anyone files a claim; it waits for approval, is paid back by name, and a head can cap a day', async () => {
    await get('/accounts/categories');
    const fuel = await M.ExpenseCategory.findOne({ name: /Fuel|Diesel|Vehicle/i }) || await M.ExpenseCategory.findOne({});
    await M.ExpenseCategory.updateOne({ _id: fuel._id }, { claimDailyLimit: 1000, approvalAbove: 100000 });
    const cats = await get('/claims/categories', worker);
    expect(cats.status).toBe(200);
    const res = await post('/claims', { category: fuel._id, description: 'Diesel for the genset', amount: 800, date: '2026-07-10' }, worker);
    expect(res.status).toBe(201);
    // Even under the head's approval limit, a claim waits for someone else.
    expect(res.body.claim).toMatchObject({ status: 'pending', payeeName: 'Murugan', totals: { grand: 800 } });
    expect((await post('/claims', { category: fuel._id, description: 'More diesel', amount: 300, date: '2026-07-10' }, worker)).body.message).toMatch(/capped at ₹1000 a day/);
    const photo = await request(app).post(`/api/v2/claims/${res.body.claim._id}/photo`).set('Cookie', cookie(worker)).attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { filename: 'bill.jpg', contentType: 'image/jpeg' });
    expect(photo.status).toBe(201);
    expect(await M.AccountFile.countDocuments()).toBe(1);
    const stored = await M.Expense.findById(res.body.claim._id).lean();
    expect(stored.attachments[0].data).toBeUndefined();
    const back = await request(app).get(`/api/v2/accounts/expenses/${res.body.claim._id}/attachments/${photo.body.attachment._id}`).set('Cookie', cookie());
    expect(back.status).toBe(200);
    expect(back.headers['content-type']).toBe('image/jpeg');

    // Somebody else's claim is not mine to see.
    expect((await get(`/claims/${res.body.claim._id}`, clerk)).status).toBe(404);
    expect((await get('/claims', worker)).body).toMatchObject({ waiting: 800, owed: 0 });
    expect((await post(`/accounts/expenses/${res.body.claim._id}/approve`, {}, clerk)).status).toBe(200);
    const cash = (await get('/accounts/bank-accounts')).body.accounts.find((a) => a.kind === 'cash');
    const paid = await post(`/accounts/expenses/${res.body.claim._id}/pay`, { account: cash._id });
    expect(paid.status).toBe(200);
    expect((await M.Payment.findById(paid.body.voucher._id).lean()).partyName).toBe('Murugan');
    expect((await get('/claims', worker)).body.claims[0].status).toBe('paid');
  });
});
