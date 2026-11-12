'use strict';
// ══════════════════════════════════════════════════════════════════
//  TWO REQUESTS AT ONCE, IN THE BOOKS
//
//  What went wrong before (reproduced in the audit of 12 Nov 2026):
//
//    • the year's depreciation was posted twice by two requests
//      together, and a later re-post cancelled one and left the other;
//    • a receipt was cancelled while its credit was being applied to an
//      invoice: the cancel reversed what it had read earlier, and the
//      invoice stayed settled by a cancelled receipt;
//    • two credit notes together took the same room on a paid invoice:
//      16,800 of notes against 10,500.
//
//  And the smaller spots of the same kind: one goods receipt on two
//  bills, the cash box emptied twice, a year's Form 26AS doubled.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, bank, cash;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const DAY = 86_400_000;
const iso = (off = 0) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
let n = 0;

async function customerScene(grand = 10500) {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'R', phoneNumber: `92000000${String(n).padStart(2, '0')}`, gstin: `33AAEPS11${String(n).padStart(2, '0')}F1Z2`, paymentTerms: '30' });
  const invoice = async () => {
    n += 1;
    const inv = await M.Invoice.create({
      invoiceNumber: `INV/2026-27/${String(900 + n).padStart(4, '0')}`, financialYear: '2026-27', sequence: 900 + n, invoiceDate: new Date('2026-06-01'), dueDate: new Date('2026-07-01'),
      order: new mongoose.Types.ObjectId(), orderNo: 900 + n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', stateCode: '33' },
      buyer: { name: customer.name, gstin: customer.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
      lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 1000, rate: 10, taxable: 10000, gstPercent: 5, cgst: 250, sgst: 250, igst: 0, amount: 10500 }],
      totals: { taxable: 10000, cgst: 250, sgst: 250, igst: 0, tax: 500, roundOff: 0, grand }, status: 'issued',
    });
    await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand, narration: 'Sales' });
    return inv;
  };
  return { customer, inv: await invoice(), invoice };
}
const receipt = (customer, amount, extra = {}) => post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount, mode: 'bank', account: bank._id, date: iso(-2), ...extra });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const m of ['User', 'Customer', 'Supplier', 'Invoice', 'SupplierBill', 'Payment', 'AccountNote', 'Journal', 'BankAccount', 'RawMaterial', 'PurchaseOrder', 'MaterialInward', 'Tds26asEntry', 'DepositSlip']) M[m] = require(`../../models/${m}`);
  admin = await M.User.create({ name: 'Owner', email: 'twice@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await request(app).put('/api/v2/settings/document').set('Cookie', cookie()).send({ companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, defaultHsn: '5806' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
  await get('/accounts/bank-accounts');
  cash = await M.BankAccount.findOne({ kind: 'cash' }).lean();
  bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 500000, isDefault: true })).body.account;
});

