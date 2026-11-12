'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BOOKS: CREDITS, CONTRAS, OPENING BALANCES, THE LOCK
//
//    • a credit note after the invoice was paid is unapplied credit,
//      never more than the invoice was for, and is applied later
//    • a debit note to a customer raises what the invoice owes
//    • an advance received sits on account and is applied to the next
//      invoice; cancelling the receipt puts the invoice back
//    • two receipts at once cannot settle one invoice past its value
//    • a supplier's expense is paid to that supplier, not to "other"
//    • a contra moves money between two of our accounts, both books
//    • opening balances: owed rows age and are settled like invoices,
//      advances are applied, a rebuild keeps them, a sheet imports them
//    • the lock: nothing dated in a closed period is posted or cancelled
//      unless an admin gives a reason
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
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'BankAccount', 'ExpenseCategory', 'PartyLedgerEntry', 'Contra', 'OpeningBalance', 'AccountsSettings']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'books@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Clerk', email: 'books-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

const partyLedger = () => require('../../services/partyLedger');
let n = 0;

async function customer() {
  n += 1;
  return M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', gstin: `33AAEPS${String(1000 + n)}F1Z2`, paymentTerms: '30', phoneNumber: '9200000000' });
}
async function invoice(c, grand = 10500, date = '2026-06-01') {
  n += 1;
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(date), dueDate: new Date(new Date(date).getTime() + 30 * 86_400_000),
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: c._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' },
    buyer: { name: c.name, gstin: c.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: grand / 1050, taxable: r2(grand / 1.05), gstPercent: 5, cgst: r2(grand / 1.05 * 0.025), sgst: r2(grand / 1.05 * 0.025), igst: 0, amount: grand }],
    totals: { taxable: r2(grand / 1.05), cgst: r2(grand / 1.05 * 0.025), sgst: r2(grand / 1.05 * 0.025), igst: 0, tax: r2(grand - grand / 1.05), roundOff: 0, grand }, status: 'issued',
  });
  await partyLedger().post({ partyType: 'customer', party: c._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand });
  return inv;
}
const r2 = (x) => Math.round(x * 100) / 100;
async function supplier(extra = {}) {
  n += 1;
  return M.Supplier.create({ name: `Sri Yarn ${n}`, gstin: `33AAAPS${String(1000 + n)}F1Z5`, ...extra });
}
const cashBox = async () => { await get('/accounts/bank-accounts'); return M.BankAccount.findOne({ kind: 'cash' }); };
const bank = async () => (await post('/accounts/bank-accounts', { name: `Kotak ${++n}`, kind: 'bank', openingBalance: 100000 })).body.account;
const receipt = (c, acct, amount, allocations = [], extra = {}) => post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: c._id, amount, mode: acct.kind === 'cash' ? 'cash' : 'bank', account: acct._id, allocations, ...extra });
const balanceOf = async (id) => (await get('/accounts/bank-accounts')).body.accounts.find((a) => String(a._id) === String(id)).balance;

