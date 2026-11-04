'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PARTY LEDGER, AS TALLY PRINTS IT
//
//    • each row names the other side, To on the debit and By on the
//      credit, with Tally's voucher type and the ledger names the Tally
//      export uses
//    • the detailed view: the voucher's other ledgers (sales and each
//      tax; bank, TDS, bank charges) and bill by bill what it settled
//    • Current Total and the closing balance, each balance Dr or Cr
//    • the group summary for Sundry Debtors / Creditors
//    • Excel and PDF in the same columns
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const ExcelJS  = require('exceljs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const binary = (res, cb) => { const d = []; res.on('data', (c) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'BankAccount']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ledger@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road'], invoice: { defaultGstPercent: 5, city: 'Tiruppur', pincode: '641601' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let scene;
beforeAll(async () => {
  const customer = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'Ravi', gstin: '33AAEPS1001F1Z2', address: '4 Market St', city: 'Erode', pincode: '638001', phoneNumber: '9677707535' });
  const inv = await M.Invoice.create({
    invoiceNumber: 'INV/2026-27/0001', financialYear: '2026-27', sequence: 1, invoiceDate: new Date('2026-06-01'), dueDate: new Date('2026-07-01'),
    order: new mongoose.Types.ObjectId(), orderNo: 71, customer: customer._id, customerPo: 'SG/PO/88',
    seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road', city: 'Tiruppur', pincode: '641601', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, address: '4 Market St', city: 'Erode', pincode: '638001', stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
    totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand: 10500 }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 10500, narration: 'Sales' });
  await get('/accounts/bank-accounts');
  const bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', accountNo: '7612149219', tallyLedger: 'Kotak Mahindra Bank' })).body.account;
  // Credit note 525 against the invoice; receipt 10,000 + 50 bank charges, 9,975 settles the rest, 75 on account.
  const note = (await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference agreed', lines: [{ description: '20mm rate diff', quantity: 1000, rate: 0.5, gstPercent: 5 }], date: '2026-06-10' })).body.note;
  const receipt = (await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 10000, mode: 'bank', account: bank._id, reference: 'UTR123',
    adjustments: [{ kind: 'bank_charges', amount: 50 }], allocations: [{ docType: 'Invoice', doc: inv._id, amount: 9975 }], date: '2026-06-20' })).body.payment;

  const supplier = await M.Supplier.create({ name: 'Sri Dyers', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
  const bill = (await post('/accounts/bills', { supplier: supplier._id, supplierBillNo: 'SD/77', kind: 'service', lines: [{ description: 'Dyeing', quantity: 1, rate: 50000, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 2 }, billDate: '2026-06-05' })).body.bill;
  const pay = (await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: supplier._id, amount: 51500, mode: 'bank', account: bank._id, tds: { section: '194C', rate: 2 },
    allocations: [{ docType: 'SupplierBill', doc: bill._id, amount: 52500 }], date: '2026-06-25' })).body.payment;
  scene = { customer, inv, note, receipt, supplier, bill, pay };
});

describe("a customer's ledger account", () => {
  it('names the other side of each entry, To and By, with the voucher type', async () => {
    const { customer, inv, note, receipt } = scene;
    const st = (await get(`/accounts/statement?partyType=customer&party=${customer._id}&from=2026-04-01&to=2027-03-31`)).body;
    expect(st.rows.map((r) => [r.toBy, r.particulars, r.vchType, r.docNo])).toEqual([
      ['To', 'Sales', 'Sales', inv.invoiceNumber],
      ['By', 'Sales', 'Credit Note', note.noteNo],
      ['By', 'Kotak Mahindra Bank', 'Receipt', receipt.voucherNo],
    ]);
    expect(st.rows[0]).toMatchObject({ partyRef: 'PO SG/PO/88', balance: 10500, balanceSide: 'Dr' });
    expect(st.rows[2].partyRef).toBe('UTR123');
  });

  it('breaks each voucher down as Tally\'s detailed view does', async () => {
    const st = (await get(`/accounts/statement?partyType=customer&party=${scene.customer._id}`)).body;
    expect(st.rows[0].lines).toEqual([{ ledger: 'Sales', amount: 10000 }, { ledger: 'Output CGST', amount: 250 }, { ledger: 'Output SGST', amount: 250 }]);
    expect(st.rows[1].refs).toEqual([{ type: 'Agst Ref', name: scene.inv.invoiceNumber, amount: 525 }]);
    expect(st.rows[2].lines).toEqual([{ ledger: 'Kotak Mahindra Bank', amount: 10000 }, { ledger: 'Bank Charges', amount: 50 }]);
    expect(st.rows[2].refs).toEqual([{ type: 'Agst Ref', name: scene.inv.invoiceNumber, amount: 9975 }, { type: 'On Account', name: scene.receipt.voucherNo, amount: 75 }]);
  });

  it('totals the period and gives the closing balance its side', async () => {
    const st = (await get(`/accounts/statement?partyType=customer&party=${scene.customer._id}`)).body;
    expect(st.totals).toEqual({ debit: 10500, credit: 10575 });
    // Paid 75 more than owed: a credit balance on a customer.
    expect(st).toMatchObject({ closing: -75, closingSide: 'Cr', opening: 0, openingSide: '' });
    // From mid-June: the invoice is the opening, Dr.
    const later = (await get(`/accounts/statement?partyType=customer&party=${scene.customer._id}&from=2026-06-05`)).body;
    expect(later).toMatchObject({ opening: 10500, openingSide: 'Dr' });
    expect(later.rows).toHaveLength(2);
  });
});