describe('a journal another process keeps is posted once', () => {
  const posted = () => M.Journal.find({ source: 'depreciation', sourceRef: '2025-26', status: 'posted' }).select('journalNo total').lean();

  it('the year\'s depreciation sent twice together is in the books once', async () => {
    expect((await post('/accounts/fixed-assets', { name: 'Needle loom 12', block: 'plant', purchaseDate: '2025-05-01', putToUse: '2025-05-10', cost: 1000000 })).status).toBe(201);
    const both = await Promise.all([post('/accounts/fixed-assets/depreciation', { fy: '2025-26' }), post('/accounts/fixed-assets/depreciation', { fy: '2025-26' })]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    // The second waited for the first, found the year's journal already
    // there saying the same thing, and left it: one journal, one number.
    expect(await posted()).toHaveLength(1);
    expect(await M.Journal.countDocuments({ source: 'depreciation' })).toBe(1);
    expect(both[0].body.journal.journalNo).toBe(both[1].body.journal.journalNo);

    // Posted again with nothing changed: still that one journal.
    expect((await post('/accounts/fixed-assets/depreciation', { fy: '2025-26' })).status).toBe(201);
    expect(await M.Journal.countDocuments({ source: 'depreciation' })).toBe(1);

    // Another asset bought in the year: the journal is replaced, and there is still one posted.
    expect((await post('/accounts/fixed-assets', { name: 'Warping machine', block: 'plant', purchaseDate: '2025-08-01', putToUse: '2025-08-05', cost: 400000 })).status).toBe(201);
    const again = await post('/accounts/fixed-assets/depreciation', { fy: '2025-26' });
    expect(again.status).toBe(201);
    expect(again.body.journal.journalNo).not.toBe(both[0].body.journal.journalNo);
    expect(await posted()).toHaveLength(1);
    expect(await M.Journal.countDocuments({ source: 'depreciation', status: 'cancelled' })).toBe(1);
  });

  it('the database itself refuses a second posted journal for the same thing', async () => {
    await M.Journal.syncIndexes();
    const journals = require('../../services/journals');
    const req = { user: admin, body: {} };
    const b = (debit) => ({ date: new Date('2026-10-31T00:00:00Z'), purpose: 'salary', narration: 'Salaries', reason: 'Payroll 2026-10', source: 'payroll', sourceRef: 'salary:2026-10', lines: [{ kind: 'ledger', ledger: 'Salaries', debit }, { kind: 'ledger', ledger: 'Salary Payable', credit: debit }] });
    const first = await journals.replace(b(1000), 'Replaced', req);
    expect(first.replaced).toBeNull();
    // Straight into the collection, round the service: refused by the index.
    const copy = { ...first.journal, _id: new mongoose.Types.ObjectId(), journalNo: 'JV/COPY/1', requestId: undefined };
    await expect(M.Journal.create(copy)).rejects.toMatchObject({ code: 11000 });
    // Through the service it takes the first one's place.
    const second = await journals.replace(b(1200), 'Replaced', req);
    expect(second.replaced).toBe(first.journal.journalNo);
    const live = await M.Journal.find({ source: 'payroll', sourceRef: 'salary:2026-10', status: 'posted' }).lean();
    expect(live.map((j) => j.total)).toEqual([1200]);
    // The same thing again changes nothing.
    const third = await journals.replace(b(1200), 'Replaced', req);
    expect(third).toMatchObject({ unchanged: true, replay: true, journal: { journalNo: second.journal.journalNo } });
    expect(await M.Journal.countDocuments({ source: 'payroll', sourceRef: 'salary:2026-10' })).toBe(2);
    // A journal written by hand is not held to one.
    const lines = [{ kind: 'ledger', ledger: 'Depreciation', debit: 100 }, { kind: 'ledger', ledger: 'Accumulated Depreciation', credit: 100 }];
    expect((await post('/accounts/journals', { reason: 'Year end test entry', lines })).status).toBe(201);
    expect((await post('/accounts/journals', { reason: 'Year end test entry', lines })).status).toBe(201);
  });
});

describe('cancelling against applying', () => {
  it('a credit applied after the cancel route read the voucher is reversed with the rest', async () => {
    const { customer, inv } = await customerScene();
    const adv = await receipt(customer, 10500);
    const id = adv.body.payment._id;
    const stale = await M.Payment.findById(id).lean();   // what POST /payments/:id/cancel reads before it starts
    expect((await post('/accounts/credits/apply', { source: { type: 'Payment', id }, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] })).status).toBe(200);
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(10500);

    await require('../../services/voucherCancel').cancelVoucher(stale, 'Entered twice by mistake', { user: admin, body: {}, headers: {}, get: () => '' });
    expect((await M.Payment.findById(id).lean()).status).toBe('cancelled');
    // The invoice is not left settled by a cancelled receipt.
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(0);
    expect((await get(`/accounts/outstanding?type=receivable&party=${customer._id}`)).body.totals.total).toBe(10500);
    expect((await get('/accounts/health')).body.checks.find((c) => c.key === 'derived').ok).toBe(true);
  });

  it('a cancel and an apply sent together never leave an invoice settled by a cancelled receipt', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { customer, inv } = await customerScene();
      const adv = await receipt(customer, 10500);
      const id = adv.body.payment._id;
      const [c, a] = await Promise.all([
        post(`/accounts/payments/${id}/cancel`, { reason: 'Entered twice by mistake' }),
        post('/accounts/credits/apply', { source: { type: 'Payment', id }, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] }),
      ]);
      const v = await M.Payment.findById(id).lean();
      const i = await M.Invoice.findById(inv._id).lean();
      // Either order is fine; a cancelled receipt whose credit still settles the invoice is not.
      if (v.status === 'cancelled') expect(i.paidAmount).toBe(0);
      else { expect(c.status).not.toBe(200); expect(a.status).toBe(200); expect(i.paidAmount).toBe(10500); }
    }
    expect((await get('/accounts/health')).body.checks.find((x) => x.key === 'derived').ok).toBe(true);
  });

  it('a cancel and a refund sent together never leave a refund of a cancelled receipt', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { customer } = await customerScene();
      const adv = await receipt(customer, 4000);
      const id = adv.body.payment._id;
      const [c, r] = await Promise.all([
        post(`/accounts/payments/${id}/cancel`, { reason: 'Entered twice by mistake' }),
        post('/accounts/payments', { kind: 'payment', partyType: 'customer', customer: customer._id, amount: 4000, mode: 'bank', account: bank._id, date: iso(-1), refunds: [{ sourceType: 'Payment', id, amount: 4000 }] }),
      ]);
      const v = await M.Payment.findById(id).lean();
      const refund = await M.Payment.findOne({ 'refunds.source': v._id, status: 'posted' }).lean();
      expect([c.status === 200, r.status === 201].filter(Boolean)).toHaveLength(1);
      if (v.status === 'cancelled') expect(refund).toBeNull();
      else expect(refund).toBeTruthy();
    }
  });

  it('a credit note cancelled while its credit is applied elsewhere takes that credit back too', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { customer, inv, invoice } = await customerScene();
      // Paid in full, then a credit note: its whole value is left as credit on account.
      await receipt(customer, 10500, { allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] });
      const note = await post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference agreed', lines: [{ description: 'rate difference', quantity: 1, rate: 2000, gstPercent: 5 }], date: iso(0) });
      expect(note.body.note.unapplied).toBe(2100);
      const other = await invoice();
      const [c, a] = await Promise.all([
        post(`/accounts/notes/${note.body.note._id}/cancel`, { reason: 'Issued against the wrong invoice' }),
        post('/accounts/credits/apply', { source: { type: 'AccountNote', id: note.body.note._id }, allocations: [{ docType: 'Invoice', doc: other._id, amount: 2100 }] }),
      ]);
      const stored = await M.AccountNote.findById(note.body.note._id).lean();
      const o = await M.Invoice.findById(other._id).lean();
      if (stored.status === 'cancelled') expect(o.creditedAmount || 0).toBe(0);
      else { expect(c.status).not.toBe(200); expect(a.status).toBe(200); expect(o.creditedAmount).toBe(2100); }
    }
    expect((await get('/accounts/health')).body.checks.find((x) => x.key === 'derived').ok).toBe(true);
  });
});