describe('credits', () => {
  it('a credit note after the invoice was paid is unapplied, capped at the invoice, and applied to the next invoice', async () => {
    const c = await customer();
    const acct = await cashBox();
    const inv1 = await invoice(c, 10500);
    expect((await receipt(c, acct, 10500, [{ docType: 'Invoice', doc: inv1._id, amount: 10500 }])).status).toBe(201);
    // More than the invoice was for: refused.
    const tooMuch = await post('/accounts/notes', { kind: 'credit', against: { doc: inv1._id }, reason: 'Rate difference', lines: [{ description: 'Rate', quantity: 1, rate: 10001, gstPercent: 5 }] });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.message).toMatch(/at most ₹10500/);
    const cn = await post('/accounts/notes', { kind: 'credit', against: { doc: inv1._id }, reason: 'Rate difference', lines: [{ description: 'Rate', quantity: 1, rate: 1000, gstPercent: 5 }] });
    expect(cn.status).toBe(201);
    expect(cn.body.note).toMatchObject({ applied: 0, unapplied: 1050 });
    expect((await M.Invoice.findById(inv1._id).lean()).creditedAmount).toBe(0);
    // The customer's balance is a 1,050 credit, and the credit is listed.
    expect((await get(`/accounts/statement?partyType=customer&party=${c._id}`)).body.closing).toBe(-1050);
    const credits = await get(`/accounts/credits?partyType=customer&party=${c._id}`);
    expect(credits.body.credits).toEqual([expect.objectContaining({ sourceType: 'AccountNote', available: 1050 })]);

    const inv2 = await invoice(c, 5250);
    const applied = await post('/accounts/credits/apply', { source: { type: 'AccountNote', id: cn.body.note._id }, allocations: [{ docType: 'Invoice', doc: inv2._id, amount: 1050 }] });
    expect(applied.status).toBe(200);
    expect((await M.Invoice.findById(inv2._id).lean()).creditedAmount).toBe(1050);
    expect((await M.AccountNote.findById(cn.body.note._id).lean())).toMatchObject({ unapplied: 0, applications: [expect.objectContaining({ docNo: inv2.invoiceNumber, amount: 1050 })] });
    // Nothing left to apply.
    expect((await post('/accounts/credits/apply', { source: { type: 'AccountNote', id: cn.body.note._id }, allocations: [{ docType: 'Invoice', doc: inv2._id, amount: 1 }] })).status).toBe(400);
    // Cancelling the note takes it off the second invoice too.
    expect((await post(`/accounts/notes/${cn.body.note._id}/cancel`, { reason: 'Raised in error' })).status).toBe(200);
    expect((await M.Invoice.findById(inv2._id).lean()).creditedAmount).toBe(0);
  });

  it('a debit note to a customer raises what the invoice owes', async () => {
    const c = await customer();
    const inv = await invoice(c, 10500);
    const dn = await post('/accounts/notes', { kind: 'debit', partyType: 'customer', against: { doc: inv._id }, reason: 'Freight billed later', lines: [{ description: 'Freight', quantity: 1, rate: 400, gstPercent: 18 }] });
    expect(dn.status).toBe(201);
    expect(dn.body.note).toMatchObject({ kind: 'debit', partyType: 'customer', noteNo: 'DN/2026-27/0001', applied: 472, unapplied: 0 });
    expect((await M.Invoice.findById(inv._id).lean()).debitedAmount).toBe(472);
    const out = await get(`/accounts/outstanding?type=receivable&party=${c._id}`);
    expect(out.body.totals.total).toBe(10972);
    expect((await get(`/accounts/statement?partyType=customer&party=${c._id}`)).body.closing).toBe(10972);
    expect((await post(`/accounts/notes/${dn.body.note._id}/cancel`, { reason: 'Customer disputes freight' })).status).toBe(200);
    expect((await M.Invoice.findById(inv._id).lean()).debitedAmount).toBe(0);
  });

  it('an advance received is applied to the next invoice; cancelling the receipt puts the invoice back', async () => {
    const c = await customer();
    const acct = await cashBox();
    const adv = await receipt(c, acct, 20000, []);
    expect(adv.body.payment.unallocated).toBe(20000);
    const inv = await invoice(c, 10500);
    const docs = await get(`/accounts/payments/open-docs?partyType=customer&party=${c._id}`);
    expect(docs.body.credits).toEqual([expect.objectContaining({ sourceType: 'Payment', docNo: 'RCT/2026-27/0001', available: 20000 })]);
    const ap = await post('/accounts/credits/apply', { source: { type: 'Payment', id: adv.body.payment._id }, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] });
    expect(ap.status).toBe(200);
    const v = await M.Payment.findById(adv.body.payment._id).lean();
    expect(v.unallocated).toBe(9500);
    expect(v.allocations).toEqual([expect.objectContaining({ docNo: inv.invoiceNumber, amount: 10500, appliedAt: expect.any(Date) })]);
    expect((await get(`/accounts/outstanding?type=receivable&party=${c._id}`)).body.totals.total).toBe(0);
    // The ledger never moved: one receipt, one invoice.
    expect((await get(`/accounts/statement?partyType=customer&party=${c._id}`)).body.closing).toBe(-9500);
    expect((await post(`/accounts/payments/${adv.body.payment._id}/cancel`, { reason: 'Cheque bounced back' })).status).toBe(200);
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(0);
  });

  it('two receipts at the same moment cannot settle one invoice past its value', async () => {
    const c = await customer();
    const acct = await cashBox();
    const inv = await invoice(c, 10500);
    const both = await Promise.all([1, 2].map(() => receipt(c, acct, 10500, [{ docType: 'Invoice', doc: inv._id, amount: 10500 }])));
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(10500);
    expect(await M.Payment.countDocuments({ status: 'posted' })).toBe(1);
  });

  it('a supplier\'s expense is paid to that supplier, not to "other"', async () => {
    const s = await supplier();
    const acct = await cashBox();
    await get('/accounts/categories');
    const cat = await M.ExpenseCategory.findOne({ name: /Transport/i });
    await M.ExpenseCategory.updateOne({ _id: cat._id }, { approvalAbove: 100000 });
    const e = (await post('/accounts/expenses', { category: cat._id, description: 'Lorry to Tiruppur', supplier: s._id, amount: 4000, date: '2026-07-01' })).body.expense;
    expect(e.status).toBe('approved');
    const other = await post('/accounts/payments', { kind: 'payment', partyType: 'other', partyName: 'Driver', amount: 4000, mode: 'cash', account: acct._id, allocations: [{ docType: 'Expense', doc: e._id, amount: 4000 }] });
    expect(other.status).toBe(400);
    expect(other.body.message).toMatch(/supplier on file/);
    const ok = await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s._id, amount: 4000, mode: 'cash', account: acct._id, allocations: [{ docType: 'Expense', doc: e._id, amount: 4000 }] });
    expect(ok.status).toBe(201);
    expect((await M.Expense.findById(e._id).lean())).toMatchObject({ status: 'paid', paidAmount: 4000 });
  });

  it('an expense to a supplier falls due on the supplier\'s terms', async () => {
    const s = await supplier({ paymentTermsDays: 15 });
    await get('/accounts/categories');
    const cat = await M.ExpenseCategory.findOne({ name: /Transport/i });
    const e = (await post('/accounts/expenses', { category: cat._id, description: 'Lorry', supplier: s._id, amount: 4000, date: '2026-07-01' })).body.expense;
    expect(new Date(e.dueDate).toISOString().slice(0, 10)).toBe('2026-07-16');
    const bill = (await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'T/1', billDate: '2026-07-01', lines: [{ description: 'x', quantity: 1, rate: 100 }] })).body.bill;
    expect(new Date(bill.dueDate).toISOString().slice(0, 10)).toBe('2026-07-16');
  });
});

