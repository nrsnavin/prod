'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHERE THE BOOKS AND TALLY USED TO DRIFT — PINNED
//
//    • party ledgers are the master's name (or its Name in Tally), not
//      the name typed on the document
//    • bill-wise references are the ones Tally holds: an expense's own
//      reference, an opening balance's old Tally reference
//    • a credit note's unapplied part goes On Account; applying it, or an
//      advance, later is its own journal, sent once
//    • a document cancelled after it went is cancelled in Tally next time
//    • two exports at once never send the same document twice
//    • the connector: key, next batch, a refused voucher back in the queue
//    • Tally's ledgers compared with the books
//    • the day in India, not the server's UTC day
//    • drifted figures found and put back; a credit note set against
//      another invoice no longer takes credit off its own on cancelling
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
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const xmlOf = async (id) => (await request(app).get(`/api/v2/accounts/tally/batches/${id}/xml`).set('Cookie', cookie())).text;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Expense', 'AccountNote', 'Payment', 'BankAccount', 'ExpenseCategory', 'OpeningBalance', 'TallyBatch', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'integrity@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5 } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
async function scene({ grand = 10500, date = '2026-07-02' } = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, stateCode: '33', paymentTerms: '30', phoneNumber: '9200000000' });
  const supplier = await M.Supplier.create({ name: `Sri Yarn ${n}`, gstin: `33AAAPS${1000 + n}F1Z5` });
  const taxable = Math.round(grand / 1.05 * 100) / 100;
  const mk = async (no) => {
    const inv = await M.Invoice.create({
      invoiceNumber: no, financialYear: '2026-27', sequence: n, invoiceDate: new Date(date), dueDate: new Date('2026-08-01'),
      order: new mongoose.Types.ObjectId(), orderNo: 40 + n, customer: customer._id, seller: { name: 'Balu Elastics', stateCode: '33' },
      buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
      lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1, rate: taxable, taxable, gstPercent: 5, cgst: (grand - taxable) / 2, sgst: (grand - taxable) / 2, igst: 0, amount: grand }],
      totals: { taxable, cgst: (grand - taxable) / 2, sgst: (grand - taxable) / 2, igst: 0, tax: grand - taxable, roundOff: 0, grand }, status: 'issued',
    });
    await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand });
    return inv;
  };
  const inv = await mk(`INV/2026-27/A${n}`);
  const inv2 = await mk(`INV/2026-27/B${n}`);
  const bank = (await post('/accounts/bank-accounts', { name: `Kotak ${n}`, kind: 'bank', openingBalance: 100000, tallyLedger: 'Kotak Bank CA' })).body.account;
  return { customer, supplier, inv, inv2, bank };
}
const exportJuly = (extra = {}) => post('/accounts/tally/export', { from: '2026-07-01', to: '2026-07-31', ...extra });

describe('names and bill-wise references Tally holds', () => {
  it('uses the party\'s Name in Tally, an expense\'s reference and an opening balance\'s old reference', async () => {
    const s = await scene();
    await M.Customer.updateOne({ _id: s.customer._id }, { tallyName: 'SUNRISE GARMENTS (TPR)' });
    await get('/accounts/categories');
    const head = await M.ExpenseCategory.findOne({ name: /Transport/i });
    await M.ExpenseCategory.updateOne({ _id: head._id }, { approvalAbove: 100000 });
    const exp = (await post('/accounts/expenses', { category: head._id, description: 'Lorry', supplier: s.supplier._id, payeeName: 'sri yarn (typed)', refNo: 'LR-77', amount: 2000, date: '2026-07-04' })).body.expense;
    const ob = await M.OpeningBalance.create({ docNo: `OB/T/${n}`, financialYear: '2025-26', sequence: n, partyType: 'customer', customer: s.customer._id, partyName: s.customer.name, kind: 'due', date: new Date('2026-03-20'), amount: 5000, refNo: 'TALLY/882', status: 'posted' });
    await post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s.supplier._id, amount: 2000, mode: 'bank', account: s.bank._id, date: '2026-07-06', allocations: [{ docType: 'Expense', doc: exp._id, amount: 2000 }] });
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 5000, mode: 'bank', account: s.bank._id, date: '2026-07-07', allocations: [{ docType: 'OpeningBalance', doc: ob._id, amount: 5000 }] });
    const ex = await exportJuly({ masters: true });
    expect(ex.status).toBe(201);
    const xml = await xmlOf(ex.body.batch._id);
    expect(xml).toMatch(/<PARTYLEDGERNAME>SUNRISE GARMENTS \(TPR\)<\/PARTYLEDGERNAME>/);
    expect(xml).not.toMatch(new RegExp(`<PARTYLEDGERNAME>${s.customer.name}<`));
    expect(xml).toMatch(/<LEDGER NAME="SUNRISE GARMENTS \(TPR\)" ACTION="Create">.*<LEDSTATENAME>Tamil Nadu<\/LEDSTATENAME>.*<PARTYGSTIN>33AAEPS/);
    expect(xml).toMatch(/<PARTYGSTIN>33AAEPS\d+F1Z2<\/PARTYGSTIN><PLACEOFSUPPLY>Tamil Nadu<\/PLACEOFSUPPLY>/);
    // The expense journal and its payment use one bill name: the expense's reference, under the supplier's own name.
    expect((xml.match(/<NAME>LR-77<\/NAME>/g) || []).length).toBe(2);
    expect(xml).toMatch(new RegExp(`<PARTYLEDGERNAME>${s.supplier.name}</PARTYLEDGERNAME>`));
    expect(xml).not.toMatch(/sri yarn \(typed\)/);
    // The receipt settles the opening balance by the reference Tally has for it.
    expect(xml).toMatch(/<NAME>TALLY\/882<\/NAME><BILLTYPE>Agst Ref<\/BILLTYPE>/);
  });
});

