'use strict';
// ══════════════════════════════════════════════════════════════════
//  MSME AT THE YEAR END: WHAT COUNTS AS A BILL, AND WHAT AS PAID
//
//  Found reading services/msme.js line by line, beside
//  services/overdueInterest.js (which asks the same question — what
//  settled this document, and when — and answers it in full).
//
//  1. A BILL SETTLED FROM AN OPENING ADVANCE WAS "UNPAID". The year-end
//     statement (s.43B(h)) and MSME Form I asked the payment vouchers
//     alone when a bill was paid. An advance brought over from Tally and
//     set against the bill is on no voucher's allocations, so the bill —
//     paid, and showing nothing outstanding — was listed as disallowed,
//     and went into Form I as overdue.
//
//  2. A SUPPLIER'S EXPENSE WAS NOT A BILL. Job work, a repair, transport
//     booked as an expense against a micro or small supplier is a sum
//     payable to them like any bill: it is on the list of dues (GET
//     /msme) and in the payment run. The year-end statement and Form I
//     read supplier bills only, so the same document was "due" on one
//     page and absent from the other two.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, category;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const ok = (r, ...statuses) => { if (!(statuses.length ? statuses : [200, 201]).includes(r.status)) throw new Error(`${r.status} ${r.body?.message}`); return r.body; };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Supplier', 'SupplierBill', 'Expense', 'OpeningBalance']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'msme2@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806', stateCode: '33' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { category = ok(await post('/accounts/categories', { name: 'Job work', approvalAbove: 10_00_000 })).category; });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
const supplier = async (over = {}) => { n += 1; return M.Supplier.create({ name: `Supplier ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode', msme: { category: 'micro' }, ...over }); };
const bill = async (s, body) => ok(await post('/accounts/bills', { supplier: s._id, supplierBillNo: `S/${++n}`, kind: 'service', lines: [{ description: 'Dyeing', quantity: 1, rate: 10000, gstPercent: 5 }], ...body })).bill;
const expense = async (s, body) => ok(await post('/accounts/expenses', { category: category._id, supplier: s._id, description: 'Covering job work', amount: 10000, gstPercent: 5, ...body })).expense;
const bank = async () => { await get('/accounts/bank-accounts'); return ok(await post('/accounts/bank-accounts', { name: `Bank ${++n}`, kind: 'bank' })).account; };
const yearEnd = async () => (await get('/accounts/msme/year-end?fy=2026-27')).body;
const formOne = async () => (await get('/accounts/msme/form1?asOf=2026-09-30')).body;

describe('a bill settled from an opening advance', () => {
  it('is paid at the year end, and is not in Form I', async () => {
    const micro = await supplier();
    const b = await bill(micro, { billDate: '2026-06-01' });   // 10,500, due 16 June
    const advance = ok(await post('/accounts/opening-balances', { partyType: 'supplier', party: micro._id, kind: 'advance', amount: 10500, date: '2026-04-01', refNo: 'ADV/1' })).row;
    ok(await post('/accounts/credits/apply', { source: { type: 'OpeningBalance', id: advance._id }, allocations: [{ docType: 'SupplierBill', doc: b._id, amount: 10500 }] }));
    expect((await M.SupplierBill.findById(b._id).lean())).toMatchObject({ status: 'paid', paidAmount: 10500 });

    const ye = await yearEnd();
    // Before: status 'disallowed', disallowed 10,500 — for a bill with nothing outstanding.
    expect(ye.rows.find((r) => r.docNo === b.billNo)).toMatchObject({ status: 'allowed', paidByDue: 10500, paidLate: 0, disallowed: 0 });
    expect(ye.totals).toMatchObject({ disallowed: 0, late: 0, allowed: 10500 });
    // Before: listed, ₹10,500 "payment pending".
    expect((await formOne()).rows).toEqual([]);
  });

  it('part from the advance and the rest unpaid: only the rest is disallowed', async () => {
    const micro = await supplier();
    const b = await bill(micro, { billDate: '2026-06-01' });
    const advance = ok(await post('/accounts/opening-balances', { partyType: 'supplier', party: micro._id, kind: 'advance', amount: 4000, date: '2026-04-01' })).row;
    ok(await post('/accounts/credits/apply', { source: { type: 'OpeningBalance', id: advance._id }, allocations: [{ docType: 'SupplierBill', doc: b._id, amount: 4000 }] }));
    const ye = await yearEnd();
    expect(ye.rows.find((r) => r.docNo === b.billNo)).toMatchObject({ status: 'disallowed', paidByDue: 4000, disallowed: 6500 });
    expect((await formOne()).rows).toEqual([expect.objectContaining({ docNo: b.billNo, amount: 6500 })]);
  });
});

describe('an expense owed to a micro or small supplier', () => {
  it('unpaid at the year end is disallowed like a bill, and is in Form I once past 45 days', async () => {
    const micro = await supplier();
    const e = await expense(micro, { date: '2026-06-01' });   // 10,500
    expect(e.status).toBe('approved');
    // It is on the list of dues already (unchanged)…
    expect((await get('/accounts/msme')).body.rows.map((r) => r.docNo)).toEqual([e.expenseNo]);
    // …and was on neither of these.
    const ye = await yearEnd();
    expect(ye.rows).toEqual([expect.objectContaining({ docType: 'Expense', docNo: e.expenseNo, status: 'disallowed', amount: 10500, disallowed: 10500 })]);
    expect(ye.totals).toMatchObject({ disallowed: 10500, count: 1, disallowedCount: 1 });
    expect((await formOne()).rows).toEqual([expect.objectContaining({ docNo: e.expenseNo, amount: 10500 })]);
  });

  it('paid in time is allowed; paid late is allowed, and late', async () => {
    const micro = await supplier();
    const acct = await bank();
    const inTime = await expense(micro, { date: '2026-06-01' });
    const late = await expense(micro, { date: '2026-06-01' });
    ok(await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: micro._id, amount: 10500, mode: 'bank', account: acct._id, date: '2026-06-10', allocations: [{ docType: 'Expense', doc: inTime._id, amount: 10500 }] }));
    ok(await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: micro._id, amount: 10500, mode: 'bank', account: acct._id, date: '2026-08-20', allocations: [{ docType: 'Expense', doc: late._id, amount: 10500 }] }));
    const byNo = Object.fromEntries((await yearEnd()).rows.map((r) => [r.docNo, r]));
    expect(byNo[inTime.expenseNo]).toMatchObject({ status: 'allowed', paidByDue: 10500 });
    expect(byNo[late.expenseNo]).toMatchObject({ status: 'late', paidLate: 10500 });
    expect((await formOne()).rows).toEqual([]);
  });

  it('a cancelled or rejected expense, or one to a supplier who is not micro or small, is not listed', async () => {
    const medium = await supplier({ msme: { category: 'medium' } });
    await expense(medium, { date: '2026-06-01' });
    const micro = await supplier();
    const gone = await expense(micro, { date: '2026-06-01' });
    await M.Expense.updateOne({ _id: gone._id }, { $set: { status: 'cancelled' } });
    expect((await yearEnd()).rows).toEqual([]);
    expect((await formOne()).rows).toEqual([]);
  });

  it('a bill is still a bill (unchanged)', async () => {
    const micro = await supplier();
    const b = await bill(micro, { billDate: '2026-07-01' });
    expect((await yearEnd()).rows).toEqual([expect.objectContaining({ docType: 'SupplierBill', docNo: b.billNo, status: 'disallowed', disallowed: 10500 })]);
  });
});
