'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SUPPLIER'S STATEMENT AGAINST OUR BOOKS — POST /accounts/supplier-recon
//
//  Their statement (read by the model, stubbed) beside our ledger of
//  them: bills by their number, a payment they booked as money and TDS
//  apart, a bill only they have, a payment only we have, a bill they
//  billed for more — and the balance difference, all of it explained.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockCreate = jest.fn();
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const reply = (o) => mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(o) }], usage: { input_tokens: 1, output_tokens: 1 } });
const PDF = Buffer.from('%PDF-1.4\n%%EOF');

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'BankAccount', 'AiSuggestion']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'sr@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  mockCreate.mockReset();
});

const send = (supplier, file = PDF, name = 'statement.pdf', type = 'application/pdf') => request(app).post('/api/v2/accounts/supplier-recon')
  .set('Cookie', cookie()).field('supplier', supplier).attach('files', file, { filename: name, contentType: type });

describe('a supplier\'s statement', () => {
  it('is set beside our books, entry by entry, and the balance difference explained', async () => {
    const supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
    const bank = await M.BankAccount.create({ name: 'Kotak CA', kind: 'bank', accountNo: '761200', openingBalance: 500000 });
    const bill = async (no, date, rate) => (await post('/accounts/bills', { supplier: String(supplier._id), supplierBillNo: no, billDate: date, lines: [{ description: 'Nylon 70D', quantity: 1, rate, gstPercent: 5 }] })).body.bill;
    const b118 = await bill('SY/118', '2026-07-04', 10000);
    await bill('SY/119', '2026-07-20', 5000);
    // Paid SY/118 less 1% TDS: one voucher of ₹10,500 on our side.
    const paid = await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: String(supplier._id), date: '2026-07-25', amount: 10400, mode: 'bank', account: String(bank._id), tds: { section: '194Q', rate: 1 }, allocations: [{ docType: 'SupplierBill', doc: b118._id, amount: 10500 }] });
    expect(paid.status).toBe(201);
    // Paid ₹1,000 on account just before the period ended: they have not booked it.
    expect((await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: String(supplier._id), date: '2026-09-29', amount: 1000, mode: 'bank', account: String(bank._id), allocations: [] })).status).toBe(201);

    reply({
      problem: null, partyName: 'Sri Yarn Traders', partyGstin: '33AAAPS0001F1Z5', from: '2026-07-01', to: '2026-09-30', opening: 0, closing: 7400,
      entries: [
        { date: '2026-07-01', docNo: '', kind: 'opening', debit: 0, credit: 0, narration: 'Opening' },
        { date: '2026-07-04', docNo: '118', kind: 'invoice', debit: 10500, credit: 0, narration: 'Sales' },
        { date: '2026-07-20', docNo: 'SY/119', kind: 'invoice', debit: 5300, credit: 0, narration: 'Sales' },
        { date: '2026-08-02', docNo: 'SY/120', kind: 'invoice', debit: 2100, credit: 0, narration: 'Sales' },
        { date: '2026-07-26', docNo: 'UTR123', kind: 'payment', debit: 0, credit: 10400, narration: 'NEFT received' },
        { date: '2026-07-28', docNo: '', kind: 'tds', debit: 0, credit: 100, narration: 'TDS 194Q' },
      ],
      confidence: 0.9,
    });
    const res = await send(String(supplier._id));
    expect(res.status).toBe(200);
    const r = res.body.recon;
    expect(mockCreate.mock.calls[0][0].model).toBe('test-vision');

    expect(r.matched).toHaveLength(3);
    expect(r.matched.find((m) => m.theirs.docNo === '118')).toMatchObject({ by: 'number', difference: 0, ours: [{ theirNo: 'SY/118' }] });
    expect(r.matched.find((m) => m.theirs.docNo === 'SY/119')).toMatchObject({ by: 'number', difference: 50 });
    expect(r.matched.find((m) => m.by === 'two of theirs make one of ours')).toMatchObject({ ours: [{ docType: 'Payment', debit: 10500 }] });
    expect(r.onlyTheirs).toEqual([expect.objectContaining({ docNo: 'SY/120', debit: 2100, likely: 'A bill of theirs not entered in our books' })]);
    expect(r.onlyOurs).toEqual([expect.objectContaining({ docType: 'Payment', debit: 1000, likely: expect.stringMatching(/in transit/) })]);
    // Theirs 7,400 − ours 4,250 = 3,150: SY/120 2,100 + the ₹1,000 in transit + SY/119's ₹50.
    expect(r.balances).toEqual({ ours: 4250, theirs: 7400, difference: 3150, explained: 3150, unexplained: 0 });
    expect(r.gstinDiffers).toBe(false);
  });

  it('reads an Excel sheet as text, and refuses without a supplier or a file', async () => {
    const supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ledger');
    ws.addRow(['Date', 'Particulars', 'Vch No', 'Debit', 'Credit']);
    ws.addRow([new Date('2026-08-02'), 'Sales', 'SY/120', 2100, '']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    reply({ problem: null, from: '2026-08-01', to: '2026-08-31', closing: 2100, entries: [{ date: '2026-08-02', docNo: 'SY/120', kind: 'invoice', debit: 2100, credit: 0 }] });
    const res = await send(String(supplier._id), xlsx, 'ledger.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.status).toBe(200);
    const sent = mockCreate.mock.calls[0][0];
    expect(sent.model).toBe('test-text');
    expect(sent.messages[0].content[0].text).toMatch(/2026-08-02 \| Sales \| SY\/120 \| 2100/);
    expect(res.body.recon.onlyTheirs).toHaveLength(1);

    expect((await request(app).post('/api/v2/accounts/supplier-recon').set('Cookie', cookie()).attach('files', PDF, 'a.pdf')).status).toBe(400);
    expect((await post('/accounts/supplier-recon', { supplier: String(supplier._id) })).status).toBe(400);
  });
});