describe('credits applied later, and cancellations', () => {
  it('sends a note\'s unapplied part On Account, then its later application as a journal, once', async () => {
    const s = await scene();
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 10500, mode: 'bank', account: s.bank._id, date: '2026-07-03', allocations: [{ docType: 'Invoice', doc: s.inv._id, amount: 10500 }] });
    const cn = (await post('/accounts/notes', { kind: 'credit', against: { doc: s.inv._id }, reason: 'Rate difference', date: '2026-07-05', lines: [{ description: 'Rate', quantity: 1, rate: 1000, gstPercent: 5 }] })).body.note;
    expect(cn).toMatchObject({ applied: 0, unapplied: 1050 });
    const first = await exportJuly();
    const x1 = await xmlOf(first.body.batch._id);
    expect(x1).toMatch(new RegExp(`<NAME>${cn.noteNo.replace(/\//g, '\\/')}</NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>1050.00</AMOUNT>`));
    // Applied to the second invoice later in the month.
    expect((await post('/accounts/credits/apply', { source: { type: 'AccountNote', id: cn._id }, allocations: [{ docType: 'Invoice', doc: s.inv2._id, amount: 1050 }] })).status).toBe(200);
    await M.AccountNote.updateOne({ _id: cn._id }, { $set: { 'applications.0.at': new Date('2026-07-20T06:00:00Z') } });
    const pv = (await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body;
    expect(pv.counts).toEqual({ 'Credit applied': 1 });
    const second = await exportJuly();
    const x2 = await xmlOf(second.body.batch._id);
    expect(x2).toMatch(/<VOUCHER VCHTYPE="Journal"/);
    expect(x2).toMatch(new RegExp(`<NAME>${cn.noteNo.replace(/\//g, '\\/')}</NAME><BILLTYPE>On Account</BILLTYPE><AMOUNT>-1050.00</AMOUNT>`));
    expect(x2).toMatch(new RegExp(`<NAME>${s.inv2.invoiceNumber.replace(/\//g, '\\/')}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>1050.00</AMOUNT>`));
    expect((await exportJuly()).status).toBe(409); // nothing new: the application went once
  });

  it('cancels in Tally what was cancelled here after it went', async () => {
    const s = await scene();
    const r = (await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 10500, mode: 'bank', account: s.bank._id, date: '2026-07-03', allocations: [{ docType: 'Invoice', doc: s.inv._id, amount: 10500 }] })).body.payment;
    expect((await exportJuly()).status).toBe(201);
    expect((await post(`/accounts/payments/${r._id}/cancel`, { reason: 'Cheque bounced back' })).status).toBe(200);
    const health = (await get('/accounts/health')).body.checks.find((c) => c.key === 'cancelled');
    expect(health).toMatchObject({ ok: false, count: 1 });
    const again = await exportJuly();
    expect(again.status).toBe(201);
    expect(again.body.batch).toMatchObject({ vouchers: 0, cancels: 1 });
    const x = await xmlOf(again.body.batch._id);
    expect(x).toMatch(new RegExp(`<VOUCHER DATE="3-Jul-2026" TAGNAME="Voucher Number" TAGVALUE="${r.voucherNo.replace(/\//g, '\\/')}" VCHTYPE="Receipt" ACTION="Cancel">`));
    expect((await M.Payment.findById(r._id).lean()).tally.cancelBatch).toBeTruthy();
    expect((await get('/accounts/health')).body.checks.find((c) => c.key === 'cancelled').ok).toBe(true);
  });

  it('two exports at the same moment never send the same document twice', async () => {
    await scene();
    const [a, b] = await Promise.all([exportJuly(), exportJuly()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const batches = await M.TallyBatch.find({}).lean();
    expect(batches).toHaveLength(1);
    expect(await M.Invoice.countDocuments({ 'tally.batch': batches[0]._id })).toBe(2);
  });
});

