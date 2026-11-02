'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE AI SIDE OF ACCOUNTS, WITHOUT A MODEL
//
//    • a scanned bill: what the reader returns is matched to the
//      supplier on file (GSTIN first) and to the POs with something
//      left to bill; a bill already entered is said so; nothing saved
//    • a bank statement: parsed whatever the bank calls its columns,
//      each line placed — already recorded, a document named in the
//      narration, the party's name, one exact amount — or left for a
//      person; the confirmed lines post as ordinary vouchers
//    • collections: who to chase first and a reminder drafted from
//      the overdue invoices (the template, with no model configured),
//      sent on WhatsApp
//
//  The model is mocked away: these pin what is done WITH its answer.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockRead = jest.fn();
jest.mock('../../utils/billOcr', () => ({ readBill: (...a) => mockRead(...a) }));
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));
const mockSend = jest.fn().mockResolvedValue({ sent: true, provider: 'twilio', providerId: 'SM1' });
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true }));

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const partyLedger = () => require('../../services/partyLedger');

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'RawMaterial', 'PurchaseOrder', 'MaterialInward', 'Invoice', 'SupplierBill', 'Payment', 'BankAccount', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'acctai@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  mockRead.mockReset(); mockSend.mockClear();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
async function scene() {
  n += 1;
  const supplier = await M.Supplier.create({ name: `Sri Yarn Traders ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5` });
  const nylon = await M.RawMaterial.create({ name: `Nylon ${n}`, category: 'covering', unit: 'kg', stock: 0, price: 300 });
  const po = await M.PurchaseOrder.create({ supplier: supplier._id, poNo: 700 + n, items: [{ rawMaterial: nylon._id, price: 310, quantity: 100, receivedQuantity: 40 }] });
  await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 40, unitPrice: 310 });
  const customer = await M.Customer.create({ name: `Sunrise Garments ${n}`, contactName: 'Ravi', phoneNumber: '9677707535', gstin: `33AAEPS${String(n).padStart(4, '0')}F1Z2`, paymentTerms: '30', accountant: { name: 'Meena', mobile: '9000011111' } });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(Date.now() - 60 * 86_400_000), dueDate: new Date(Date.now() - 30 * 86_400_000),
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' }, buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' },
    supplyType: 'intra', placeOfSupply: '33', lines: [], totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand: 10500 }, status: 'issued',
  });
  await partyLedger().post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 10500, narration: 'Sales' });
  await get('/accounts/bank-accounts');
  const bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 0 })).body.account;
  return { supplier, nylon, po, customer, inv, bank };
}

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('a scanned bill', () => {
  it('is matched to the supplier by GSTIN and to the PO with receipts to bill, and nothing is saved', async () => {
    const s = await scene();
    mockRead.mockResolvedValue({
      kind: 'bill', problem: null, supplierName: 'SRI YARN TRADERS', supplierGstin: s.supplier.gstin, billNo: 'SY/118', billDate: '2026-07-04', dueDate: null,
      lines: [{ description: 'Nylon 70D', hsn: '5402', quantity: 40, unit: 'kg', rate: 310, gstPercent: 5, amount: 12400, confidence: 0.9 }],
      totals: { taxable: 12400, cgst: 310, sgst: 310, igst: null, grand: 13020 }, confidence: 0.85, model: 'test-vision', usage: { input_tokens: 10, output_tokens: 5 }, latencyMs: 12,
    });
    const res = await request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).attach('files', png, { filename: 'bill.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.read.lines[0]).toMatchObject({ description: 'Nylon 70D', hsn: '5402', quantity: 40, rate: 310 });
    expect(res.body.supplier).toMatchObject({ name: s.supplier.name, matchedBy: 'gstin' });
    expect(res.body.purchaseOrders).toEqual([expect.objectContaining({ poNo: s.po.poNo, receipts: 1, unbilledReceipts: 1 })]);
    expect(res.body.alreadyEntered).toBeNull();
    expect(await M.SupplierBill.countDocuments()).toBe(0);
    expect(await M.AiSuggestion.countDocuments({ surface: 'bill-ocr' })).toBe(1);
    expect(mockRead.mock.calls[0][0]).toEqual([expect.objectContaining({ mimetype: 'image/png' })]);
  });

  it('a supplier without a GSTIN on the bill is guessed by name; a bill already entered is flagged', async () => {
    const s = await scene();
    await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/118', lines: [{ description: 'x', quantity: 1, rate: 1 }] });
    mockRead.mockResolvedValue({ kind: 'receipt', problem: null, supplierName: `Sri Yarn ${n}`, supplierGstin: '', billNo: 'SY/118', billDate: null, dueDate: null, lines: [{ description: 'Yarn', quantity: 1, unit: '', rate: 500, gstPercent: 0, amount: 500, confidence: 0.6 }], totals: {}, confidence: 0.5, model: 'test-vision', usage: {}, latencyMs: 1 });
    const res = await request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).attach('files', png, { filename: 'bill.png', contentType: 'image/png' });
    expect(res.body.supplier).toMatchObject({ name: s.supplier.name, matchedBy: 'name' });
    expect(res.body.alreadyEntered).toBe('PB/2026-27/0001');
  });

  it('says when the photo is not a bill, and when scanning is not set up', async () => {
    mockRead.mockResolvedValue({ kind: null, problem: 'not_a_bill', lines: [], supplierName: '', supplierGstin: '', billNo: '', totals: {}, confidence: 0, model: 'test-vision', usage: {}, latencyMs: 1 });
    const res = await request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).attach('files', png, { filename: 'cat.png', contentType: 'image/png' });
    expect(res.body.read.problem).toBe('not_a_bill');
    expect(res.body.supplier).toBeNull();
    mockRead.mockRejectedValue(Object.assign(new Error('ANTHROPIC_API_KEY not set on the server.'), { code: 'ANTHROPIC_KEY_MISSING' }));
    expect((await request(app).post('/api/v2/accounts/scan').set('Cookie', cookie()).attach('files', png, { filename: 'bill.png', contentType: 'image/png' })).status).toBe(503);
    expect((await post('/accounts/scan', {})).status).toBe(400);
  });
});

