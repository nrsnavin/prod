'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE ACCOUNTS AUDIT FOUND, AND REFUNDS
//
//    • a note cancelled twice at once is reversed once
//    • a customer's debit note that has been paid cannot be cancelled
//      out from under the receipt that paid it
//    • cash goes through the cash box, and only cash does
//    • a customer whose money on account covers what is overdue is not
//      chased: the office is told to set it off, the reminders skip them
//    • a refund pays back credit on account — to a customer out of an
//      advance or an unused credit note, from a supplier out of what we
//      paid ahead — on the ledger, in Tally, and undone when cancelled;
//      the credit it came out of cannot be cancelled under it
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
const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Invoice', 'AccountNote', 'Payment', 'OpeningBalance', 'PartyLedgerEntry', 'NotificationSettings', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'audit2@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', invoice: { defaultGstPercent: 5, stateCode: '33' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let n = 0;
let bank, cash;
beforeAll(async () => {
  await get('/accounts/bank-accounts');
  cash = (await get('/accounts/bank-accounts')).body.accounts.find((a) => a.kind === 'cash');
  bank = (await ok(post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank', openingBalance: 500000, openingDate: '2026-03-31', tallyLedger: 'Kotak Mahindra Bank' }))).account;
});
const customer = async (name) => { n += 1; return M.Customer.create({ name: name || `Buyer ${n}`, contactName: 'R', gstin: `33AAEPS${1000 + n}F1Z2`, paymentTerms: '30', phoneNumber: `98400${String(10000 + n)}`, address: 'Tiruppur', stateCode: '33' }); };
const supplier = async (name) => { n += 1; return M.Supplier.create({ name: name || `Mill ${n}`, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode', phoneNumber: '9840000000' }); };
async function invoice(c, grand, date = '2026-06-01') {
  n += 1;
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(date), dueDate: new Date(new Date(date).getTime() + 30 * DAY),
    order: new mongoose.Types.ObjectId(), customer: c._id, buyer: { name: c.name, gstin: c.gstin, stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: 'Elastic', hsn: '5806', unit: 'm', quantity: 1, rate: r2(grand / 1.05), taxable: r2(grand / 1.05), gstPercent: 5, cgst: r2(grand / 1.05 * 0.025), sgst: r2(grand / 1.05 * 0.025), igst: 0, amount: grand }],
    totals: { taxable: r2(grand / 1.05), cgst: r2(grand / 1.05 * 0.025), sgst: r2(grand / 1.05 * 0.025), igst: 0, tax: r2(grand - grand / 1.05), roundOff: 0, grand }, status: 'issued',
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: c._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: grand, narration: 'Sales' });
  return inv;
}
const receipt = (c, amount, extra = {}) => post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: c._id, amount, mode: 'bank', account: bank._id, date: '2026-06-10', ...extra });
const healthClean = async () => {
  const h = await require('../../services/booksHealth').check();
  expect(h.checks.filter((c) => !c.ok && c.severity === 'critical').map((c) => `${c.key}: ${JSON.stringify(c.rows.slice(0, 2))}`)).toEqual([]);
};
const balance = async (partyType, id) => (await require('../../services/partyLedger').balances(partyType, [id])).get(String(id)) || 0;