describe('the connector', () => {
  it('posts a queued batch message by message; what Tally refuses goes back to the queue', async () => {
    const s = await scene();
    expect((await get('/accounts/tally/connector')).body.connector).toMatchObject({ configured: false, online: false });
    expect((await exportJuly({ via: 'connector' })).status).toBe(409); // no connector yet
    const { key } = (await post('/accounts/tally/connector/key', {})).body;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await get('/accounts/settings')).body.settings)).not.toMatch(/keyHash/);
    const conn = (m, p, body) => request(app)[m](`/api/v2/tally-connector${p}`).set('X-Tally-Connector-Key', key).send(body);
    expect((await request(app).get('/api/v2/tally-connector/next').set('X-Tally-Connector-Key', 'wrong')).status).toBe(401);
    expect((await conn('post', '/ping', { tallyOk: true, version: '1.0.0' })).body).toMatchObject({ company: 'Balu Elastics' });
    expect((await get('/accounts/tally/connector')).body.connector).toMatchObject({ configured: true, online: true, tallyOk: true });

    const ex = await exportJuly({ via: 'connector' });
    expect(ex.status).toBe(201);
    expect(ex.body.batch.delivery).toMatchObject({ via: 'connector', status: 'queued' });
    const { batch } = (await conn('get', '/next')).body;
    expect(batch.messages.map((m) => m.kind)).toEqual(['voucher', 'voucher']);
    expect(batch.messages[0].xml).toMatch(/<ENVELOPE>[\s\S]*<VOUCHER VCHTYPE="Sales"/);
    expect((await conn('get', '/next')).body.batch).toBeNull(); // taken, not offered twice
    const [ok, bad] = batch.messages;
    const r = (await conn('post', '/result', { batchId: batch._id, results: [{ key: ok.key, ok: true }, { key: bad.key, ok: false, error: 'Ledger \'Sunrise\' does not exist' }] })).body;
    expect(r).toMatchObject({ sent: 1, failed: 1, status: 'partial' });
    const b = (await get('/accounts/tally/batches')).body.batches[0];
    expect(b.delivery).toMatchObject({ status: 'partial', failed: 1, errors: [expect.objectContaining({ error: expect.stringMatching(/does not exist/) })] });
    // The refused invoice waits in the next export; the other does not.
    const pv = (await get('/accounts/tally/preview?from=2026-07-01&to=2026-07-31')).body;
    expect(pv.counts).toEqual({ Sales: 1 });
    expect(pv.sample[0].number).toBe(bad.number);

    // Tally's ledgers, in parts, against the books.
    const part1 = (await conn('post', '/ledgers', { company: 'Balu Elastics', ledgers: [{ name: s.customer.name, parent: 'Sundry Debtors', closing: -10000 }] })).body;
    await conn('post', '/ledgers', { snapshot: part1.snapshot, ledgers: [{ name: 'Kotak Bank CA', parent: 'Bank Accounts', closing: -100000 }, { name: 'Old Party', parent: 'Sundry Debtors', closing: -700 }] });
    const rec = (await get('/accounts/tally/reconcile')).body;
    expect(rec.snapshot).toMatchObject({ count: 3 });
    const mine = rec.parties.find((p) => p.party === String(s.customer._id));
    expect(mine).toMatchObject({ inTally: true, appSent: 10500, tally: 10000, difference: -500, unsent: 1 });
    expect(rec.banks.find((x) => x.name === s.bank.name)).toMatchObject({ inTally: true, tally: 100000 });
    expect(rec.onlyInTally).toEqual([expect.objectContaining({ name: 'Old Party' })]);
    expect(rec.missing).toEqual(expect.arrayContaining([expect.objectContaining({ ledger: 'Sales' })]));
  });
});