describe('contras', () => {
  it('move money between two of our accounts, on both cash books, and back when cancelled', async () => {
    const cash = await cashBox();
    const kotak = await bank();
    const res = await post('/accounts/contras', { from: kotak._id, to: cash._id, amount: 25000, date: '2026-07-05', reference: 'CHQ 4411' });
    expect(res.status).toBe(201);
    expect(res.body.contra).toMatchObject({ contraNo: 'CTR/2026-27/0001', fromName: kotak.name, toName: 'Cash box', mode: 'cash' });
    expect(await balanceOf(kotak._id)).toBe(75000);
    expect(await balanceOf(cash._id)).toBe(25000);
    const book = await get(`/accounts/reports/cashbook?account=${cash._id}&from=2026-07-01&to=2026-07-31`);
    expect(book.body.rows).toEqual([expect.objectContaining({ voucherNo: 'CTR/2026-27/0001', inflow: 25000, outflow: 0, balance: 25000 })]);
    const kbook = await get(`/accounts/reports/cashbook?account=${kotak._id}&from=2026-07-01&to=2026-07-31`);
    expect(kbook.body).toMatchObject({ opening: 100000, closing: 75000 });
    expect((await post('/accounts/contras', { from: kotak._id, to: kotak._id, amount: 1 })).status).toBe(400);
    expect((await post(`/accounts/contras/${res.body.contra._id}/cancel`, { reason: 'Entered twice' })).status).toBe(200);
    expect(await balanceOf(cash._id)).toBe(0);
  });
});

