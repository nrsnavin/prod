'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE ACCOUNTS MODULE, END TO END
//
//    • a supplier bill from a PO's receipts: lines proposed at the PO
//      price, the supplier's bill number entered once only, the bill on
//      the supplier's account from the day it is dated
//    • an expense: approved when the head or the amount asks for it,
//      paid from the cash box by a voucher that is written with it
//    • a credit note takes the invoice's outstanding down; a debit note
//      takes the bill's down
//    • a receipt settles invoices; a payment settles bills with TDS
//      deducted and reported; neither can settle more than is owed;
//      cancelling a voucher puts everything back
//    • statements run, ageing buckets, the overview adds up, the GST
//      and cash book reports read what the documents say
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, clerk;
const cookie = (u = admin) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'RawMaterial', 'PurchaseOrder', 'MaterialInward', 'Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'BankAccount', 'ExpenseCategory', 'PartyLedgerEntry']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'acct@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Clerk', email: 'clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

const partyLedger = () => require('../../services/partyLedger');

let n = 0;
async function supplierScene() {
  n += 1;
  const supplier = await M.Supplier.create({ name: `Sri Yarn ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode' });
  const nylon = await M.RawMaterial.create({ name: `Nylon 70D ${n}`, category: 'covering', unit: 'kg', stock: 0, price: 300 });
  const po = await M.PurchaseOrder.create({ supplier: supplier._id, poNo: 500 + n, items: [{ rawMaterial: nylon._id, price: 310, quantity: 100, receivedQuantity: 60 }] });
  const in1 = await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 40, unitPrice: 310, inwardDate: new Date('2026-07-01') });
  const in2 = await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 20, unitPrice: 310, inwardDate: new Date('2026-07-03') });
  return { supplier, nylon, po, in1, in2 };
}

async function customerScene(grand = 10500, over = {}, existing = null) {
  n += 1;
  const customer = existing || await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', phoneNumber: `92000000${String(n).padStart(2, '0')}`, gstin: `33AAEPS111${n}F1Z2`, paymentTerms: '30' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date('2026-06-01'), dueDate: new Date('2026-07-01'),
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand }, status: 'issued', ...over,
  });
  await partyLedger().post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand, narration: 'Sales' });
  return { customer, inv };
}

const cashBox = async () => { await get('/accounts/bank-accounts'); return M.BankAccount.findOne({ kind: 'cash' }); };
const category = async (name) => { await get('/accounts/categories'); return M.ExpenseCategory.findOne({ name }); };

describe('masters', () => {
  it('seed a cash box and the expense heads, and keep one default account', async () => {
    const res = await get('/accounts/bank-accounts');
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a) => a.name)).toEqual(['Cash box']);
    expect((await get('/accounts/categories')).body.categories.length).toBeGreaterThan(8);
    const bank = await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', bankName: 'Kotak', accountNo: '7612149219', ifsc: 'KKBK0000492', openingBalance: 50000, isDefault: true });
    expect(bank.status).toBe(201);
    const again = await get('/accounts/bank-accounts');
    expect(again.body.accounts.find((a) => a.name === 'Kotak CA')).toMatchObject({ isDefault: true, balance: 50000 });
    expect(again.body.accounts.find((a) => a.name === 'Cash box').isDefault).toBe(false);
    expect((await post('/accounts/bank-accounts', { name: 'X' }, clerk)).status).toBe(403);
  });
});

describe('a supplier bill against a purchase order', () => {
  it('proposes the unbilled receipts at the PO price, and is on the supplier account from its date', async () => {
    const s = await supplierScene();
    const info = await get(`/accounts/bills/po-info?id=${s.po._id}`);
    expect(info.status).toBe(200);
    expect(info.body.lines).toEqual([expect.objectContaining({ description: s.nylon.name, quantity: 60, rate: 310, gstPercent: 5, inwards: [String(s.in1._id), String(s.in2._id)] })]);

    const res = await post('/accounts/bills', {
      supplier: s.supplier._id, supplierBillNo: 'SY/118', billDate: '2026-07-04', purchaseOrder: s.po._id, inwards: [s.in1._id, s.in2._id],
      lines: [{ rawMaterial: s.nylon._id, description: s.nylon.name, hsn: '5402', unit: 'kg', quantity: 60, rate: 310, gstPercent: 5 }],
      tds: { applicable: false }, requestId: 'b1',
    });
    expect(res.status).toBe(201);
    const bill = res.body.bill;
    expect(bill.billNo).toBe('PB/2026-27/0001');
    expect(bill.supplyType).toBe('intra');
    // 60 × 310 = 18,600 at 5% → 465 + 465 → 19,530
    expect(bill.totals).toMatchObject({ taxable: 18600, cgst: 465, sgst: 465, grand: 19530 });
    expect(bill.itc).toEqual({ eligible: true, amount: 930 });
    expect(bill.poNo).toBe(s.po.poNo);
    expect(bill.status).toBe('open');
    expect(new Date(bill.dueDate).toISOString().slice(0, 10)).toBe('2026-08-03');

    // The receipts are billed now, and the same supplier bill cannot come in twice.
    const after = await get(`/accounts/bills/po-info?id=${s.po._id}`);
    expect(after.body.inwards.every((i) => i.billedOn === 'PB/2026-27/0001')).toBe(true);
    expect(after.body.lines).toEqual([]);
    const twice = await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/118', lines: [{ description: 'x', quantity: 1, rate: 1 }] });
    expect(twice.status).toBe(409);
    expect(twice.body.message).toMatch(/already entered/);
    expect((await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/119', inwards: [s.in1._id], lines: [{ description: 'x', quantity: 1, rate: 1 }] })).status).toBe(409);
    // A replay is the same bill.
    const replay = await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/118', lines: [{ description: 'x', quantity: 1, rate: 1 }], requestId: 'b1' });
    expect(replay.status).toBe(200);
    expect(replay.body.replay).toBe(true);

    const st = await get(`/accounts/statement?partyType=supplier&party=${s.supplier._id}`);
    expect(st.body.rows).toEqual([expect.objectContaining({ docNo: 'PB/2026-27/0001', credit: 19530, balance: 19530 })]);
    expect(st.body.closing).toBe(19530);
    expect(st.body.open).toMatchObject({ total: 19530, count: 1 });
  });

  it('an inter-state supplier is charged IGST, and a cancelled bill leaves the account', async () => {
    const s = await supplierScene();
    await M.Supplier.updateOne({ _id: s.supplier._id }, { $set: { gstin: '29AAAPS0009F1Z9' } });
    const res = await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'K/1', kind: 'service', lines: [{ description: 'Dyeing', quantity: 1, rate: 1000, gstPercent: 18 }], tds: { applicable: true, section: '194C', rate: 2 } });
    expect(res.status).toBe(201);
    expect(res.body.bill.supplyType).toBe('inter');
    expect(res.body.bill.totals).toMatchObject({ igst: 180, grand: 1180 });
    expect(res.body.bill.tds).toMatchObject({ applicable: true, section: '194C', rate: 2 });
    expect((await post(`/accounts/bills/${res.body.bill._id}/cancel`, { reason: 'short' })).status).toBe(400);
    const cancel = await post(`/accounts/bills/${res.body.bill._id}/cancel`, { reason: 'Entered against the wrong supplier' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.bill.status).toBe('cancelled');
    expect((await get(`/accounts/statement?partyType=supplier&party=${s.supplier._id}`)).body.rows).toEqual([]);
  });
});

describe('expenses', () => {
  it('waits for approval when the head says so, is approved by someone else, and paid from the cash box by a voucher', async () => {
    const cat = await category('Transport & freight'); // approval above 5,000
    const cash = await cashBox();
    const res = await post('/accounts/expenses', { category: cat._id, description: 'Lorry to Tiruppur', payeeName: 'VRL', amount: 6000, gstPercent: 5, date: '2026-07-05', requestId: 'e1' }, clerk);
    expect(res.status).toBe(201);
    expect(res.body.expense).toMatchObject({ expenseNo: 'EXP/2026-27/0001', status: 'pending', categoryName: 'Transport & freight' });
    expect(res.body.expense.totals).toMatchObject({ taxable: 6000, grand: 6300 });
    expect(res.body.expense.itc).toEqual({ eligible: true, amount: 300 });
    const id = res.body.expense._id;
    // Not by the clerk who entered it.
    expect((await post(`/accounts/expenses/${id}/approve`, {}, clerk)).status).toBe(403);
    expect((await post(`/accounts/expenses/${id}/pay`, { account: cash._id })).status).toBe(409);
    const ok = await post(`/accounts/expenses/${id}/approve`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.expense.status).toBe('approved');
    expect(ok.body.expense.approval.byName).toBe('Owner');
    const pay = await post(`/accounts/expenses/${id}/pay`, { account: cash._id, reference: 'cash' });
    expect(pay.status).toBe(200);
    expect(pay.body.expense).toMatchObject({ status: 'paid', paidAmount: 6300 });
    expect(pay.body.voucher.voucherNo).toBe('PAY/2026-27/0001');
    const v = await M.Payment.findOne({ voucherNo: 'PAY/2026-27/0001' }).lean();
    expect(v).toMatchObject({ kind: 'payment', partyType: 'other', partyName: 'VRL', amount: 6300, mode: 'cash', accountName: 'Cash box', allocations: [expect.objectContaining({ docType: 'Expense', amount: 6300 })] });
    expect((await get('/accounts/bank-accounts')).body.accounts.find((a) => a.kind === 'cash').balance).toBe(-6300);
    expect((await get(`/accounts/expenses?status=pending`)).body.pendingCount).toBe(0);
  });

  it('below the head\'s limit it is approved at once and can be paid on the spot', async () => {
    const cat = await category('Office & stationery'); // above 2,000
    const cash = await cashBox();
    const res = await post('/accounts/expenses', { category: cat._id, description: 'Printer paper', payeeName: 'Stationers', amount: 800, payNow: { account: cash._id } });
    expect(res.status).toBe(201);
    expect(res.body.expense).toMatchObject({ status: 'paid', paidAmount: 800 });
    expect(res.body.expense.approval.required).toBe(false);
    expect(res.body.voucher.voucherNo).toBe('PAY/2026-27/0001');
    expect((await post('/accounts/expenses', { category: cat._id, description: 'Toner', amount: 2500 })).body.expense.status).toBe('pending');
  });

  it('a rejected expense says why; a supplier expense sits on the supplier account once approved', async () => {
    const cat = await category('Job work'); // always approved
    const s = await supplierScene();
    const res = await post('/accounts/expenses', { category: cat._id, description: 'Dyeing lot 7', supplier: s.supplier._id, amount: 4000, gstPercent: 12 });
    expect(res.body.expense).toMatchObject({ status: 'pending', payeeName: s.supplier.name, supplyType: 'intra' });
    const rej = await post(`/accounts/expenses/${res.body.expense._id}/reject`, { reason: 'Duplicate of EXP/0003' });
    expect(rej.status).toBe(200);
    expect(rej.body.expense.approval.note).toBe('Duplicate of EXP/0003');
    const again = await post('/accounts/expenses', { category: cat._id, description: 'Dyeing lot 8', supplier: s.supplier._id, amount: 4000, gstPercent: 12 });
    await post(`/accounts/expenses/${again.body.expense._id}/approve`, {});
    const st = await get(`/accounts/statement?partyType=supplier&party=${s.supplier._id}`);
    expect(st.body.rows).toEqual([expect.objectContaining({ docType: 'Expense', credit: 4480 })]);
    const pay = await get(`/accounts/outstanding?type=payable&party=${s.supplier._id}`);
    expect(pay.body.totals.total).toBe(4480);
  });
});

describe('credit and debit notes', () => {
  it('a credit note takes the invoice\'s outstanding down and sits on the customer account', async () => {
    const { customer, inv } = await customerScene();
    const res = await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference agreed', lines: [{ description: '20mm rate diff', quantity: 1000, rate: 0.5, gstPercent: 5 }], date: '2026-06-10' });
    expect(res.status).toBe(201);
    expect(res.body.note).toMatchObject({ noteNo: 'CN/2026-27/0001', partyType: 'customer', partyName: customer.name, against: { docType: 'Invoice', docNo: inv.invoiceNumber } });
    expect(res.body.note.totals).toMatchObject({ taxable: 500, grand: 525 });
    expect((await M.Invoice.findById(inv._id).lean()).creditedAmount).toBe(525);
    const open = await get(`/accounts/outstanding?type=receivable&party=${customer._id}`);
    expect(open.body.rows[0].outstanding).toBe(9975);
    const st = await get(`/accounts/statement?partyType=customer&party=${customer._id}`);
    expect(st.body.rows.map((r) => [r.docNo, r.debit, r.credit, r.balance])).toEqual([[inv.invoiceNumber, 10500, 0, 10500], ['CN/2026-27/0001', 0, 525, 9975]]);
    // Cancelling the note puts it back.
    await post(`/accounts/notes/${res.body.note._id}/cancel`, { reason: 'Issued by mistake' });
    expect((await M.Invoice.findById(inv._id).lean()).creditedAmount).toBe(0);
  });

  it('a debit note takes the bill down, to paid when nothing is left', async () => {
    const s = await supplierScene();
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'SY/200', lines: [{ description: 'Nylon', quantity: 10, rate: 100, gstPercent: 5 }] })).body.bill; // 1,050
    const dn = await post('/accounts/notes', { kind: 'debit', against: { doc: bill._id }, reason: 'Short supply 4 kg', lines: [{ description: 'Nylon short', quantity: 4, rate: 100, gstPercent: 5 }] });
    expect(dn.status).toBe(201);
    expect(dn.body.note.noteNo).toBe('DN/2026-27/0001');
    let b = await M.SupplierBill.findById(bill._id).lean();
    expect(b).toMatchObject({ debitedAmount: 420, status: 'open' });
    const dn2 = await post('/accounts/notes', { kind: 'debit', against: { doc: bill._id }, reason: 'Rejected the rest', lines: [{ description: 'Nylon rejected', quantity: 6, rate: 100, gstPercent: 5 }] });
    expect(dn2.body.note.noteNo).toBe('DN/2026-27/0002');
    b = await M.SupplierBill.findById(bill._id).lean();
    expect(b).toMatchObject({ debitedAmount: 1050, status: 'paid' });
    expect((await get(`/accounts/outstanding?type=payable&party=${s.supplier._id}`)).body.totals.total).toBe(0);
  });
});

describe('receipts and payments', () => {
  it('a receipt settles invoices, never more than is owed, and a cancelled one gives it back', async () => {
    const { customer, inv } = await customerScene();
    const { inv: inv2 } = await customerScene(2100, {}, customer);
    const bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 1000 })).body.account;
    const docs = await get(`/accounts/payments/open-docs?partyType=customer&party=${customer._id}`);
    expect(docs.body.docs.map((d) => d.outstanding).sort((a, b) => a - b)).toEqual([2100, 10500]);

    const over = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 5000, mode: 'bank', account: bank._id, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 12000 }] });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/has only 10500.00 outstanding/);
    const short = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 5000, mode: 'bank', account: bank._id, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 6000 }] });
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/need 6000.00 but the voucher is for 5000.00/);

    const res = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 12000, mode: 'bank', account: bank._id, reference: 'UTR123', date: '2026-06-20',
      allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }, { docType: 'Invoice', doc: inv2._id, amount: 1000 }], requestId: 'r1' });
    expect([res.status, res.body.message]).toEqual([201, undefined]);
    expect(res.body.payment).toMatchObject({ voucherNo: 'RCT/2026-27/0001', partyName: customer.name, amount: 12000, unallocated: 500, accountName: 'Kotak CA' });
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(10500);
    expect((await M.Invoice.findById(inv2._id).lean()).paidAmount).toBe(1000);
    const open = await get(`/accounts/outstanding?type=receivable&party=${customer._id}`);
    expect(open.body.rows).toEqual([expect.objectContaining({ docNo: inv2.invoiceNumber, outstanding: 1100 })]);
    const st = await get(`/accounts/statement?partyType=customer&party=${customer._id}`);
    expect(st.body.closing).toBe(600); // 10,500 + 2,100 − 12,000
    expect((await get('/accounts/bank-accounts')).body.accounts.find((a) => a.name === 'Kotak CA').balance).toBe(13000);

    // The invoice cannot be cancelled with a receipt on it.
    expect((await post(`/invoice/${inv._id}/cancel`, { reason: 'Wrong rate agreed' })).status).toBe(409);

    const cancel = await post(`/accounts/payments/${res.body.payment._id}/cancel`, { reason: 'Bounced cheque' });
    expect(cancel.status).toBe(200);
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(0);
    expect((await get(`/accounts/statement?partyType=customer&party=${customer._id}`)).body.closing).toBe(12600);
  });

  it('a payment to a supplier deducts TDS on the bill, reports it, and the bill is settled gross', async () => {
    const s = await supplierScene();
    const cash = await cashBox();
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'JW/9', kind: 'service', lines: [{ description: 'Job work', quantity: 1, rate: 50000, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 2 } })).body.bill; // 52,500
    const docs = await get(`/accounts/payments/open-docs?partyType=supplier&party=${s.supplier._id}`);
    expect(docs.body.docs[0]).toMatchObject({ docNo: 'PB/2026-27/0001', outstanding: 52500, tds: { section: '194C', rate: 2 } });
    // Settle 52,500 gross. TDS is on the value net of GST (CBDT circular
    // 23/2017): 2% of 50,000 = 1,000 deducted, 51,500 paid.
    const over = await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s.supplier._id, amount: 51450, mode: 'bank', account: cash._id, tds: { section: '194C', rate: 2 },
      allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 52500 }], date: '2026-07-20' });
    expect(over.status).toBe(400); // 1,050 off the gross would be wrong; the cash falls 50 short
    const res = await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s.supplier._id, amount: 51500, mode: 'bank', account: cash._id, tds: { section: '194C', rate: 2 },
      allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 52500 }], date: '2026-07-20' });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ voucherNo: 'PAY/2026-27/0001', tds: { section: '194C', rate: 2, amount: 1000, base: 50000 }, unallocated: 0 });
    expect(res.body.payment.allocations[0]).toMatchObject({ amount: 52500, tds: 1000, tdsBase: 50000 });
    const b = await M.SupplierBill.findById(bill._id).lean();
    expect(b).toMatchObject({ paidAmount: 51500, tdsAmount: 1000, status: 'paid' });
    const st = await get(`/accounts/statement?partyType=supplier&party=${s.supplier._id}`);
    expect(st.body.closing).toBe(0);
    const tds = await get('/accounts/reports/tds?from=2026-07-01&to=2026-07-31');
    expect(tds.body.rows).toEqual([expect.objectContaining({ partyName: s.supplier.name, section: '194C', gross: 52500, base: 50000, tds: 1000 })]);
    expect(tds.body.total).toEqual({ gross: 52500, base: 50000, tds: 1000 });
    // A payment that leaves part open marks the bill part-paid.
    const bill2 = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'JW/10', lines: [{ description: 'Yarn', quantity: 1, rate: 1000, gstPercent: 5 }] })).body.bill;
    await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s.supplier._id, amount: 500, mode: 'cash', account: cash._id, allocations: [{ docType: 'SupplierBill', doc: bill2._id, amount: 500 }] });
    expect((await M.SupplierBill.findById(bill2._id).lean()).status).toBe('part_paid');
    expect((await get('/accounts/bills?status=part_paid')).body.bills[0].outstanding).toBe(550);
  });

  it('refuses a voucher to the wrong party, the wrong kind, or an unknown account', async () => {
    const { customer, inv } = await customerScene();
    const s = await supplierScene();
    const cash = await cashBox();
    expect((await post('/accounts/payments', { kind: 'payment', partyType: 'customer', customer: customer._id, amount: 10, mode: 'cash', account: cash._id })).status).toBe(400);
    expect((await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10, mode: 'cash', account: new mongoose.Types.ObjectId() })).status).toBe(404);
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'Z/1', lines: [{ description: 'x', quantity: 1, rate: 100 }] })).body.bill;
    const wrong = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10, mode: 'cash', account: cash._id, allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 10 }] });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/cannot settle a SupplierBill/);
    const other = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10, mode: 'cash', account: cash._id, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10 }] });
    expect(other.status).toBe(201);
  });
});

describe('ageing, overview and reports', () => {
  it('buckets what is owed by how far past due, and the overview adds up', async () => {
    const { customer } = await customerScene();                     // due 1 Jul 2026, long overdue
    const { customer: c2 } = await customerScene(5000, { dueDate: new Date(Date.now() + 10 * 86_400_000) }); // not due
    const s = await supplierScene();
    // The overview's month is last month until the 10th.
    const d = new Date();
    const inMonth = d.getDate() < 10 ? new Date(d.getFullYear(), d.getMonth() - 1, 15) : d;
    await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'A/1', billDate: inMonth.toISOString(), lines: [{ description: 'x', quantity: 1, rate: 1000, gstPercent: 5 }] });
    const recv = await get('/accounts/outstanding?type=receivable');
    expect(recv.body.totals).toMatchObject({ total: 15500, overdue: 10500 });
    expect(recv.body.totals.ageing.over90).toBe(10500);
    expect(recv.body.totals.ageing.current).toBe(5000);
    expect(recv.body.byParty.map((p) => [p.partyName, p.total])).toEqual([[customer.name, 10500], [c2.name, 5000]]);
    const ov = await get('/accounts/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.receivables.total).toBe(15500);
    expect(ov.body.payables.total).toBe(1050);
    expect(ov.body.accounts.find((a) => a.kind === 'cash')).toMatchObject({ balance: 0 });
    expect(ov.body.month.purchases).toMatchObject({ amount: 1050, inputCredit: 50, count: 1 });
    expect(ov.body.month.current).toBe(d.getDate() >= 10);
  });

  it('the GST report sets output tax against input credit, and the cash book runs a balance', async () => {
    const { customer, inv } = await customerScene();
    const s = await supplierScene();
    const cash = await cashBox();
    await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'G/1', billDate: '2026-06-15', lines: [{ description: 'Nylon', quantity: 10, rate: 200, gstPercent: 5 }] }); // tax 100
    const cat = await category('Electricity'); // no ITC
    await post('/accounts/expenses', { category: cat._id, description: 'EB bill', amount: 3000, gstPercent: 18, date: '2026-06-16' });
    const gst = await get('/accounts/reports/gst?from=2026-06-01&to=2026-06-30');
    expect(gst.status).toBe(200);
    expect(gst.body.totals.output).toMatchObject({ taxable: 10000, cgst: 250, sgst: 250 });
    expect(gst.body.totals.purchases).toMatchObject({ taxable: 2000, cgst: 50, sgst: 50 });
    expect(gst.body.totals.expenses.tax).toBe(0);
    expect(gst.body.totals.payable).toEqual({ cgst: 200, sgst: 200, igst: 0 });

    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 4000, mode: 'cash', account: cash._id, date: '2026-06-20', allocations: [{ docType: 'Invoice', doc: inv._id, amount: 4000 }] });
    const ex = (await post('/accounts/expenses', { category: cat._id, description: 'Diesel', amount: 1500, date: '2026-06-21' })).body.expense;
    await post(`/accounts/expenses/${ex._id}/approve`, {});
    await post(`/accounts/expenses/${ex._id}/pay`, { account: cash._id, date: '2026-06-21' });
    const book = await get(`/accounts/reports/cashbook?account=${cash._id}&from=2026-06-01&to=2026-06-30`);
    expect(book.body.opening).toBe(0);
    expect(book.body.rows.map((r) => [r.voucherNo, r.inflow, r.outflow, r.balance])).toEqual([['RCT/2026-27/0001', 4000, 0, 4000], ['PAY/2026-27/0001', 0, 1500, 2500]]);
    expect(book.body.closing).toBe(2500);
    const day = await get('/accounts/reports/daybook?date=2026-06-21');
    expect(day.body.totals).toMatchObject({ paid: 1500, expenses: 1500 });
    const byCat = await get('/accounts/reports/expenses?from=2026-06-01&to=2026-06-30');
    expect(byCat.body.rows).toEqual([expect.objectContaining({ categoryName: 'Electricity', amount: 1500, count: 1 })]);
  });

  it('the ledger can be rebuilt from the documents', async () => {
    const { customer, inv } = await customerScene();
    const cash = await cashBox();
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 500, mode: 'cash', account: cash._id, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 500 }] });
    await M.PartyLedgerEntry.deleteMany({});
    const res = await post('/accounts/ledger/rebuild', {});
    expect(res.body.rows).toBe(2);
    expect((await get(`/accounts/statement?partyType=customer&party=${customer._id}`)).body.closing).toBe(10000);
  });
});

// ── Holes the audit closed ────────────────────────────────────────
describe('audit: what a voucher may settle, and who a message may go to', () => {
  it('money in from someone not on file settles nothing; a payment to them can pay an expense', async () => {
    const cat = await category('Office & stationery'); // approval above 2,000
    const cash = await cashBox();
    const ex = (await post('/accounts/expenses', { category: cat._id, description: 'Dyeing lot 9', payeeName: 'Colour Works', amount: 1000 })).body.expense;
    expect(ex.status).toBe('approved');
    // A receipt "from" the dyer cannot mark their expense paid.
    const wrong = await post('/accounts/payments', { kind: 'receipt', partyType: 'other', partyName: 'Colour Works', amount: 1000, mode: 'cash', account: cash._id, allocations: [{ docType: 'Expense', doc: ex._id, amount: 1000 }] });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/cannot settle a Expense/);
    expect((await M.Expense.findById(ex._id).lean()).paidAmount).toBe(0);
    // Interest from the bank: a receipt from an other party with nothing to settle.
    expect((await post('/accounts/payments', { kind: 'receipt', partyType: 'other', partyName: 'Kotak interest', amount: 120, mode: 'bank', account: cash._id })).status).toBe(201);
    const right = await post('/accounts/payments', { kind: 'payment', partyType: 'other', partyName: 'Colour Works', amount: 1000, mode: 'cash', account: cash._id, allocations: [{ docType: 'Expense', doc: ex._id, amount: 1000 }] });
    expect(right.status).toBe(201);
    expect((await M.Expense.findById(ex._id).lean()).paidAmount).toBe(1000);
    expect((await post(`/accounts/expenses/${ex._id}/pay`, { account: cash._id, mode: 'wire' })).status).toBe(409); // paid already; a bad mode on an open one is 400
  });

  it('a discount settles the documents ticked — it never becomes money the party has on account', async () => {
    const { customer, inv } = await customerScene(); // 10,500
    const bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 0 })).body.account;
    // 10,000 received, 500 discount, but only 10,000 ticked: the 500 would be left "on account".
    const loose = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10000, mode: 'bank', account: bank._id, adjustments: [{ kind: 'discount', amount: 500 }], allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10000 }] });
    expect(loose.status).toBe(400);
    expect(loose.body.message).toMatch(/Adjustments settle documents/);
    // 10,000 received, 500 discount, the whole invoice ticked: settled, nothing on account.
    const res = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10000, mode: 'bank', account: bank._id, adjustments: [{ kind: 'discount', amount: 500 }], allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ amount: 10000, unallocated: 0, adjustments: [expect.objectContaining({ kind: 'discount', amount: 500 })] });
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(10500);
    expect((await get(`/accounts/credits?partyType=customer&party=${customer._id}`)).body.credits).toEqual([]);
    expect((await get(`/accounts/statement?partyType=customer&party=${customer._id}`)).body.closing).toBe(0);
  });

  it('a payment on a bill carrying TDS, with no rate on the voucher, records the bill\'s section and rate', async () => {
    const s = await supplierScene();
    const cash = await cashBox();
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'JW/11', kind: 'service', lines: [{ description: 'Job work', quantity: 1, rate: 50000, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 2 } })).body.bill;
    const res = await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s.supplier._id, amount: 51500, mode: 'bank', account: cash._id, allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 52500 }], date: '2026-07-20' });
    expect(res.status).toBe(201);
    expect(res.body.payment.tds).toMatchObject({ section: '194C', rate: 2, amount: 1000, base: 50000 });
    expect((await get('/accounts/reports/tds?from=2026-07-01&to=2026-07-31')).body.rows).toEqual([expect.objectContaining({ section: '194C', tds: 1000 })]);
  });

  it('a bill with a debit note on it, and an invoice with a receipt on it, cannot be cancelled', async () => {
    const s = await supplierScene();
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'DN/1', lines: [{ description: 'Yarn', quantity: 10, rate: 100, gstPercent: 5 }] })).body.bill;
    expect((await post('/accounts/notes', { kind: 'debit', against: { doc: bill._id }, reason: 'Short weight', lines: [{ description: 'Short 2 kg', quantity: 2, rate: 100, gstPercent: 5 }] })).status).toBe(201);
    const cancel = await post(`/accounts/bills/${bill._id}/cancel`, { reason: 'Entered twice by mistake' });
    expect(cancel.status).toBe(409);
    expect((await M.SupplierBill.findById(bill._id).lean()).status).toBe('open');
  });

  it('an attachment is what it says it is, or it is refused', async () => {
    const s = await supplierScene();
    const bill = (await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'AT/1', lines: [{ description: 'Yarn', quantity: 1, rate: 100 }] })).body.bill;
    const html = await request(app).post(`/api/v2/accounts/bills/${bill._id}/attachments`).set('Cookie', cookie()).attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'bill.png', contentType: 'image/png' });
    expect(html.status).toBe(400);
    expect(html.body.message).toMatch(/not the kind it says it is/);
    const png = await request(app).post(`/api/v2/accounts/bills/${bill._id}/attachments`).set('Cookie', cookie()).attach('file', Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'), { filename: 'bill.png', contentType: 'image/png' });
    expect(png.status).toBe(201);
    const pdf = await request(app).post(`/api/v2/accounts/bills/${bill._id}/attachments`).set('Cookie', cookie()).attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'bill.pdf', contentType: 'application/pdf' });
    expect(pdf.status).toBe(201);
    expect((await M.SupplierBill.findById(bill._id).lean()).attachments).toHaveLength(2);
  });

  it('a WhatsApp reminder goes only to a number on a customer or supplier on file', async () => {
    const { customer } = await customerScene();
    const sent = await post('/accounts/collections/send', { to: '+91 7000000000', message: 'Please pay what is overdue on your account with us.' });
    expect(sent.status).toBe(400);
    expect(sent.body.message).toMatch(/not on any customer or supplier on file/);
    const ok = await post('/accounts/collections/send', { customer: customer._id, to: `+91 ${customer.phoneNumber}`, message: 'Please pay what is overdue on your account with us.' });
    expect(ok.status).toBe(200);
  });
});
