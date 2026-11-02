'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE BOOKS NOTICE
//
//    • a bill is flagged before saving: the same amount twice, a GSTIN
//      that is not the supplier's, a rate off the last bills, an old date
//    • an expense's head is suggested from what that payee's were
//    • the forecast expects a customer's money when they actually pay
//    • the month-end checklist says what is left
//    • recurring expenses draft themselves once, on their day
//    • the inbox gathers what needs someone; any list goes to Excel
//    • a scanned bill's draft is scored against what was saved
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const ExcelJS  = require('exceljs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, clerk;
const cookie = (u = admin) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const get = (url, u) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u));

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Expense', 'Payment', 'BankAccount', 'ExpenseCategory', 'RawMaterial', 'RecurringExpense', 'AiSuggestion']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'ins@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Clerk', email: 'ins-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
const DAY = 86_400_000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const supplier = async () => { n += 1; return M.Supplier.create({ name: `Sri Yarn ${n}`, gstin: `33AAAPS${1000 + n}F1Z5` }); };
const category = async (name) => { await get('/accounts/categories'); return M.ExpenseCategory.findOne({ name }); };

describe('flags before a bill is saved', () => {
  it('the same amount twice, a GSTIN not the supplier\'s, a rate off the last bills, an old bill', async () => {
    const s = await supplier();
    const nylon = await M.RawMaterial.create({ name: `Nylon ${n}`, category: 'covering', unit: 'kg', stock: 0, price: 300 });
    const today = iso(Date.now());
    for (const [no, rate] of [['A1', 300], ['A2', 302]]) {
      await post('/accounts/bills', { supplier: s._id, supplierBillNo: no, billDate: today, lines: [{ rawMaterial: nylon._id, description: 'Nylon', quantity: 10, rate, gstPercent: 5 }] });
    }
    const check = await post('/accounts/bills/check', {
      supplier: s._id, billDate: today, scannedGstin: '33AAAPS9999F1Z5',
      lines: [{ rawMaterial: nylon._id, description: 'Nylon', quantity: 10, rate: 302, gstPercent: 5 }],
    });
    const codes = check.body.flags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['SAME_AMOUNT', 'GSTIN_MISMATCH']));
    expect(check.body.flags.find((f) => f.code === 'SAME_AMOUNT').message).toMatch(/already entered as PB\/.*A2/);
    const pricey = await post('/accounts/bills/check', { supplier: s._id, billDate: today, lines: [{ rawMaterial: nylon._id, description: 'Nylon', quantity: 10, rate: 340, gstPercent: 5 }] });
    expect(pricey.body.flags.map((f) => f.code)).toEqual(['RATE_OFF']);
    expect(pricey.body.flags[0].message).toMatch(/averaged ₹301/);
    const old = await post('/accounts/bills/check', { supplier: s._id, billDate: iso(Date.now() - 90 * DAY), lines: [{ description: 'x', quantity: 1, rate: 7 }] });
    expect(old.body.flags.map((f) => f.code)).toContain('OLD_BILL');
  });

  it('suggests the head an expense belongs under from that payee\'s history', async () => {
    const eb = await category('Electricity');
    for (let i = 0; i < 3; i++) await post('/accounts/expenses', { category: eb._id, description: `EB bill ${i}`, payeeName: 'TNEB', amount: 9000 + i });
    const res = await get('/accounts/suggest/category?payee=tneb');
    expect(res.body.suggestion).toMatchObject({ name: 'Electricity', confidence: 1 });
    expect(res.body.suggestion.reason).toMatch(/3 of the last 3 expenses to TNEB were Electricity/);
    expect((await get('/accounts/suggest/category?payee=nobody')).body.suggestion).toBeNull();
  });
});