describe('a bank statement', () => {
  const csv = (rows) => Buffer.from(['Txn Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt', ...rows].join('\n'));

  it('is parsed whatever the bank calls its columns', async () => {
    const { parse, parseDate } = require('../../services/bankStatement');
    const rows = await parse(csv(['04/07/2026,NEFT CR SUNRISE GARMENTS,UTR123,,"10,500.00"', '05-Jul-26,UPI/DR/VRL TRANSPORT,,6300,', ',,,,']), 'text/csv', 's.csv');
    expect(rows).toEqual([
      expect.objectContaining({ narration: 'NEFT CR SUNRISE GARMENTS', ref: 'UTR123', amount: 10500, direction: 'in' }),
      expect.objectContaining({ narration: 'UPI/DR/VRL TRANSPORT', amount: 6300, direction: 'out' }),
    ]);
    expect(rows[0].date.getMonth()).toBe(6);
    const alt = await parse(Buffer.from('Date,Description,Amount,Dr/Cr\n2026-07-04,IMPS SRI YARN,19530,Dr\n2026-07-06,CASH DEP,500,Cr'), 'text/csv');
    expect(alt.map((r) => [r.amount, r.direction])).toEqual([[19530, 'out'], [500, 'in']]);
    expect(parseDate('31/03/2026').getDate()).toBe(31);
    await expect(parse(Buffer.from('a,b\n1,2'), 'text/csv')).rejects.toThrow(/statement columns/);
  });

  it('places each line: recorded, named document, party name, exact amount, or left for a person', async () => {
    const s = await scene();
    // A payment already recorded on this account.
    await post('/accounts/payments', { kind: 'payment', partyType: 'other', partyName: 'EB', amount: 3000, mode: 'bank', account: s.bank._id, reference: 'EB-JUL', date: new Date().toISOString() });
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/118', lines: [{ description: 'Nylon', quantity: 40, rate: 310, gstPercent: 5 }] })).body.bill; // 13,020
    const today = new Date();
    const d = (off = 0) => { const t = new Date(today.getTime() + off * 86_400_000); return `${String(t.getDate()).padStart(2, '0')}/${String(t.getMonth() + 1).padStart(2, '0')}/${t.getFullYear()}`; };
    const file = csv([
      `${d(0)},NEFT CR ${s.customer.name.toUpperCase()} INV/2026-27/${String(n).padStart(4, '0')},UTR1,,10500`,
      `${d(1)},IMPS DR SRI YARN TRADERS ${n},UTR2,13020,`,
      `${d(-1)},TNEB ONLINE,EB-JUL,3000,`,
      `${d(1)},UPI DR SOMEBODY,UTR3,777,`,
    ]);
    const res = await request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(s.bank._id)).attach('file', file, { filename: 'kotak.csv', contentType: 'text/csv' });
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ recorded: 1, matched: 2, unmatched: 1 });
    const [r1, r2, r3, r4] = res.body.rows;
    expect(r1.suggestion).toMatchObject({ partyType: 'customer', partyName: s.customer.name, confidence: 0.95, allocations: [{ docType: 'Invoice', docNo: s.inv.invoiceNumber, amount: 10500 }] });
    expect(r2.suggestion).toMatchObject({ partyType: 'supplier', partyName: s.supplier.name, confidence: 0.9, allocations: [{ docType: 'SupplierBill', docNo: bill.billNo, amount: 13020 }] });
    expect(r3).toMatchObject({ status: 'recorded', recorded: { voucherNo: 'PAY/2026-27/0001' } });
    expect(r4).toMatchObject({ status: 'unmatched', suggestion: null });

    // The confirmed lines post as vouchers; the invoice and bill are settled.
    const postRes = await post('/accounts/bank/statement/post', { account: s.bank._id, rows: [
      { date: r1.date, narration: r1.narration, ref: r1.ref, amount: r1.amount, direction: r1.direction, partyType: 'customer', party: r1.suggestion.party, allocations: r1.suggestion.allocations },
      { date: r2.date, narration: r2.narration, ref: r2.ref, amount: r2.amount, direction: r2.direction, partyType: 'supplier', party: r2.suggestion.party, allocations: r2.suggestion.allocations },
      { date: r4.date, narration: r4.narration, ref: r4.ref, amount: r4.amount, direction: r4.direction, partyType: 'other', partyName: 'Somebody' },
    ] });
    expect(postRes.status).toBe(200);
    expect(postRes.body.posted).toBe(3);
    expect(postRes.body.results.map((r) => r.voucherNo)).toEqual(['RCT/2026-27/0001', 'PAY/2026-27/0002', 'PAY/2026-27/0003']);
    expect((await M.Invoice.findById(s.inv._id).lean()).paidAmount).toBe(10500);
    expect((await M.SupplierBill.findById(bill._id).lean()).status).toBe('paid');
    const v = await M.Payment.findOne({ voucherNo: 'RCT/2026-27/0001' }).lean();
    expect(v).toMatchObject({ source: 'statement', reference: 'UTR1', mode: 'bank' });
    // Uploading the same statement again finds every line recorded.
    const again = await request(app).post('/api/v2/accounts/bank/statement').set('Cookie', cookie()).field('account', String(s.bank._id)).attach('file', file, { filename: 'kotak.csv', contentType: 'text/csv' });
    expect(again.body.counts).toEqual({ recorded: 4, matched: 0, unmatched: 0 });
  });
});