describe('a reverse-charge bill', () => {
  it('is not taken for a total that is off its lines', async () => {
    const s = await scene();
    await M.Supplier.updateOne({ _id: s.supplier._id }, { gstRegistration: 'unregistered', gstin: '' });
    await post('/accounts/bills', { supplier: s.supplier._id, supplierBillNo: 'LR/1', billDate: '2026-07-05', kind: 'service', reverseCharge: true, lines: [{ description: 'Freight', quantity: 1, rate: 18000, gstPercent: 5 }] });
    expect((await get('/accounts/health')).body.checks.find((c) => c.key === 'totals').ok).toBe(true);
  });
});

describe('the day in India', () => {
  it('keeps a document dated 1 am on the 1st on the 1st, here and in Tally', () => {
    const { readDate } = require('../../services/accountsHelpers');
    expect(readDate('2026-11-01', 'd').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(readDate('2026-10-31T19:30:00.000Z', 'd').toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(readDate(undefined, 'd', new Date('2026-10-31T19:30:00Z')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    const { tallyDate } = require('../../services/tallyExport');
    expect(tallyDate(new Date('2026-10-31T19:30:00Z'))).toBe('20261101');
    expect(tallyDate(new Date('2026-11-01T00:00:00Z'))).toBe('20261101');
  });
});

describe('the books checked against themselves', () => {
  it('finds a figure that drifted from its vouchers and puts it back', async () => {
    const s = await scene();
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 4000, mode: 'bank', account: s.bank._id, date: '2026-07-03', allocations: [{ docType: 'Invoice', doc: s.inv._id, amount: 4000 }] });
    let h = (await get('/accounts/health')).body.checks;
    expect(h.find((c) => c.key === 'derived').ok).toBe(true);
    expect(h.find((c) => c.key === 'ledger').ok).toBe(true);
    await M.Invoice.updateOne({ _id: s.inv._id }, { paidAmount: 6000 }); // a write that went wrong
    h = (await get('/accounts/health')).body.checks;
    expect(h.find((c) => c.key === 'derived')).toMatchObject({ ok: false, count: 1, rows: [expect.objectContaining({ docNo: s.inv.invoiceNumber, field: 'paidAmount', stored: 6000, expected: 4000 })] });
    expect(h.find((c) => c.key === 'ledger').ok).toBe(false);
    expect((await post('/accounts/health/repair', {})).body).toMatchObject({ fixed: 1 });
    const inv = await M.Invoice.findById(s.inv._id).lean();
    expect(inv.paidAmount).toBe(4000);
    expect(inv.fingerprints.at(-1)).toMatchObject({ code: 'BOOKS_REPAIRED', meta: { before: { paidAmount: 6000 }, after: { paidAmount: 4000 } } });
    expect((await get('/accounts/health')).body.checks.find((c) => c.key === 'derived').ok).toBe(true);
  });

  it('cancelling a credit note set against another invoice takes credit only off that one', async () => {
    const s = await scene();
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: s.customer._id, amount: 10500, mode: 'bank', account: s.bank._id, date: '2026-07-03', allocations: [{ docType: 'Invoice', doc: s.inv._id, amount: 10500 }] });
    const cn = (await post('/accounts/notes', { kind: 'credit', against: { doc: s.inv._id }, reason: 'Rate difference', date: '2026-07-05', lines: [{ description: 'Rate', quantity: 1, rate: 1000, gstPercent: 5 }] })).body.note;
    await post('/accounts/credits/apply', { source: { type: 'AccountNote', id: cn._id }, allocations: [{ docType: 'Invoice', doc: s.inv2._id, amount: 1050 }] });
    expect((await post(`/accounts/notes/${cn._id}/cancel`, { reason: 'Issued in error' })).status).toBe(200);
    const [a, b] = await Promise.all([M.Invoice.findById(s.inv._id).lean(), M.Invoice.findById(s.inv2._id).lean()]);
    expect(a.creditedAmount || 0).toBe(0);
    expect(b.creditedAmount || 0).toBe(0);
    expect((await get('/accounts/health')).body.checks.find((c) => c.key === 'derived').ok).toBe(true);
  });
});