describe('the cash forecast', () => {
  it('expects money when the customer actually pays, and sets bills and rent against it', async () => {
    n += 1;
    const c = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, paymentTerms: '60', phoneNumber: '9' });
    await get('/accounts/bank-accounts');
    const cash = await M.BankAccount.findOne({ kind: 'cash' });
    await M.BankAccount.updateOne({ _id: cash._id }, { openingBalance: 1000 });
    const mkInv = async (no, date, grand) => {
      const inv = await M.Invoice.create({ invoiceNumber: no, financialYear: '2026-27', sequence: Number(no.slice(-2)), invoiceDate: new Date(date), dueDate: new Date(new Date(date).getTime() + 60 * DAY), order: new mongoose.Types.ObjectId(), customer: c._id, buyer: { name: c.name }, supplyType: 'intra', lines: [], totals: { taxable: grand, grand }, status: 'issued' });
      await require('../../services/partyLedger').post({ partyType: 'customer', party: c._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: no, debit: grand });
      return inv;
    };
    // History: they paid an invoice 20 days after it, not 60.
    const old = await mkInv('INV/2026-27/0091', Date.now() - 100 * DAY, 5000);
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: c._id, amount: 5000, mode: 'cash', account: cash._id, date: iso(Date.now() - 80 * DAY), allocations: [{ docType: 'Invoice', doc: old._id, amount: 5000 }] });
    // Open: raised 10 days ago — expected 10 days from now, not 50.
    await mkInv('INV/2026-27/0092', Date.now() - 10 * DAY, 20000);
    const eb = await category('Electricity');
    await post('/accounts/recurring', { name: 'Factory rent', category: eb._id, description: 'Rent', payeeName: 'Landlord', amount: 30000, nextDate: iso(Date.now() + 3 * DAY) });

    const f = (await get('/accounts/forecast?weeks=4')).body;
    expect(f.opening).toBe(6000);
    const all = f.weeks.flatMap((w) => w.top);
    expect(all).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'in', docNo: 'INV/2026-27/0092', amount: 20000, basis: expect.stringMatching(/^pays in (19|20) days on average/) }),
      expect.objectContaining({ direction: 'out', docNo: 'Factory rent', amount: 30000, basis: 'recurring' }),
    ]));
    const inWeek = f.weeks.findIndex((w) => w.top.some((x) => x.docNo === 'INV/2026-27/0092'));
    expect(inWeek).toBeLessThanOrEqual(2);
    expect(f.firstShortWeek).not.toBeNull();
  });
});

describe('month end, recurring expenses, the inbox, Excel', () => {
  it('drafts a recurring expense once on its day, and the inbox shows it waiting', async () => {
    const eb = await category('Electricity');
    const t = await post('/accounts/recurring', { name: 'EB', category: eb._id, description: 'Electricity HT bill', payeeName: 'TNEB', amount: 45000, nextDate: iso(Date.now() - 1 * DAY) });
    expect(t.status).toBe(201);
    const [a, b] = await Promise.all([get('/accounts/inbox'), get('/accounts/inbox')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const drafts = await M.Expense.find({ source: 'recurring' }).lean();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: 'pending', description: 'Electricity HT bill', payeeName: 'TNEB' });
    const next = (await M.RecurringExpense.findById(t.body.row._id).lean()).nextDate;
    expect(new Date(next) > new Date()).toBe(true);
    const inbox = (await get('/accounts/inbox', clerk)).body;
    expect(inbox.approvals).toMatchObject({ count: 1, amount: 45000 });
  });

  it('the month-end checklist says what is left', async () => {
    const d = new Date(); const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const month = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    const s = await supplier();
    await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'Z1', billDate: iso(new Date(prev.getFullYear(), prev.getMonth(), 10)), lines: [{ description: 'Yarn', quantity: 1, rate: 1000 }] });
    const c = (await get(`/accounts/close?month=${month}`)).body;
    expect(c.items.map((i) => i.key)).toEqual(['bank', 'cleared', 'photos', 'approvals', 'tds', 'gst', 'credits', 'tally', 'lock']);
    expect(c.items.find((i) => i.key === 'photos')).toMatchObject({ ok: false, count: 1 });
    expect(c.items.find((i) => i.key === 'tally')).toMatchObject({ ok: false, count: 1 });
    expect(c.items.find((i) => i.key === 'lock').ok).toBe(false);
  });

  it('exports a list as Excel', async () => {
    const s = await supplier();
    await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'X9', lines: [{ description: 'Yarn', quantity: 2, rate: 500, gstPercent: 5 }] });
    const res = await request(app).get('/api/v2/accounts/export/bills').set('Cookie', cookie()).buffer(true).parse((r, cb) => { const d = []; r.on('data', (x) => d.push(x)); r.on('end', () => cb(null, Buffer.concat(d))); });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).values.slice(1, 4)).toEqual(['Bill', 'Supplier', 'Their no.']);
    expect(ws.getRow(2).getCell(9).value).toBe(1050);
    expect((await get('/accounts/export/nothing')).status).toBe(404);
  });

  it('scores a scanned bill\'s draft against what was saved', async () => {
    const s = await supplier();
    const aiLedger = require('../../services/aiLedger');
    const id = await aiLedger.record({ surface: 'bill-ocr', model: 'm', promptVersion: 'v1', proposed: { supplierGstin: s.gstin, billNo: 'SY/7', billDate: '2026-07-04', lines: [{ description: 'Nylon', quantity: 40, rate: 310, gstPercent: 5 }], totals: { taxable: 12400, grand: 13020 } } });
    const bill = await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'SY/7', billDate: '2026-07-04', aiSuggestion: id, source: 'scan', lines: [{ description: 'Nylon', quantity: 40, rate: 300, gstPercent: 5 }] });
    expect(bill.status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    const row = await M.AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(expect.arrayContaining(['lines[].rate']));
    const stats = (await get('/accounts/ai/stats')).body;
    expect(stats.surfaces).toEqual([expect.objectContaining({ surface: 'bill-ocr', edited: 1 })]);
  });
});
