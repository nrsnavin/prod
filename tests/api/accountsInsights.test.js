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
  for (const n of ['CollectionNote', 'User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Expense', 'Payment', 'BankAccount', 'ExpenseCategory', 'RawMaterial', 'RecurringExpense', 'AiSuggestion', 'BankStatement']) {
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
    const pricey = await post('/accounts/bills/check', { supplier: s._id, billDate: today, lines: [{ rawMaterial: nylon._id, description: 'Nylon', hsn: '5402', quantity: 10, rate: 340, gstPercent: 5 }] });
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
      expect.objectContaining({ direction: 'in', docNo: 'INV/2026-27/0092', amount: 20000, basis: expect.stringMatching(/^pays in (19|20) days — 1 payment, with the book's habit$/) }),
      expect.objectContaining({ direction: 'out', docNo: 'Factory rent', amount: 30000, basis: 'recurring' }),
    ]));
    const inWeek = f.weeks.findIndex((w) => w.top.some((x) => x.docNo === 'INV/2026-27/0092'));
    expect(inWeek).toBeLessThanOrEqual(2);
    expect(f.firstShortWeek).not.toBeNull();
    expect(all.find((x) => x.docNo === 'INV/2026-27/0092').basis).toMatch(/1 payment/);
  });

  it('spreads a customer\'s money over the weeks it is likely to come, waits longer on an invoice already late, and holds to a promise', async () => {
    n += 1;
    const c = await M.Customer.create({ name: `Spread ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, paymentTerms: '30', phoneNumber: '9' });
    await get('/accounts/bank-accounts');
    const cash = await M.BankAccount.findOne({ kind: 'cash' });
    const mkInv = async (no, date, grand) => {
      const inv = await M.Invoice.create({ invoiceNumber: no, financialYear: '2026-27', sequence: Number(no.slice(-3)), invoiceDate: new Date(date), dueDate: new Date(new Date(date).getTime() + 30 * DAY), order: new mongoose.Types.ObjectId(), customer: c._id, buyer: { name: c.name }, supplyType: 'intra', lines: [], totals: { taxable: grand, grand }, status: 'issued' });
      await require('../../services/partyLedger').post({ partyType: 'customer', party: c._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: no, debit: grand });
      return inv;
    };
    // Eight payments: some at 30 days, some at 60 — a customer who varies.
    for (let i = 0; i < 8; i++) {
      const days = i % 2 ? 60 : 30;
      // On the day, as the receipts are: dated at this moment's time of
      // day, a late run measured 30 days as 29.x and the test failed.
      const inv = await mkInv(`INV/S${n}/${String(100 + i)}`, iso(Date.now() - (300 - i * 20) * DAY), 1000);
      await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: c._id, amount: 1000, mode: 'cash', account: cash._id, date: iso(Date.now() - (300 - i * 20 - days) * DAY), allocations: [{ docType: 'Invoice', doc: inv._id, amount: 1000 }] });
    }
    // Raised today: its ₹10,000 is spread between about a month and two out.
    await mkInv(`INV/S${n}/200`, Date.now(), 10000);
    // Raised 90 days ago: later than they have ever paid.
    await mkInv(`INV/S${n}/201`, Date.now() - 90 * DAY, 4000);
    let f = (await get('/accounts/forecast?weeks=12')).body;
    let all = f.weeks.flatMap((w) => w.items.map((x) => ({ ...x, week: f.weeks.indexOf(w) })));
    const fresh = all.filter((x) => x.docNo === `INV/S${n}/200`);
    expect(fresh.length).toBeGreaterThan(1);
    expect(fresh.reduce((t, x) => t + x.amount, 0)).toBeCloseTo(10000, 0);
    expect(Math.min(...fresh.map((x) => x.week))).toBeGreaterThanOrEqual(3);
    expect(Math.max(...fresh.map((x) => x.week))).toBeLessThanOrEqual(9);
    expect(fresh[0].basis).toMatch(/^pays in \d+ days \(usually 30–60\) — 8 payments · \d+% likely this week$/);
    const late = all.filter((x) => x.docNo === `INV/S${n}/201`);
    expect(late.reduce((t, x) => t + x.amount, 0)).toBeCloseTo(4000, 0);
    expect(late.every((x) => x.week >= 0 && x.week <= 4)).toBe(true);
    expect(late[0].basis).toMatch(/already later than they have ever paid/);

    // They promise ₹3,000 in nine days: that much of the oldest comes then.
    await M.CollectionNote.create({ customer: c._id, kind: 'promise', promiseDate: new Date(Date.now() + 9 * DAY), promiseAmount: 3000 });
    f = (await get('/accounts/forecast?weeks=12')).body;
    all = f.weeks.flatMap((w) => w.items);
    expect(all.find((x) => x.docNo === `INV/S${n}/201` && /^promised by/.test(x.basis))).toMatchObject({ amount: 3000 });
    expect(all.filter((x) => x.docNo === `INV/S${n}/201` && !/^promised/.test(x.basis)).reduce((t, x) => t + x.amount, 0)).toBeCloseTo(1000, 0);
  });

  it('counts what no bill shows: expenses paid directly, salaries, TDS, GST — and what a supplier was paid ahead', async () => {
    const now = new Date();
    const s = await supplier();
    // A bill of ₹20,000 due in a month; we paid them ₹10,000 ahead.
    const bill = await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'ADV/1', billDate: iso(now), lines: [{ description: 'Yarn', quantity: 1, rate: 20000, gstPercent: 0 }] });
    expect(bill.status).toBe(201);
    await require('../../models/OpeningBalance').create({ docNo: `OB/T/${n}`, financialYear: '2025-26', sequence: n, partyType: 'supplier', supplier: s._id, partyName: s.name, kind: 'advance', date: new Date(now.getTime() - 200 * DAY), amount: 10000, unapplied: 10000, status: 'posted' });
    // An electricity bill waiting for approval, paid straight to the board.
    const eb = await category('Electricity');
    const e = await post('/accounts/expenses', { category: eb._id, description: 'HT bill', payeeName: 'TNEB', amount: 84500 }, clerk);
    expect(e.status).toBe(201);
    await M.Expense.updateMany({ payeeName: 'TNEB' }, { status: 'pending' });
    // Last month's payroll, not yet paid.
    const Payroll = require('../../models/Payroll');
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    await Payroll.create({ employee: new mongoose.Types.ObjectId(), year: last.getFullYear(), month: last.getMonth() + 1, netPay: 50000, status: 'finalized' });
    // TDS deducted this month.
    await M.Payment.collection.insertOne({ status: 'posted', kind: 'payment', date: now, amount: 0, tds: { amount: 400, section: '194C' }, allocations: [] });
    // A sale this month with ₹50 of GST on it.
    n += 1;
    const c = await M.Customer.create({ name: `GST ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, phoneNumber: '9' });
    await M.Invoice.create({ invoiceNumber: `INV/T/${n}`, financialYear: '2026-27', sequence: n, invoiceDate: now, order: new mongoose.Types.ObjectId(), customer: c._id, buyer: { name: c.name }, supplyType: 'intra', status: 'issued', totals: { taxable: 1000, tax: 50, grand: 1050 }, lines: [{ name: 'Elastic', quantity: 1, rate: 1000, taxable: 1000, gstPercent: 5, cgst: 25, sgst: 25, igst: 0, amount: 1050 }] });

    const f = (await get('/accounts/forecast?weeks=10')).body;
    const all = f.weeks.flatMap((w) => w.items);
    const by = (docNo) => all.find((x) => x.docNo === docNo);
    expect(by(bill.body.bill.billNo)).toMatchObject({ direction: 'out', amount: 10000, basis: expect.stringMatching(/less ₹10,000 paid ahead/) });
    expect(all.find((x) => x.party === 'TNEB')).toMatchObject({ direction: 'out', amount: 84500, basis: 'expense waiting for approval' });
    expect(all.find((x) => x.basis === 'payroll not yet paid')).toMatchObject({ party: 'Salaries', amount: 50000 });
    expect(all.find((x) => /^estimate: /.test(x.basis))).toMatchObject({ party: 'Salaries', amount: 50000 });
    expect(all.find((x) => x.party === 'Income tax (TDS)')).toMatchObject({ amount: 400 });
    expect(all.find((x) => x.party === 'GST')).toMatchObject({ amount: 50 });
    // Every week lists all it holds; `top` is the biggest five.
    for (const w of f.weeks) expect(w.top).toEqual(w.items.slice(0, 5));

    const ov = (await get('/accounts/overview')).body;
    expect(ov.payables.paidAhead).toBe(10000);
    expect(ov.payables.top.find((p) => String(p.party) === String(s._id))).toMatchObject({ paidAhead: 10000 });
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
    expect(c.items.map((i) => i.key)).toEqual(['bank', 'cleared', 'photos', 'approvals', 'tds', 'tdsOnCredit', 'gst', 'msme', 'gstr2b', 'rule37', 'credits', 'tally', 'lock']);
    expect(c.items.find((i) => i.key === 'tdsOnCredit')).toMatchObject({ ok: true, count: 0 });
    // A bill booked in the month under a TDS section and not paid by its end: the tax on it was due at credit.
    await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'Z2', kind: 'service', billDate: iso(new Date(prev.getFullYear(), prev.getMonth(), 12)), lines: [{ description: 'Dyeing', quantity: 1, rate: 50000, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 2 } });
    const onCredit = (await get(`/accounts/close?month=${month}`)).body.items.find((i) => i.key === 'tdsOnCredit');
    expect(onCredit).toMatchObject({ ok: false, count: 1, amount: 1000 });
    expect(onCredit.detail).toMatch(/1 bill with a TDS section unpaid at the month's end/);
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

  it('the checklist does not wait on expenses Tally never gets as their own voucher', async () => {
    const d = new Date(); const prev = new Date(d.getFullYear(), d.getMonth() - 1, 10);
    const month = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    const eb = await category('Electricity');
    const e = await post('/accounts/expenses', { category: eb._id, description: 'Tea', payeeName: 'Stall', amount: 300, date: iso(prev) });
    expect(e.status).toBe(201);
    await M.Expense.updateOne({ _id: e.body.expense?._id || e.body.row?._id || e.body._id }, { status: 'approved' });
    expect(await M.Expense.countDocuments({ status: 'approved', supplier: null })).toBe(1);
    const c = (await get(`/accounts/close?month=${month}`)).body;
    expect(c.items.find((i) => i.key === 'tally')).toMatchObject({ ok: true, count: 0 });
  });

  it('the inbox counts a suggested bank line until it is posted, once across uploads', async () => {
    await get('/accounts/bank-accounts');
    const bank = await M.BankAccount.findOne({});
    const line = (index, key, status, amount) => ({ index, date: new Date(), narration: key, amount, direction: 'in', key, status });
    const older = await M.BankStatement.create({ account: bank._id, accountName: bank.name, file: 'oct.csv', lines: [line(0, 'k1', 'matched', 5000), line(1, 'k2', 'recorded', 700), line(2, 'k3', 'ignored', 90)] });
    await new Promise((r) => setTimeout(r, 20));
    await M.BankStatement.create({ account: bank._id, accountName: bank.name, file: 'oct-again.csv', lines: [line(0, 'k2', 'unmatched', 700), line(1, 'k4', 'unmatched', 1200)] });
    const inbox = (await get('/accounts/inbox')).body;
    expect(inbox.bankLines).toMatchObject({ count: 2, amount: 6200, account: String(bank._id) });
    expect(inbox.bankLines.statement).not.toBe(String(older._id));
  });

  it('an expense to a supplier goes to Tally under the supplier\'s own name, however the payee was typed', async () => {
    const s = await supplier();
    const eb = await category('Electricity');
    const e = await post('/accounts/expenses', { category: eb._id, supplier: s._id, description: 'Cones', payeeName: 'sri yarn (typo)', amount: 500, date: iso(Date.now()) });
    expect(e.status).toBe(201);
    await M.Expense.updateMany({ supplier: s._id }, { status: 'approved' });
    const from = iso(Date.now() - DAY); const to = iso(Date.now() + DAY);
    const t = (await get(`/accounts/tally/preview?from=${from}&to=${to}`)).body;
    const j = t.sample.find((v) => v.type === 'Journal');
    expect(j.party).toBe(s.name);
    expect(j.lines.map((l) => l.ledger)).toContain(s.name);
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
