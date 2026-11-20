'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE GST SUMMARY: A DEBIT NOTE TO A CUSTOMER IS OUTPUT TAX
//
//  Found reading services/gstSummary.js line by line, beside
//  services/registers.js and services/gstr1.js.
//
//  A debit note here is one of two things: raised on a SUPPLIER (goods
//  sent back, a price cut: our input credit comes down), or raised on a
//  CUSTOMER (interest on a late payment, a price increase: more output
//  tax). The GST summary took every debit note as the first kind. So a
//  debit note to a customer was taken off input credit, and never added
//  to output tax.
//
//  The net payable came out the same — which is why nobody saw it — but
//  the two halves were both wrong by the note's tax: the output tax of
//  the month was less than GSTR-1 (built from the same notes, in table
//  9B) says it is, and the credit less than the purchase register's. A
//  3B filled from this page disagrees with the GSTR-1 filed beside it.
//
//  And a financial credit note — issued after the time limit, no GST —
//  was counted among the credit notes, lowering the taxable value at 0%.
//  GSTR-1 leaves it out; so does this.
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
const ok = (r, status = 201) => { if (r.status !== status) throw new Error(`${r.status} ${r.body?.message}`); return r.body; };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'AccountNote']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'gsts@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806', stateCode: '33' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
async function invoice(date = '2026-10-05') {
  n += 1;
  const customer = await M.Customer.create({ name: `Customer ${n}`, contactName: 'R', phoneNumber: `9300001${String(n).padStart(3, '0')}`, gstin: `33AAEPC${String(n).padStart(4, '0')}F1Z2`, paymentTerms: '30' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(date), dueDate: new Date('2026-11-04'),
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 10000, rate: 10, taxable: 100000, gstPercent: 5, cgst: 2500, sgst: 2500, igst: 0, amount: 105000 }],
    totals: { taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, tax: 5000, roundOff: 0, grand: 105000 }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 105000, narration: 'Sales' });
  return inv;
}
const supplierBill = async () => {
  n += 1;
  const s = await M.Supplier.create({ name: `Supplier ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode' });
  return ok(await post('/accounts/bills', { supplier: s._id, supplierBillNo: `S/${n}`, kind: 'goods', billDate: '2026-10-08', lines: [{ description: 'Rubber thread', quantity: 100, rate: 400, gstPercent: 5 }] })).bill;
};
const note = (body) => post('/accounts/notes', { date: '2026-10-20', ...body }).then((r) => ok(r).note);
const report = async () => (await get('/accounts/reports/gst?from=2026-10-01&to=2026-10-31')).body;

describe('the GST summary of a month', () => {
  it('a debit note to a customer raises output tax; it is not taken off input credit', async () => {
    const inv = await invoice();
    const bill = await supplierBill();   // 40,000 + 2,000 credit
    // Interest charged to the customer: 2,000 + 5% = 100 of output tax.
    await note({ kind: 'debit', partyType: 'customer', against: { doc: inv._id }, reason: 'Interest on late payment', lines: [{ description: 'Interest', quantity: 1, rate: 2000, gstPercent: 5 }] });
    // Goods sent back to the supplier: 4,000 + 5% = 200 of credit given up.
    await note({ kind: 'debit', partyType: 'supplier', against: { doc: bill._id }, reason: 'Goods returned', lines: [{ description: 'Rubber thread returned', quantity: 10, rate: 400, gstPercent: 5 }] });

    const r = await report();
    // Output: 5,000 on the invoice + 100 on the customer's debit note.
    expect(r.output.debitNotes).toEqual([expect.objectContaining({ rate: 5, taxable: 2000, cgst: 50, sgst: 50, tax: 100 })]);
    expect(r.totals.customerDebitNotes).toMatchObject({ taxable: 2000, tax: 100 });
    // Before: 2,500 / 2,500 — the note's tax was missing from output.
    expect(r.totals.netOutput).toEqual({ cgst: 2550, sgst: 2550, igst: 0 });
    // Input: 2,000 on the bill less 200 on the supplier's debit note.
    expect(r.input.debitNotes).toEqual([expect.objectContaining({ rate: 5, taxable: 4000, tax: 200 })]);
    expect(r.totals.debitNotes).toMatchObject({ taxable: 4000, tax: 200 });
    // Before: 850 / 850 — the customer's note had been taken off the credit too.
    expect(r.totals.netInput).toEqual({ cgst: 900, sgst: 900, igst: 0 });
    // The net was right before and is the same now.
    expect(r.totals.payable).toEqual({ cgst: 1650, sgst: 1650, igst: 0 });
    expect(r.counts).toMatchObject({ invoices: 1, bills: 1, debitNotes: 1, customerDebitNotes: 1 });
  });

  it('agrees with GSTR-1 and the sales register on the month\'s output tax', async () => {
    const inv = await invoice();
    await note({ kind: 'debit', partyType: 'customer', against: { doc: inv._id }, reason: 'Price difference', lines: [{ description: 'Rate difference', quantity: 1, rate: 1000, gstPercent: 5 }] });
    await note({ kind: 'credit', against: { doc: inv._id }, reason: 'Short supply', lines: [{ description: '20mm short', quantity: 100, rate: 10, gstPercent: 5 }] });
    const r = await report();
    const out = r.totals.netOutput;
    const sales = (await get('/accounts/registers/sales?from=2026-10-01&to=2026-10-31')).body;
    // 5,000 + 50 − 50.
    expect(out.cgst + out.sgst + out.igst).toBe(5000);
    expect(sales.totals.tax).toBe(5000);
  });

  it('a financial credit note moves no GST and is not among the credit notes', async () => {
    const inv = await invoice();
    await note({ kind: 'credit', against: { doc: inv._id }, reason: 'Commercial settlement', financial: true, lines: [{ description: 'Settlement', quantity: 1, rate: 5000, gstPercent: 5 }] });
    const r = await report();
    // Before: one credit note, 5,000 of taxable value at 0%.
    expect(r.output.creditNotes).toEqual([]);
    expect(r.counts.creditNotes).toBe(0);
    expect(r.totals.creditNotes).toMatchObject({ taxable: 0, tax: 0 });
    expect(r.totals.netOutput).toEqual({ cgst: 2500, sgst: 2500, igst: 0 });
  });

  it('with no notes at all it is as it was', async () => {
    await invoice();
    await supplierBill();
    const r = await report();
    expect(r.output.debitNotes).toEqual([]);
    expect(r.totals.netOutput).toEqual({ cgst: 2500, sgst: 2500, igst: 0 });
    expect(r.totals.netInput).toEqual({ cgst: 1000, sgst: 1000, igst: 0 });
    expect(r.totals.payable).toEqual({ cgst: 1500, sgst: 1500, igst: 0 });
  });
});