describe("a supplier's ledger account", () => {
  it('shows the bill against the expense head, the supplier\'s invoice number, and the payment net of TDS', async () => {
    const { supplier, bill, pay } = scene;
    const st = (await get(`/accounts/statement?partyType=supplier&party=${supplier._id}`)).body;
    expect(st.rows.map((r) => [r.toBy, r.vchType, r.docNo, r.debit, r.credit, r.balanceSide])).toEqual([
      ['By', 'Purchase', bill.billNo, 0, 52500, 'Cr'],
      ['To', 'Payment', pay.voucherNo, 52500, 0, ''],
    ]);
    expect(st.rows[0].partyRef).toBe('Supplier inv. SD/77');
    expect(st.rows[0].lines).toEqual(expect.arrayContaining([{ ledger: 'Input CGST', amount: 1250 }, { ledger: 'Input SGST', amount: 1250 }]));
    expect(st.rows[1].lines).toEqual([{ ledger: 'Kotak Mahindra Bank', amount: 51500 }, { ledger: 'TDS Payable (194C)', amount: 1000 }]);
    expect(st.rows[1].refs).toEqual([{ type: 'Agst Ref', name: bill.billNo, amount: 52500 }]);
    expect(st).toMatchObject({ totals: { debit: 52500, credit: 52500 }, closing: 0, closingSide: '' });
  });
});

describe('the group summary', () => {
  it('lists Sundry Debtors with opening, debit, credit and closing, Dr or Cr', async () => {
    const g = (await get('/accounts/ledger/summary?partyType=customer&from=2026-06-05&to=2027-03-31')).body;
    expect(g.group).toBe('Sundry Debtors');
    expect(g.rows).toEqual([expect.objectContaining({ partyName: 'Sunrise Garments', opening: 10500, openingSide: 'Dr', debit: 0, credit: 10575, closing: -75, closingSide: 'Cr' })]);
    expect(g.totals).toMatchObject({ opening: 10500, credit: 10575, closing: -75, closingSide: 'Cr' });
    const s = (await get('/accounts/ledger/summary?partyType=supplier')).body;
    expect(s.group).toBe('Sundry Creditors');
    expect(s.rows[0]).toMatchObject({ partyName: 'Sri Dyers', debit: 52500, credit: 52500, closing: 0 });
    expect((await get('/accounts/ledger/summary?partyType=nobody')).status).toBe(400);
  });
});

describe('Excel and PDF', () => {
  it('writes the ledger to Excel in Tally\'s columns, with the breakup under each voucher', async () => {
    const res = await request(app).get(`/api/v2/accounts/statement/xlsx?partyType=customer&party=${scene.customer._id}`).set('Cookie', cookie()).buffer(true).parse(binary);
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const rows = [];
    wb.worksheets[0].eachRow((r) => rows.push(r.values.slice(1)));
    expect(rows.find((r) => r[0] === 'Date').slice(0, 9)).toEqual(['Date', 'Particulars', 'Vch Type', 'Vch No.', 'Reference', 'Detail', 'Debit', 'Credit', 'Balance']);
    const flat = rows.map((r) => r.join('|'));
    expect(flat.some((l) => /^01-06-2026\|To Sales\|Sales\|INV\/2026-27\/0001/.test(l))).toBe(true);
    expect(flat.some((l) => /Agst Ref INV\/2026-27\/0001\|*9975/.test(l.replace(/\|\|+/g, '|')))).toBe(true);
    expect(flat.some((l) => /^\|Current Total\|*10500\|10575/.test(l.replace(/\|\|+/g, '|')))).toBe(true);
    expect(flat.some((l) => /Closing Balance.*75\|Cr$/.test(l))).toBe(true);
    const g = await request(app).get('/api/v2/accounts/ledger/summary?partyType=supplier&format=xlsx').set('Cookie', cookie()).buffer(true).parse(binary);
    expect(g.headers['content-type']).toMatch(/spreadsheetml/);
  });

  it('prints the detailed ledger to PDF', async () => {
    const res = await request(app).get(`/api/v2/accounts/statement/pdf?partyType=supplier&party=${scene.supplier._id}&detailed=1`).set('Cookie', cookie()).buffer(true).parse(binary);
    const t = await pdfText(res.body);
    expect(t).toMatch(/LEDGER ACCOUNT/);
    expect(t).toMatch(/By Purchase|By Sundry Expenses|By [A-Za-z ]+/);
    expect(t).toMatch(/Supplier inv\. SD\/77/);
    expect(t).toMatch(/TDS Payable \(194C\)/);
    expect(t).toMatch(/Agst Ref PB\/2026-27\/0001/);
    expect(t).toMatch(/Current Total/);
  });
});