describe('opening balances', () => {
  it('an owed row ages, is settled by a receipt, and survives a ledger rebuild', async () => {
    const c = await customer();
    const acct = await cashBox();
    const ob = await post('/accounts/opening-balances', { partyType: 'customer', party: c._id, kind: 'due', refNo: 'TALLY/882', date: '2026-03-10', amount: 48500 });
    expect(ob.status).toBe(201);
    expect(ob.body.row).toMatchObject({ docNo: 'OB/2025-26/0001', partyName: c.name, kind: 'due' });
    expect(new Date(ob.body.row.dueDate).toISOString().slice(0, 10)).toBe('2026-04-09');
    const out = await get(`/accounts/outstanding?type=receivable&party=${c._id}`);
    expect(out.body.rows).toEqual([expect.objectContaining({ docType: 'OpeningBalance', docNo: 'OB/2025-26/0001', outstanding: 48500, bucket: 'over90' })]);
    expect((await get(`/accounts/statement?partyType=customer&party=${c._id}`)).body.closing).toBe(48500);

    const r = await receipt(c, acct, 20000, [{ docType: 'OpeningBalance', doc: ob.body.row._id, amount: 20000 }]);
    expect(r.status).toBe(201);
    expect((await M.OpeningBalance.findById(ob.body.row._id).lean()).settledAmount).toBe(20000);
    // Settled in part: cannot be cancelled.
    expect((await post(`/accounts/opening-balances/${ob.body.row._id}/cancel`, { reason: 'Wrong amount entered' })).status).toBe(409);
    await post('/accounts/ledger/rebuild', {});
    expect((await get(`/accounts/statement?partyType=customer&party=${c._id}`)).body.closing).toBe(28500);
  });

  it('a supplier advance is applied to the supplier\'s next bill', async () => {
    const s = await supplier();
    const ob = (await post('/accounts/opening-balances', { partyType: 'supplier', party: s._id, kind: 'advance', date: '2026-03-31', amount: 5000 })).body.row;
    expect(ob.unapplied).toBe(5000);
    expect((await get(`/accounts/statement?partyType=supplier&party=${s._id}`)).body.closing).toBe(-5000);
    const bill = (await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'SY/1', billDate: '2026-07-01', lines: [{ description: 'Yarn', quantity: 10, rate: 1000, gstPercent: 5 }] })).body.bill;
    const ap = await post('/accounts/credits/apply', { source: { type: 'OpeningBalance', id: ob._id }, allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 5000 }] });
    expect(ap.status).toBe(200);
    expect((await M.SupplierBill.findById(bill._id).lean())).toMatchObject({ paidAmount: 5000, status: 'part_paid' });
    expect((await M.OpeningBalance.findById(ob._id).lean()).unapplied).toBe(0);
  });

  it('import from a spreadsheet: parties matched by name or GSTIN, sides read from Dr/Cr, problems listed', async () => {
    const c = await customer();
    const s = await supplier();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('x');
    ws.addRow(['Ledger balances as on 31-Mar-2026']);
    ws.addRow(['Type', 'Party', 'GSTIN', 'Ref', 'Date', 'Due date', 'Amount', 'Dr/Cr']);
    ws.addRow(['Customer', c.name.toLowerCase(), '', 'INV-1', '12/03/2026', '', '48,500', 'Dr']);
    ws.addRow(['', 'Whatever Name', s.gstin, 'SY/9', '20/03/2026', '', '32150', 'Cr']);
    ws.addRow(['Customer', c.name, '', 'ADV', '25/03/2026', '', '2000', 'Cr']);
    ws.addRow(['Supplier', 'Nobody Traders', '', '', '25/03/2026', '', '100', 'Cr']);
    const buf = await wb.xlsx.writeBuffer();
    const res = await request(app).post('/api/v2/accounts/opening-balances/import').set('Cookie', cookie()).attach('file', Buffer.from(buf), { filename: 'tally.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: 3, problems: 1 });
    const [a, b, d, e] = res.body.rows;
    expect(a).toMatchObject({ partyType: 'customer', partyName: c.name, kind: 'due', amount: 48500, date: '2026-03-12', problem: null });
    expect(b).toMatchObject({ partyType: 'supplier', partyName: s.name, kind: 'due', amount: 32150 });
    expect(d).toMatchObject({ partyType: 'customer', kind: 'advance', amount: 2000 });
    expect(e.problem).toMatch(/No supplier named "Nobody Traders"/);
    const bulk = await post('/accounts/opening-balances/bulk', { rows: res.body.rows.filter((r) => !r.problem) });
    expect(bulk.body).toMatchObject({ posted: 3, failed: 0 });
    expect((await get(`/accounts/statement?partyType=customer&party=${c._id}`)).body.closing).toBe(46500);
    expect((await get('/accounts/opening-balances')).body.totals).toEqual({ customer: { due: 48500, advance: 2000 }, supplier: { due: 32150, advance: 0 } });
  });
});