describe('two notes against one document', () => {
  it('together they cannot be for more than the invoice', async () => {
    const { customer, inv } = await customerScene();
    await receipt(customer, 10500, { allocations: [{ docType: 'Invoice', doc: inv._id, amount: 10500 }] });
    const body = (reason) => ({ kind: 'credit', against: { doc: inv._id }, reason, lines: [{ description: '20mm rate difference', quantity: 1, rate: 8000, gstPercent: 5 }], date: iso(0) });
    const both = await Promise.all([post('/accounts/notes', body('Rate difference agreed')), post('/accounts/notes', body('Rate difference agreed twice'))]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(both.find((r) => r.status === 400).body.message).toMatch(/already has notes for ₹8400\.00 — a note can be for at most ₹2100\.00/);
    const notes = await M.AccountNote.find({ 'against.doc': inv._id, status: 'issued' }).lean();
    expect(notes.map((x) => x.totals.grand)).toEqual([8400]);
    // What room is left can still be used.
    expect((await post('/accounts/notes', { ...body('The rest of the difference'), lines: [{ description: 'rest', quantity: 1, rate: 2000, gstPercent: 5 }] })).status).toBe(201);
  });
});

describe('the smaller spots', () => {
  it('one goods receipt goes on one bill', async () => {
    const supplier = await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0101F1Z5', address: 'Erode' });
    const nylon = await M.RawMaterial.create({ name: 'Nylon 70D', category: 'covering', unit: 'kg', stock: 0, price: 300 });
    const po = await M.PurchaseOrder.create({ supplier: supplier._id, poNo: 501, items: [{ rawMaterial: nylon._id, price: 310, quantity: 100, receivedQuantity: 40 }] });
    const inward = await M.MaterialInward.create({ rawMaterial: nylon._id, purchaseOrder: po._id, quantity: 40, unitPrice: 310, inwardDate: new Date('2026-07-01') });
    const bill = (no) => post('/accounts/bills', { supplier: supplier._id, supplierBillNo: no, billDate: '2026-07-04', purchaseOrder: po._id, inwards: [inward._id], lines: [{ rawMaterial: nylon._id, description: nylon.name, hsn: '5402', unit: 'kg', quantity: 40, rate: 310, gstPercent: 5 }], tds: { applicable: false } });
    const both = await Promise.all([bill('SY/118'), bill('SY/119')]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(both.find((r) => r.status === 409).body.message).toMatch(/A receipt on this bill is already on PB\//);
    expect(await M.SupplierBill.countDocuments({ inwards: inward._id })).toBe(1);
  });

  it('the cash box is not emptied twice by two deposits together', async () => {
    const { customer } = await customerScene();
    await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 30000, mode: 'cash', account: cash._id, date: iso(0) });
    const deposit = () => post('/accounts/deposits', { account: bank._id, date: iso(0), cash: 20000, cashFrom: cash._id });
    const both = await Promise.all([deposit(), deposit()]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(both.find((r) => r.status === 400).body.message).toMatch(/has only ₹10000\.00 on that day/);
    expect(await M.DepositSlip.countDocuments({})).toBe(1);
  });

  it('a year\'s Form 26AS uploaded twice together is the year once; a TAN is learnt only from the same name', async () => {
    const raja = await M.Customer.create({ name: 'Raja', contactName: 'R', phoneNumber: '9200000091', gstin: '33AAEPR9101F1Z2' });
    const sunrise = await M.Customer.create({ name: 'Sunrise Garments Pvt Ltd', contactName: 'R', phoneNumber: '9200000092', gstin: '33AAEPS9102F1Z2' });
    const csv = ['Name of Deductor,TAN of Deductor,Section,Transaction Date,Amount Paid,Tax Deducted', 'MAHARAJA TEXTILES,CHEM01234A,194Q,12-07-2026,500000,500', 'Sunrise Garments Private Limited,CHES05678B,194Q,15-07-2026,1000000,1000'].join('\n');
    const up = () => request(app).post('/api/v2/accounts/tds/26as').set('Cookie', cookie()).field('fy', '2026-27').attach('file', Buffer.from(csv), '26AS.csv');
    const both = await Promise.all([up(), up()]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(await M.Tds26asEntry.countDocuments({ fy: '2026-27' })).toBe(2);
    // "RAJA" sits inside "MAHARAJA TEXTILES": the row is placed to be looked at, the TAN is not learnt.
    expect((await M.Customer.findById(raja._id).lean()).tan || '').toBe('');
    // The same name, less "Pvt Ltd": that customer, and their TAN is kept for next time.
    expect((await M.Customer.findById(sunrise._id).lean()).tan).toBe('CHES05678B');
  });
});
