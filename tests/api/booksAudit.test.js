'use strict';
// ══════════════════════════════════════════════════════════════════
//  DO THE BOOKS AGREE WITH THEMSELVES?
//
//  A month as the office would key it, from opening balances on:
//  invoices in and out of state, bills with TDS, a service bill and an
//  expense, a credit and a debit note, receipts with bank charges and an
//  amount left on account, a payment with TDS, an opening advance set
//  off, a contra, a cancellation, a journal, two receipts racing for the
//  same invoice, and the lock.
//
//  After every phase the same reconciliation runs:
//    · each party's ledger closing = its open documents − its credits
//    · the books-health checks find nothing
//    · bank and cash balances are the movements, nothing else
//  and at the end the ledger is rebuilt from the documents (nothing may
//  move), the GST figures are what the documents say, and a full Tally
//  export balances to the paisa and agrees with the ledger, party by
//  party.
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
const ok = async (p, status = 201) => { const r = await p; if (r.status !== status) throw new Error(`${r.request.method} ${r.request.url} → ${r.status} ${r.body.message}`); return r.body; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Elastic', 'Order', 'DeliveryChallan', 'Invoice', 'SupplierBill', 'Expense', 'ExpenseCategory', 'Payment', 'BankAccount', 'Journal', 'OpeningBalance', 'PartyLedgerEntry']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'audit@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road'], invoice: { city: 'Erode', pincode: '638052', defaultHsn: '5806', defaultGstPercent: 5, stateCode: '33' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

// ── The reconciliation every phase runs ───────────────────────────
const partyStatement = () => require('../../services/partyStatement');
const outstanding = () => require('../../services/outstanding');
const credits = () => require('../../services/credits');
const health = () => require('../../services/booksHealth');

async function closingOf(partyType, id) { return (await partyStatement().ledgerAccount(partyType, id, {})).closing; }
async function openOf(partyType, id) {
  const rows = partyType === 'customer' ? await outstanding().receivables({ customer: id }) : await outstanding().payables({ supplier: id });
  return r2(rows.reduce((s, r) => s + r.outstanding, 0));
}
async function creditOf(partyType, id) { return r2((await credits().openFor(partyType, id)).reduce((s, c) => s + c.available, 0)); }

/** Every party: ledger closing = open documents − credits on account. */
async function reconcileParties(parties) {
  const out = {};
  for (const [name, { type, id }] of Object.entries(parties)) {
    const [closing, open, credit] = await Promise.all([closingOf(type, id), openOf(type, id), creditOf(type, id)]);
    out[name] = { closing, open, credit };
    expect({ party: name, closing }).toEqual({ party: name, closing: r2(open - credit) });
  }
  return out;
}
async function healthClean() {
  const h = await health().check();
  const dirty = h.checks.filter((c) => !c.ok).map((c) => ({ key: c.key, count: c.count, rows: c.rows.slice(0, 3) }));
  expect(dirty).toEqual([]);
}
async function bankBalances() {
  const accounts = await M.BankAccount.find({}).lean();
  const withB = await require('../../services/bankBalances').withBalances(accounts);
  return Object.fromEntries(withB.map((a) => [a.kind === 'cash' ? 'cash' : a.name, r2(a.balance)]));
}

/** An invoice through the real route: an elastic, an order, a despatched challan. */
let seq = 0;
async function invoiceFor(customer, { metres, rate, date }) {
  seq += 1;
  const el = await M.Elastic.create({ name: `Elastic ${seq}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4, stock: 9000, hsn: '5806', gstPercent: 5 });
  const order = await M.Order.create({ customer: customer._id, po: `PO-${seq}`, date: new Date(date), supplyDate: new Date(date), status: 'InProgress', elasticOrdered: [{ elastic: el._id, quantity: metres, rate }] });
  const dc = await M.DeliveryChallan.create({ dcNumber: `E-26/27-${String(seq).padStart(4, '0')}`, type: 'elastic', financialYear: '26/27', sequence: seq, order: order._id, orderNo: order.orderNo, customerName: customer.name, status: 'dispatched', dispatchDate: new Date(date), items: [{ elastic: el._id, elasticName: el.name, unit: 'm', quantity: metres, rate: 0 }], totalQuantity: metres });
  return (await ok(post('/invoice/create', { orderId: order._id, dcIds: [dc._id], invoiceDate: date }))).invoice;
}

describe('a month of entries, reconciled after every step', () => {
  const S = {};   // what the scenario holds
  const parties = {};

  it('starts from opening balances and bank balances', async () => {
    S.A = await M.Customer.create({ name: 'Sunrise Garments', contactName: 'R', phoneNumber: '9200000001', gstin: '33AAEPS1001F1Z2', address: '4 Kongu Nagar', city: 'Tiruppur', pincode: '641604', stateCode: '33', paymentTerms: '30' });
    S.B = await M.Customer.create({ name: 'Bengaluru Knits', contactName: 'K', phoneNumber: '9200000002', gstin: '29AAEPB2002F1Z7', address: '9 MG Road', city: 'Bengaluru', pincode: '560001', stateCode: '29', paymentTerms: '45' });
    S.C = await M.Customer.create({ name: 'Chennai Trims', contactName: 'C', phoneNumber: '9200000003', gstin: '33AAEPC3003F1Z5', address: '1 Mount Road', city: 'Chennai', pincode: '600002', stateCode: '33', paymentTerms: '30' });
    S.S1 = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS4004F1Z5', address: 'Erode' });
    S.S2 = await M.Supplier.create({ name: 'Erode Dyers', gstin: '33AAAPS5005F1Z5', address: 'Erode' });
    Object.assign(parties, { A: { type: 'customer', id: S.A._id }, B: { type: 'customer', id: S.B._id }, C: { type: 'customer', id: S.C._id }, S1: { type: 'supplier', id: S.S1._id }, S2: { type: 'supplier', id: S.S2._id } });

    await get('/accounts/bank-accounts');   // seeds the cash box
    S.bank = (await ok(post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 500000, openingDate: '2026-03-31', isDefault: true, tallyLedger: 'Kotak Bank CA' }))).account;
    S.cash = (await get('/accounts/bank-accounts')).body.accounts.find((a) => a.kind === 'cash');
    await get('/accounts/categories');
    S.dyeing = await M.ExpenseCategory.create({ name: 'Dyeing charges', ledger: 'Dyeing Charges', itcEligible: true, approvalAbove: 1e9 });

    S.obA = (await ok(post('/accounts/opening-balances', { partyType: 'customer', party: S.A._id, kind: 'due', refNo: 'TALLY/882', date: '2026-03-31', amount: 48500 }))).row;
    S.obC = (await ok(post('/accounts/opening-balances', { partyType: 'customer', party: S.C._id, kind: 'advance', date: '2026-03-31', amount: 10000 }))).row;
    S.obS1 = (await ok(post('/accounts/opening-balances', { partyType: 'supplier', party: S.S1._id, kind: 'due', refNo: 'SY/1099', date: '2026-03-31', amount: 30000 }))).row;
    S.obS2 = (await ok(post('/accounts/opening-balances', { partyType: 'supplier', party: S.S2._id, kind: 'advance', date: '2026-03-31', amount: 8000 }))).row;

    const r = await reconcileParties(parties);
    expect(r).toMatchObject({ A: { closing: 48500 }, C: { closing: -10000, credit: 10000 }, S1: { closing: 30000 }, S2: { closing: -8000, credit: 8000 } });
    await healthClean();
    expect(await bankBalances()).toEqual({ 'Kotak CA': 500000, cash: 0 });
  });

  it('raises invoices and bills, issues notes', async () => {
    S.invA = await invoiceFor(S.A, { metres: 1000, rate: 10, date: '2026-07-02' });   // 10,500 in-state
    S.invB = await invoiceFor(S.B, { metres: 2000, rate: 10, date: '2026-07-03' });   // 21,000 IGST
    expect(S.invA.totals).toMatchObject({ cgst: 250, sgst: 250, igst: 0, grand: 10500 });
    expect(S.invB.totals).toMatchObject({ cgst: 0, sgst: 0, igst: 1000, grand: 21000 });
    S.billS1 = (await ok(post('/accounts/bills', { supplier: S.S1._id, supplierBillNo: 'SY/1182', billDate: '2026-07-04', lines: [{ description: 'Nylon 70D', hsn: '5402', unit: 'kg', quantity: 100, rate: 300, gstPercent: 5 }], tds: { applicable: true, section: '194C', rate: 1 } }))).bill;   // 31,500
    S.billS2 = (await ok(post('/accounts/bills', { supplier: S.S2._id, supplierBillNo: 'ED/77', billDate: '2026-07-05', kind: 'service', category: S.dyeing._id, lines: [{ description: 'Dyeing 500 m', quantity: 1, rate: 10000, gstPercent: 18 }] }))).bill;   // 11,800
    S.expS2 = (await ok(post('/accounts/expenses', { category: S.dyeing._id, description: 'Sample dyeing', supplier: S.S2._id, amount: 2000, gstPercent: 18, date: '2026-07-06' }))).expense;   // 2,360, approved
    expect(S.expS2.status).toBe('approved');
    S.cnA = (await ok(post('/accounts/notes', { kind: 'credit', against: { doc: S.invA._id }, reason: 'Rate difference agreed', date: '2026-07-07', lines: [{ description: 'Rate difference', quantity: 1, rate: 1000, gstPercent: 5 }] }))).note;   // 1,050
    S.dnS1 = (await ok(post('/accounts/notes', { kind: 'debit', against: { doc: S.billS1._id }, reason: 'Short supply 6.67 kg', date: '2026-07-08', lines: [{ description: 'Short supply', quantity: 1, rate: 2000, gstPercent: 5 }] }))).note;   // 2,100

    const r = await reconcileParties(parties);
    expect(r).toMatchObject({ A: { closing: 48500 + 10500 - 1050, open: 48500 + 9450 }, B: { closing: 21000 }, S1: { closing: 30000 + 31500 - 2100 }, S2: { closing: 11800 + 2360 - 8000, open: 11800 + 2360, credit: 8000 } });
    await healthClean();
  });

  it('settles with receipts and payments: bank charges, an amount on account, TDS, an opening advance applied', async () => {
    // A clears the opening due and the invoice net of the credit note; the bank kept ₹50.
    S.rctA = (await ok(post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: S.A._id, amount: 57900, mode: 'bank', account: S.bank._id, date: '2026-07-10', reference: 'UTR1',
      adjustments: [{ kind: 'bank_charges', amount: 50 }], allocations: [{ docType: 'OpeningBalance', doc: S.obA._id, amount: 48500 }, { docType: 'Invoice', doc: S.invA._id, amount: 9450 }] }))).payment;
    expect(S.rctA.unallocated).toBe(0);
    // B pays 15,000, then 10,000 of which 4,000 has nothing to go against.
    S.rctB1 = (await ok(post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: S.B._id, amount: 15000, mode: 'bank', account: S.bank._id, date: '2026-07-11', allocations: [{ docType: 'Invoice', doc: S.invB._id, amount: 15000 }] }))).payment;
    S.rctB2 = (await ok(post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: S.B._id, amount: 10000, mode: 'bank', account: S.bank._id, date: '2026-07-12', allocations: [{ docType: 'Invoice', doc: S.invB._id, amount: 6000 }] }))).payment;
    expect(S.rctB2.unallocated).toBe(4000);
    // S1: the bill net of the debit note (TDS 1% on its value net of GST) and the opening due.
    S.payS1 = (await ok(post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: S.S1._id, amount: 59120, mode: 'bank', account: S.bank._id, date: '2026-07-13',
      allocations: [{ docType: 'SupplierBill', doc: S.billS1._id, amount: 29400 }, { docType: 'OpeningBalance', doc: S.obS1._id, amount: 30000 }] }))).payment;
    expect(S.payS1.tds).toMatchObject({ amount: 280, base: 28000 });
    // S2: the opening advance set against the bill, then the rest and the expense paid.
    const applied = await ok(post('/accounts/credits/apply', { source: { type: 'OpeningBalance', id: S.obS2._id }, allocations: [{ docType: 'SupplierBill', doc: S.billS2._id, amount: 8000 }] }), 200);
    expect(applied.applied).toBe(8000);
    S.payS2 = (await ok(post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: S.S2._id, amount: 6160, mode: 'bank', account: S.bank._id, date: '2026-07-14',
      allocations: [{ docType: 'SupplierBill', doc: S.billS2._id, amount: 3800 }, { docType: 'Expense', doc: S.expS2._id, amount: 2360 }] }))).payment;
    await ok(post('/accounts/contras', { from: S.bank._id, to: S.cash._id, amount: 5000, date: '2026-07-15', narration: 'Cash for wages' }));

    const r = await reconcileParties(parties);
    expect(r).toMatchObject({ A: { closing: 0, open: 0, credit: 0 }, B: { closing: -4000, open: 0, credit: 4000 }, C: { closing: -10000 }, S1: { closing: 0, open: 0 }, S2: { closing: 0, open: 0, credit: 0 } });
    expect((await M.SupplierBill.findById(S.billS1._id).lean())).toMatchObject({ status: 'paid', paidAmount: 29120, tdsAmount: 280, debitedAmount: 2100 });
    expect((await M.Expense.findById(S.expS2._id).lean()).status).toBe('paid');
    await healthClean();
    expect(await bankBalances()).toEqual({ 'Kotak CA': r2(500000 + 57900 + 15000 + 10000 - 59120 - 6160 - 5000), cash: 5000 });
  });

  it('a cancelled receipt puts everything back; a replayed one posts once; two racing for the same invoice settle it once', async () => {
    await ok(post(`/accounts/payments/${S.rctB2._id}/cancel`, { reason: 'Entered against the wrong customer' }), 200);
    let r = await reconcileParties(parties);
    expect(r.B).toEqual({ closing: 6000, open: 6000, credit: 0 });
    expect((await M.Invoice.findById(S.invB._id).lean()).paidAmount).toBe(15000);

    const body = { kind: 'receipt', partyType: 'customer', customer: S.B._id, amount: 6000, mode: 'bank', account: S.bank._id, date: '2026-07-16', allocations: [{ docType: 'Invoice', doc: S.invB._id, amount: 6000 }] };
    // Two sittings racing for the same 6,000: exactly one settles it.
    const [x, y] = await Promise.all([post('/accounts/payments', { ...body, reference: 'clerk-1' }), post('/accounts/payments', { ...body, reference: 'clerk-2' })]);
    // The loser is refused at validation (400) or, having passed it a moment earlier, by the conditional settlement (409).
    expect([x.status, y.status].sort()[0]).toBe(201);
    expect([x.status, y.status].sort()[1]).toBeGreaterThanOrEqual(400);
    const posted = await M.Payment.find({ customer: S.B._id, status: 'posted', date: new Date('2026-07-16T00:00:00Z') }).lean();
    expect(posted).toHaveLength(1);
    expect((await M.Invoice.findById(S.invB._id).lean()).paidAmount).toBe(21000);
    // A retried request (same requestId) posts once and hands back the same voucher.
    const once = { kind: 'receipt', partyType: 'customer', customer: S.C._id, amount: 100, mode: 'cash', account: S.cash._id, date: '2026-07-17', allocations: [], requestId: 'rct-c-100' };
    const first = await post('/accounts/payments', once);
    const again = await post('/accounts/payments', once);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.replay).toBe(true);
    expect(again.body.payment.voucherNo).toBe(first.body.payment.voucherNo);
    expect(await M.Payment.countDocuments({ requestId: 'rct-c-100' })).toBe(1);
    await ok(post(`/accounts/payments/${first.body.payment._id}/cancel`, { reason: 'Replay test entry, not money' }), 200);
    r = await reconcileParties(parties);
    expect(r.B).toEqual({ closing: 0, open: 0, credit: 0 });
    await healthClean();
    expect(await bankBalances()).toEqual({ 'Kotak CA': r2(500000 + 57900 + 15000 + 6000 - 59120 - 6160 - 5000), cash: 5000 });
  });

  it('closes the books: no entry or cancellation inside the period without an admin reason', async () => {
    await ok(post('/accounts/lock', { lockDate: '2026-07-31' }), 200);
    const late = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: S.C._id, amount: 100, mode: 'cash', account: S.cash._id, date: '2026-07-20' });
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/closed up to/);
    expect((await post(`/accounts/payments/${S.rctB1._id}/cancel`, { reason: 'Trying to undo a closed month' })).status).toBe(409);
    expect((await post('/accounts/bills', { supplier: S.S1._id, supplierBillNo: 'SY/late', billDate: '2026-07-30', lines: [{ description: 'x', quantity: 1, rate: 100, gstPercent: 5 }] })).status).toBe(409);
    // August is open; an admin with a reason can still reach into July.
    const aug = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: S.C._id, amount: 100, mode: 'cash', account: S.cash._id, date: '2026-08-01' });
    expect(aug.status).toBe(201);
    await ok(post(`/accounts/payments/${aug.body.payment._id}/cancel`, { reason: 'Test entry, not real money' }), 200);
    const forced = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: S.C._id, amount: 100, mode: 'cash', account: S.cash._id, date: '2026-07-20', lockOverride: 'Missed receipt found in the drawer' });
    expect(forced.status).toBe(201);
    await ok(post(`/accounts/payments/${forced.body.payment._id}/cancel`, { reason: 'Undo the override test entry', lockOverride: 'Undo the override test entry' }), 200);
    await ok(post('/accounts/lock', { lockDate: null, reason: 'Reopen for the audit scenario' }), 200);
    await reconcileParties(parties);
    await healthClean();
  });

  it('the GST figures are the documents, and the ledger rebuilt from the documents moves nothing', async () => {
    const gst = (await get('/accounts/reports/gst?from=2026-07-01&to=2026-07-31')).body;
    expect(gst.totals.output).toMatchObject({ cgst: 250, sgst: 250, igst: 1000 });
    expect(gst.totals.creditNotes).toMatchObject({ cgst: 25, sgst: 25 });
    expect(gst.totals.netOutput).toEqual({ cgst: 225, sgst: 225, igst: 1000 });
    // Bills 750+750 and 900+900, the expense 180+180, less the debit note 50+50.
    expect(gst.totals.netInput).toEqual({ cgst: 1780, sgst: 1780, igst: 0 });

    const before = {};
    for (const [k, p] of Object.entries(parties)) before[k] = await closingOf(p.type, p.id);
    const rowsBefore = await M.PartyLedgerEntry.countDocuments({});
    await ok(post('/accounts/ledger/rebuild', {}), 200);
    for (const [k, p] of Object.entries(parties)) expect({ party: k, closing: await closingOf(p.type, p.id) }).toEqual({ party: k, closing: before[k] });
    expect(await M.PartyLedgerEntry.countDocuments({})).toBe(rowsBefore);
    await healthClean();
  });

  it('a journal may only settle a party\'s documents, in full — raising a party or leaving it on account is refused', async () => {
    S.invC = await invoiceFor(S.C, { metres: 1000, rate: 10, date: '2026-07-21' });   // 10,500
    const raise = await post('/accounts/journals', { date: '2026-07-22', purpose: 'reclass', reason: 'Freight recovered from Chennai Trims', lines: [
      { kind: 'party', partyType: 'customer', party: S.C._id, debit: 500 }, { kind: 'ledger', ledger: 'Freight Outward', credit: 500 }] });
    expect(raise.status).toBe(400);
    expect(raise.body.message).toMatch(/cannot raise what Chennai Trims owes — issue a debit note/);
    const onAccount = await post('/accounts/journals', { date: '2026-07-22', purpose: 'writeoff', reason: 'Rate difference waived', lines: [
      { kind: 'ledger', ledger: 'Discount Allowed', debit: 500 }, { kind: 'party', partyType: 'customer', party: S.C._id, credit: 500 }] });
    expect(onAccount.status).toBe(400);
    expect(onAccount.body.message).toMatch(/set the whole 500.00 against Chennai Trims's open documents/);
    const j = await ok(post('/accounts/journals', { date: '2026-07-22', purpose: 'writeoff', reason: 'Rate difference waived', lines: [
      { kind: 'ledger', ledger: 'Discount Allowed', debit: 500 }, { kind: 'party', partyType: 'customer', party: S.C._id, credit: 500, refs: [{ docType: 'Invoice', doc: S.invC._id, amount: 500 }] }] }));
    S.journal = j.journal;
    const r = await reconcileParties(parties);
    expect(r.C).toEqual({ closing: 0, open: 10000, credit: 10000 });
    expect((await M.Invoice.findById(S.invC._id).lean()).creditedAmount).toBe(500);
    await healthClean();
  });

  it('a full Tally export balances every voucher and agrees with the ledger, party by party', async () => {
    const preview = (await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body;
    expect(preview.problems).toEqual([]);
    const ex = await ok(post('/accounts/tally/export', { from: '2026-07-01', to: '2026-07-31', masters: true }));
    const xml = (await request(app).get(`/api/v2/accounts/tally/batches/${ex.batch._id}/xml`).set('Cookie', cookie())).text;
    const vouchers = [...xml.matchAll(/<VOUCHER VCHTYPE="([^"]+)"[\s\S]*?<\/VOUCHER>/g)].map((m) => ({
      type: m[1], number: m[0].match(/<VOUCHERNUMBER>([^<]+)</)[1],
      lines: [...m[0].matchAll(/<ALLLEDGERENTRIES.LIST><LEDGERNAME>([^<]+)<\/LEDGERNAME><ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>(?:Yes|No)<\/ISPARTYLEDGER><AMOUNT>([^<]+)<\/AMOUNT>/g)].map((l) => ({ ledger: l[1].replace(/&amp;/g, '&'), amount: Number(l[3]) })),
    }));
    // Cancelled vouchers never go; every voucher balances; the whole batch balances.
    expect(vouchers.map((v) => v.number)).not.toContain(S.rctB2.voucherNo);
    for (const v of vouchers) expect({ v: v.number, sum: r2(v.lines.reduce((t, l) => t + l.amount, 0)) }).toEqual({ v: v.number, sum: 0 });
    expect(r2(vouchers.flatMap((v) => v.lines).reduce((t, l) => t + l.amount, 0))).toBe(0);
    // Tally writes a debit as a negative amount: a party's movement is −Σ its lines (customer), +Σ (supplier).
    const netOf = (name) => r2(vouchers.flatMap((v) => v.lines).filter((l) => l.ledger === name).reduce((t, l) => t + l.amount, 0));
    for (const [k, p] of Object.entries(parties)) {
      const name = S[k].name;
      // The ledger's July movement, leaving out the opening balances Tally already holds.
      const rows = await M.PartyLedgerEntry.find({ partyType: p.type, party: p.id, docType: { $ne: 'OpeningBalance' }, date: { $gte: new Date('2026-07-01'), $lte: new Date('2026-07-31T23:59:59Z') } }).lean();
      const move = r2(rows.reduce((t, r) => t + (p.type === 'customer' ? r.debit - r.credit : r.credit - r.debit), 0));
      const inTally = (p.type === 'customer' ? -netOf(name) : netOf(name)) || 0;
      expect({ party: k, inTally }).toEqual({ party: k, inTally: move || 0 });
    }
    // Bank and cash in Tally move as they did here.
    expect(-netOf('Kotak Bank CA')).toBe(r2(57900 + 15000 + 6000 - 59120 - 6160 - 5000));
    expect(-netOf('Cash box')).toBe(5000);
    expect(xml).toMatch(new RegExp(`<NAME>${S.invC.invoiceNumber.replace(/\//g, '\\/')}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>500.00</AMOUNT>`));
    // The opening due A settled through its Tally reference, the TDS on S1, the charges the bank kept.
    expect(xml).toMatch(/<NAME>TALLY\/882<\/NAME><BILLTYPE>Agst Ref<\/BILLTYPE>/);
    expect(netOf('TDS Payable')).toBe(280);
    expect(-netOf('Bank Charges')).toBe(50);
    expect((await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body).toMatchObject({ vouchers: 0 });
    await healthClean();
  });
});