describe('notes', () => {
  it('cancelled twice at the same moment: reversed once', async () => {
    const c = await customer();
    const inv = await invoice(c, 10500);
    const cn = (await ok(post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Rate difference', date: '2026-06-05', lines: [{ description: 'Rate', quantity: 1, rate: 1000, gstPercent: 5 }] }))).note;
    expect((await M.Invoice.findById(inv._id).lean()).creditedAmount).toBe(1050);
    const [a, b] = await Promise.all([
      post(`/accounts/notes/${cn._id}/cancel`, { reason: 'Raised by mistake' }),
      post(`/accounts/notes/${cn._id}/cancel`, { reason: 'Raised by mistake' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    // Once: not −1,050.
    expect((await M.Invoice.findById(inv._id).lean()).creditedAmount).toBe(0);
    await healthClean();
  });

  it("a customer's debit note that was paid stays until the receipt that paid it is cancelled", async () => {
    const c = await customer();
    const inv = await invoice(c, 10500);
    const dn = (await ok(post('/accounts/notes', { kind: 'debit', partyType: 'customer', against: { doc: inv._id }, reason: 'Freight billed later', date: '2026-06-05', lines: [{ description: 'Freight', quantity: 1, rate: 1000, gstPercent: 18 }] }))).note;
    const rct = (await ok(receipt(c, 11680, { allocations: [{ docType: 'Invoice', doc: inv._id, amount: 11680 }] }))).payment;
    const refused = await post(`/accounts/notes/${dn._id}/cancel`, { reason: 'Freight waived after all' });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/cancel the receipt that paid it first/);
    expect((await M.AccountNote.findById(dn._id).lean()).status).toBe('issued');
    await ok(post(`/accounts/payments/${rct._id}/cancel`, { reason: 'Entered on the wrong day' }), 200);
    await ok(post(`/accounts/notes/${dn._id}/cancel`, { reason: 'Freight waived after all' }), 200);
    expect(await M.Invoice.findById(inv._id).lean()).toMatchObject({ debitedAmount: 0, paidAmount: 0 });
    await healthClean();
  });
});

describe('cash and the cash box', () => {
  it('cash only into a cash account, and the cash box only for cash', async () => {
    const c = await customer();
    const intoBank = await receipt(c, 1000, { mode: 'cash' });
    expect(intoBank.status).toBe(400);
    expect(intoBank.body.message).toMatch(/Cash is received into and paid from a cash account — Kotak CA is a bank account/);
    const toBox = await receipt(c, 1000, { mode: 'bank', account: cash._id });
    expect(toBox.status).toBe(400);
    expect(toBox.body.message).toMatch(/is the cash box/);
    expect((await receipt(c, 1000, { mode: 'cash', account: cash._id })).status).toBe(201);
  });
});

describe('collections', () => {
  it('a customer whose money on account covers what is overdue is set off, not chased', async () => {
    const c = await customer('Advance Paid Knits');
    await invoice(c, 5000, iso(Date.now() - 60 * DAY));
    await ok(receipt(c, 6000, { date: iso(Date.now() - 5 * DAY) }));
    const partly = await customer('Partly Paid Trims');
    await invoice(partly, 8000, iso(Date.now() - 60 * DAY));
    await ok(receipt(partly, 3000, { date: iso(Date.now() - 5 * DAY) }));

    const rows = await require('../../services/collections').overdue();
    const covered = rows.find((r) => r.partyName === 'Advance Paid Knits');
    expect(covered).toMatchObject({ overdue: 5000, onAccount: 6000, covered: true, next: { action: 'apply', label: 'Set off the ₹6,000.00 they paid ahead' } });
    const part = rows.find((r) => r.partyName === 'Partly Paid Trims');
    expect(part).toMatchObject({ overdue: 8000, onAccount: 3000, covered: false });
    expect(part.next.action).not.toBe('apply');
    // Covered ones after the ones to chase.
    expect(rows.indexOf(covered)).toBeGreaterThan(rows.indexOf(part));

    const due = await require('../../services/collectionReminders').due({ everyDays: 7, minOverdueDays: 3 });
    expect(due.skip.find((s) => s.partyName === 'Advance Paid Knits').why).toBe('has ₹6,000.00 paid ahead — set it off, not a reminder');
    expect(due.send.map((s) => s.partyName)).toContain('Partly Paid Trims');
  });
});

describe('refunds', () => {
  it("pays a customer back out of their advance: on the ledger, off the credit, in Tally, and undone when cancelled", async () => {
    const c = await customer('Sunrise Garments');
    const adv = (await ok(receipt(c, 10000, { reference: 'NEFT ADV1' }))).payment;
    expect(adv.unallocated).toBe(10000);
    expect(await balance('customer', c._id)).toBe(-10000);

    // Without saying what it refunds, a payment to a customer is refused.
    const bare = await post('/accounts/payments', { kind: 'payment', partyType: 'customer', customer: c._id, amount: 4000, mode: 'bank', account: bank._id, date: '2026-06-20' });
    expect(bare.status).toBe(400);
    expect(bare.body.message).toMatch(/refund what they have on account/);
    const refund = (body) => post('/accounts/payments', { kind: 'payment', partyType: 'customer', customer: c._id, mode: 'bank', account: bank._id, date: '2026-06-20', reference: 'NEFT REF1', ...body });
    expect((await refund({ amount: 12000, refunds: [{ sourceType: 'Payment', id: adv._id, amount: 12000 }] })).body.message).toMatch(/has only ₹10000.00 on account/);
    expect((await refund({ amount: 5000, refunds: [{ sourceType: 'Payment', id: adv._id, amount: 4000 }] })).body.message).toMatch(/credits picked come to ₹4000.00/);
    expect((await refund({ amount: 4000, refunds: [{ sourceType: 'Payment', id: adv._id, amount: 4000 }], allocations: [{ docType: 'Invoice', doc: new mongoose.Types.ObjectId(), amount: 1 }] })).status).toBe(400);
    const other = await customer();
    const otherAdv = (await ok(receipt(other, 500))).payment;
    expect((await refund({ amount: 500, refunds: [{ sourceType: 'Payment', id: otherAdv._id, amount: 500 }] })).body.message).toMatch(/belongs to another party/);

    const ref = (await ok(refund({ amount: 4000, refunds: [{ sourceType: 'Payment', id: adv._id, amount: 4000 }] }))).payment;
    expect(ref).toMatchObject({ kind: 'payment', partyType: 'customer', amount: 4000, unallocated: 0, refunds: [{ sourceType: 'Payment', docNo: adv.voucherNo, amount: 4000 }] });
    expect((await M.Payment.findById(adv._id).lean()).unallocated).toBe(6000);
    expect(await balance('customer', c._id)).toBe(-6000);
    const credits = await require('../../services/credits').openFor('customer', c._id);
    expect(credits.map((x) => [x.docNo, x.available])).toEqual([[adv.voucherNo, 6000]]);
    await healthClean();

    // On the statement: To the bank, a refund of the advance.
    const st = (await ok(get(`/accounts/statement?partyType=customer&party=${c._id}`), 200));
    const row = st.rows.find((r) => r.docNo === ref.voucherNo);
    expect(row).toMatchObject({ toBy: 'To', particulars: 'Kotak Mahindra Bank', vchType: 'Payment', debit: 4000, partyRef: 'Refund · NEFT REF1' });

    // In Tally: Dr the customer, Cr the bank — balanced.
    const built = await require('../../services/tallyExport').build({ from: new Date('2026-06-01'), to: new Date('2026-06-30T23:59:59'), fresh: true, L: require('../../services/partyStatement').DEFAULT_LEDGERS });
    const tv = built.vouchers.find((v) => v.number === ref.voucherNo);
    expect(tv.type).toBe('Payment');
    expect(tv.lines.map((l) => [l.ledger, l.amount])).toEqual([['Kotak Mahindra Bank', -4000], ['Sunrise Garments', 4000]]);

    // The advance cannot be cancelled under the refund; the refund can, and puts it back.
    const blocked = await post(`/accounts/payments/${adv._id}/cancel`, { reason: 'Entered twice by mistake' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(new RegExp(`refunded by ${ref.voucherNo.replace(/\//g, '\\/')}`));
    await ok(post(`/accounts/payments/${ref._id}/cancel`, { reason: 'Refund bounced back' }), 200);
    expect((await M.Payment.findById(adv._id).lean()).unallocated).toBe(10000);
    expect(await balance('customer', c._id)).toBe(-10000);
    await healthClean();
    await ok(post(`/accounts/payments/${adv._id}/cancel`, { reason: 'Entered twice by mistake' }), 200);

    // Rebuilt from the documents, nothing moves.
    const before = (await M.PartyLedgerEntry.find({}).lean()).map((e) => `${e.docNo} ${e.debit} ${e.credit}`).sort();
    await require('../../services/partyLedger').rebuild();
    expect((await M.PartyLedgerEntry.find({}).lean()).map((e) => `${e.docNo} ${e.debit} ${e.credit}`).sort()).toEqual(before);
  });

  it('out of an unused credit note, and out of an opening advance — which then cannot be cancelled under it', async () => {
    const c = await customer();
    const inv = await invoice(c, 1050);
    await ok(receipt(c, 1050, { allocations: [{ docType: 'Invoice', doc: inv._id, amount: 1050 }] }));
    // A credit note after the invoice was paid: all of it unapplied.
    const cn = (await ok(post('/accounts/notes', { kind: 'credit', against: { doc: inv._id }, reason: 'Short supply', date: '2026-06-12', lines: [{ description: 'Short', quantity: 1, rate: 200, gstPercent: 5 }] }))).note;
    expect(cn.unapplied).toBe(210);
    const ob = (await ok(post('/accounts/opening-balances', { partyType: 'customer', party: c._id, kind: 'advance', date: '2026-03-31', amount: 500 }))).row;
    const ref = (await ok(post('/accounts/payments', { kind: 'payment', partyType: 'customer', customer: c._id, amount: 710, mode: 'cash', account: cash._id, date: '2026-06-20',
      refunds: [{ sourceType: 'AccountNote', id: cn._id, amount: 210 }, { sourceType: 'OpeningBalance', id: ob._id, amount: 500 }] }))).payment;
    expect((await M.AccountNote.findById(cn._id).lean()).unapplied).toBe(0);
    expect((await M.OpeningBalance.findById(ob._id).lean()).unapplied).toBe(0);
    expect(await balance('customer', c._id)).toBe(0);
    await healthClean();
    expect((await post(`/accounts/notes/${cn._id}/cancel`, { reason: 'Note raised in error' })).body.message).toMatch(/refunded by/);
    expect((await post(`/accounts/opening-balances/${ob._id}/cancel`, { reason: 'Wrong opening figure' })).body.message).toMatch(/refunded by/);
    await ok(post(`/accounts/payments/${ref._id}/cancel`, { reason: 'Refund not made after all' }), 200);
    expect((await M.AccountNote.findById(cn._id).lean()).unapplied).toBe(210);
    expect((await M.OpeningBalance.findById(ob._id).lean()).unapplied).toBe(500);
    await healthClean();
  });

  it('a supplier paying back what we paid them ahead is a receipt that refunds it', async () => {
    const s = await supplier('Sri Yarn Traders');
    const adv = (await ok(post('/accounts/payments', { kind: 'payment', partyType: 'supplier', supplier: s._id, amount: 20000, mode: 'bank', account: bank._id, date: '2026-06-02', narration: 'Advance for yarn' }))).payment;
    expect(adv.unallocated).toBe(20000);
    const bare = await post('/accounts/payments', { kind: 'receipt', partyType: 'supplier', supplier: s._id, amount: 5000, mode: 'bank', account: bank._id, date: '2026-06-25' });
    expect(bare.body.message).toMatch(/money a supplier pays back is a refund/);
    const back = (await ok(post('/accounts/payments', { kind: 'receipt', partyType: 'supplier', supplier: s._id, amount: 5000, mode: 'bank', account: bank._id, date: '2026-06-25',
      refunds: [{ sourceType: 'Payment', id: adv._id, amount: 5000 }] }))).payment;
    expect((await M.Payment.findById(adv._id).lean()).unallocated).toBe(15000);
    // We had 20,000 with them; now 15,000.
    expect(await balance('supplier', s._id)).toBe(-15000);
    await healthClean();
    const built = await require('../../services/tallyExport').build({ from: new Date('2026-06-01'), to: new Date('2026-06-30T23:59:59'), fresh: true, L: require('../../services/partyStatement').DEFAULT_LEDGERS });
    const tv = built.vouchers.find((v) => v.number === back.voucherNo);
    expect(tv.type).toBe('Receipt');
    expect(tv.lines.map((l) => [l.ledger, l.amount])).toEqual([['Kotak Mahindra Bank', 5000], ['Sri Yarn Traders', -5000]]);
  });
});