describe('collections', () => {
  it('ranks who to chase, drafts a reminder from the overdue invoices, and sends it on WhatsApp', async () => {
    const s = await scene();
    const list = await get('/accounts/collections');
    expect(list.status).toBe(200);
    expect(list.body.rows).toEqual([expect.objectContaining({ partyName: s.customer.name, overdue: 10500, oldestDays: 30, contact: expect.objectContaining({ name: 'Ravi', phone: '9677707535', accountantPhone: '9000011111' }) })]);
    expect(list.body.rows[0].priority).toBe(10500 * 30);
    expect(list.body.whatsapp).toBe(true);

    const draft = await post('/accounts/collections/draft', { customer: s.customer._id });
    expect(draft.status).toBe(200);
    expect(draft.body.byModel).toBe(false); // no model configured: the template
    expect(draft.body.message).toMatch(/Dear Ravi/);
    expect(draft.body.message).toContain(s.inv.invoiceNumber);
    expect(draft.body.message).toMatch(/10,500\.00/);
    expect(draft.body.message).toMatch(/30 days past due/);
    expect(draft.body.to).toBe('+919000011111'); // the accountant's number first

    const sent = await post('/accounts/collections/send', { to: draft.body.to, message: draft.body.message });
    expect(sent.status).toBe(200);
    expect(sent.body.sent).toBe(true);
    expect(mockSend).toHaveBeenCalledWith('+919000011111', expect.stringContaining(s.inv.invoiceNumber));
    expect((await post('/accounts/collections/send', { to: '', message: draft.body.message })).status).toBe(400);
    expect((await post('/accounts/collections/draft', { customer: new mongoose.Types.ObjectId() })).status).toBe(404);
  });
});