describe('the books lock', () => {
  it('refuses entries and cancellations in a closed period unless an admin gives a reason', async () => {
    const c = await customer();
    const acct = await cashBox();
    const inv = await invoice(c, 10500);
    const early = await receipt(c, acct, 1000, [{ docType: 'Invoice', doc: inv._id, amount: 1000 }], { date: '2026-06-10' });
    expect(early.status).toBe(201);
    expect((await post('/accounts/lock', { lockDate: '2026-06-30' }, clerk)).status).toBe(403);
    expect((await post('/accounts/lock', { lockDate: '2026-06-30' })).status).toBe(200);

    const late = await receipt(c, acct, 500, [{ docType: 'Invoice', doc: inv._id, amount: 500 }], { date: '2026-06-30' });
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/books are closed up to 30 Jun 2026/);
    expect((await post(`/accounts/payments/${early.body.payment._id}/cancel`, { reason: 'Cheque bounced' })).status).toBe(409);
    // After the lock: fine.
    expect((await receipt(c, acct, 500, [{ docType: 'Invoice', doc: inv._id, amount: 500 }], { date: '2026-07-01' })).status).toBe(201);
    // An admin with a reason may.
    expect((await receipt(c, acct, 200, [{ docType: 'Invoice', doc: inv._id, amount: 200 }], { date: '2026-06-20', lockOverride: 'Missed bank entry for June' })).status).toBe(201);
    expect((await receipt(c, acct, 200, [{ docType: 'Invoice', doc: inv._id, amount: 200 }], { date: '2026-06-20', lockOverride: 'Missed bank entry for June' }, )).status).toBe(201);
    const clerkTry = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: c._id, amount: 100, mode: 'cash', account: acct._id, date: '2026-06-20', lockOverride: 'Missed bank entry for June' }, clerk);
    expect(clerkTry.status).toBe(409);
    // Reopening needs a reason.
    expect((await post('/accounts/lock', { lockDate: null })).status).toBe(400);
    expect((await post('/accounts/lock', { lockDate: null, reason: 'Auditor asked for a June correction' })).status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE LOCK IS ASKED BY EVERY POSTING, AND KEEPS ITS OWN HISTORY
//
//  Payroll, depreciation and stock journals once went round the lock
//  (the services that post them never asked it), and so did an asset
//  disposal dated in a closed year. The reason an admin typed to
//  override it was thrown away, and so was the reason for opening the
//  books again.
// ══════════════════════════════════════════════════════════════════
describe('the lock is asked by every posting', () => {
  const Journal = () => require('../../models/Journal');
  const asset = () => post('/accounts/fixed-assets', { name: 'Needle loom 12', block: 'plant', purchaseDate: '2025-05-01', putToUse: '2025-05-10', cost: 1000000 });

  it('depreciation, closing stock and an asset disposal are refused inside a closed year', async () => {
    const a = await asset();
    expect(a.status).toBe(201);
    expect((await post('/accounts/lock', { lockDate: '2026-03-31' })).status).toBe(200);

    // The year's depreciation is dated 31 March of the closed year.
    const byClerk = await post('/accounts/fixed-assets/depreciation', { fy: '2025-26' }, clerk);
    expect(byClerk.status).toBe(409);
    expect(byClerk.body.message).toMatch(/books are closed up to 31 Mar 2026/);
    expect(await Journal().countDocuments({})).toBe(0);
    // An admin without a reason is refused the same way.
    expect((await post('/accounts/fixed-assets/depreciation', { fy: '2025-26' })).status).toBe(409);

    // A disposal dated inside the closed year changes that year's depreciation.
    const sold = await post(`/accounts/fixed-assets/${a.body.asset._id}/dispose`, { how: 'sold', date: '2026-02-10', amount: 500000, reason: 'Sold to Kumar Looms' }, clerk);
    expect(sold.status).toBe(409);
    // After the closed period it goes through.
    expect((await post(`/accounts/fixed-assets/${a.body.asset._id}/dispose`, { how: 'sold', date: '2026-04-10', amount: 500000, reason: 'Sold to Kumar Looms' }, clerk)).status).toBe(200);
  });

  it('an admin posts it with a reason, and the reason is on the journal and in the history', async () => {
    await asset();
    await post('/accounts/lock', { lockDate: '2026-03-31' });
    const res = await post('/accounts/fixed-assets/depreciation', { fy: '2025-26', lockOverride: 'Auditor asked for the depreciation entry' });
    expect(res.status).toBe(201);
    const j = await Journal().findOne({ source: 'depreciation', sourceRef: '2025-26', status: 'posted' }).lean();
    expect(j.fingerprints[0].meta).toMatchObject({ lockOverride: 'Auditor asked for the depreciation entry' });

    // Re-posting cancels the first and posts another: both inside the closed year, both need the reason.
    expect((await post('/accounts/fixed-assets/depreciation', { fy: '2025-26' }, clerk)).status).toBe(409);
    expect(await Journal().countDocuments({ source: 'depreciation', status: 'posted' })).toBe(1);

    const h = (await get('/accounts/lock/history')).body.events;
    expect(h.map((e) => e.kind)).toEqual(['override', 'closed']);
    expect(h[0]).toMatchObject({ kind: 'override', reason: 'Auditor asked for the depreciation entry', byName: 'Owner', entry: { cancelling: false, method: 'POST', path: '/api/v2/accounts/fixed-assets/depreciation' } });
    expect(new Date(h[0].entry.date).toISOString().slice(0, 10)).toBe('2026-03-31');
  });
});

describe('the lock keeps its history', () => {
  it('records closing, moving, an override and opening again: who, when and why', async () => {
    const c = await customer();
    const acct = await cashBox();
    const inv = await invoice(c, 10500);
    expect((await post('/accounts/lock', { lockDate: '2026-06-30' })).body.changed).toBe(true);
    // The same date again changes nothing and writes nothing.
    expect((await post('/accounts/lock', { lockDate: '2026-06-30' })).body.changed).toBe(false);
    await post('/accounts/lock', { lockDate: '2026-07-31' });

    // An override: the reason goes on the voucher's fingerprint and into the history.
    const v = await receipt(c, acct, 200, [{ docType: 'Invoice', doc: inv._id, amount: 200 }], { date: '2026-06-20', lockOverride: 'Missed bank entry for June' });
    expect(v.status).toBe(201);
    const stored = await M.Payment.findById(v.body.payment._id).lean();
    expect(stored.fingerprints[0].meta).toMatchObject({ lockOverride: 'Missed bank entry for June' });
    // A clerk sending the same words is still refused, and nothing is recorded for it.
    expect((await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: c._id, amount: 100, mode: 'cash', account: acct._id, date: '2026-06-20', lockOverride: 'Missed bank entry for June' }, clerk)).status).toBe(409);
    // Cancelling it is inside the closed period too.
    expect((await post(`/accounts/payments/${v.body.payment._id}/cancel`, { reason: 'Entered against the wrong month' })).status).toBe(409);
    expect((await post(`/accounts/payments/${v.body.payment._id}/cancel`, { reason: 'Entered against the wrong month', lockOverride: 'Auditor asked for it to come out' })).status).toBe(200);

    // Moving the date earlier is opening the books: it needs a reason.
    expect((await post('/accounts/lock', { lockDate: '2026-06-30' })).status).toBe(400);
    const open = await post('/accounts/lock', { lockDate: null, reason: 'Auditor asked for a June correction' });
    expect(open.status).toBe(200);
    expect(open.body.settings.lockDate).toBeNull();
    // What the screens are sent: the connector's key hash never leaves the server.
    expect(open.body.settings.connector).toEqual({ configured: false, lastSeenAt: null });
    expect(JSON.stringify(open.body)).not.toMatch(/keyHash/);

    const h = (await get('/accounts/lock/history')).body.events;
    expect(h.map((e) => e.kind)).toEqual(['reopened', 'override', 'override', 'moved', 'closed']);
    expect(h[0]).toMatchObject({ kind: 'reopened', reason: 'Auditor asked for a June correction', byName: 'Owner', lockDate: null });
    expect(new Date(h[0].previousLockDate).toISOString().slice(0, 10)).toBe('2026-07-31');
    expect(h[1]).toMatchObject({ kind: 'override', reason: 'Auditor asked for it to come out', entry: { cancelling: true } });
    expect(h[2]).toMatchObject({ kind: 'override', reason: 'Missed bank entry for June', entry: { cancelling: false, method: 'POST', path: '/api/v2/accounts/payments' } });
    expect(h[3]).toMatchObject({ kind: 'moved', via: 'settings' });
    expect(h[4]).toMatchObject({ kind: 'closed', byName: 'Owner' });
  });

  it('the health check finds an entry made inside a closed period, also after the lock has moved on', async () => {
    const Journal = require('../../models/Journal');
    const lines = [{ kind: 'ledger', ledger: 'Depreciation', debit: 100, credit: 0 }, { kind: 'ledger', ledger: 'Accumulated Depreciation', debit: 0, credit: 100 }];
    const { buildFingerprint, ACTION_CODES } = require('../../utils/fingerprint');
    const journal = (no, date, meta) => {
      const _id = new mongoose.Types.ObjectId();
      return Journal.create({ _id, journalNo: no, financialYear: '2026-27', sequence: Number(no.slice(-1)), date: new Date(`${date}T00:00:00Z`), purpose: 'other', reason: 'Written straight to the database', lines, total: 100, fingerprints: [buildFingerprint(ACTION_CODES.JOURNAL_POSTED, { entityId: _id, meta: meta || { journalNo: no } })] });
    };
    const lockRows = async () => (await get('/accounts/health')).body.checks.find((x) => x.key === 'lock');

    await journal('JV/T/1', '2026-06-15');                       // before the books were closed: fine
    await post('/accounts/lock', { lockDate: '2026-06-30' });
    await new Promise((r) => setTimeout(r, 15));
    await journal('JV/T/2', '2026-06-20');                       // inside the closed month, after it closed
    await journal('JV/T/3', '2026-06-21', { lockOverride: 'Auditor asked for this entry' }); // let through, with its reason
    await journal('JV/T/4', '2026-07-05');                       // after the closed period: fine
    let c = await lockRows();
    expect(c.ok).toBe(false);
    expect(c.rows.map((r) => r.docNo)).toEqual(['JV/T/2']);

    // The next month is closed: the June finding is still there.
    await post('/accounts/lock', { lockDate: '2026-07-31' });
    c = await lockRows();
    expect(c.rows.map((r) => r.docNo)).toEqual(['JV/T/2']);
  });
});
