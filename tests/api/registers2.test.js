'use strict';
// ══════════════════════════════════════════════════════════════════
//  REGISTERS, PART TWO: CHEQUES, INTEREST, CONFIRMATIONS
//
//    Cheques       a post-dated cheque is held, then deposited and
//                  cleared; a returned one cancels its receipt and puts
//                  the invoice back to unpaid, with the charges noted
//    Interest      simple interest from the day after the due date at
//                  the books' rate, drafted as a debit note whose
//                  markers stop the next note charging the same days
//    Confirmations the party's balance on the day, the letter, and the
//                  reply — agreed or disputed with the gap
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

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'Payment', 'AccountNote', 'BalanceConfirmation']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'reg2@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await put('/settings/document', { companyName: 'Balu Elastics', gstin: '33AAECB1234F1Z5', addressLines: ['12 Mill Road'], invoice: { defaultGstPercent: 5, defaultHsn: '5806', stateCode: '33', city: 'Tiruppur', pincode: '641601' } });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  }
});

let n = 0;
const bank = async () => { await get('/accounts/bank-accounts'); return (await post('/accounts/bank-accounts', { name: `Bank ${++n}`, kind: 'bank' })).body.account; };
async function customerWithInvoice(over = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Customer ${n}`, contactName: 'R', phoneNumber: `9300000${String(n).padStart(3, '0')}`, gstin: `33AAEPC${String(n).padStart(4, '0')}F1Z2`, paymentTerms: '30', address: '4 Market St', city: 'Erode', pincode: '638001', stateCode: '33' });
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date('2026-10-05'), dueDate: new Date('2026-11-04'),
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu Elastics', gstin: '33AAECB1234F1Z5', address: '12 Mill Road', city: 'Tiruppur', pincode: '641601', stateCode: '33' },
    buyer: { name: customer.name, gstin: customer.gstin, address: '4 Market St', city: 'Erode', pincode: '638001', stateCode: '33' }, supplyType: 'intra', placeOfSupply: '33',
    lines: [{ name: '20mm', hsn: '5806', unit: 'm', quantity: 10000, rate: 10, taxable: 100000, gstPercent: 5, cgst: 2500, sgst: 2500, igst: 0, amount: 105000 }],
    totals: { taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, tax: 5000, roundOff: 0, grand: 105000 }, status: 'issued', ...over,
  });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: inv.invoiceDate, docType: 'Invoice', doc: inv._id, docNo: inv.invoiceNumber, debit: 105000, narration: 'Sales' });
  return { customer, inv };
}
const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('post-dated cheques', () => {
  it('holds a cheque dated ahead, deposits and clears it, and a returned one cancels the receipt', async () => {
    const { customer, inv } = await customerWithInvoice();
    const acct = await bank();
    const r = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 50000, mode: 'cheque', account: acct._id, cheque: { number: '000412', bank: 'Kotak', date: future(10) }, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 50000 }] });
    expect(r.status).toBe(201);
    expect(r.body.payment.cheque).toMatchObject({ number: '000412', bank: 'Kotak', status: 'held' });
    expect(r.body.payment.reference).toBe('000412');

    const reg = (await get('/accounts/pdc')).body;
    expect(reg.rows.map((x) => x.voucherNo)).toEqual([r.body.payment.voucherNo]);
    expect(reg.totals.held).toMatchObject({ count: 1, received: 50000, issued: 0 });
    expect(reg.totals.dueToday.count).toBe(0);

    const dep = await post(`/accounts/payments/${r.body.payment._id}/cheque`, { action: 'deposited', on: future(10) });
    expect(dep.status).toBe(200);
    expect(dep.body.payment.cheque.status).toBe('deposited');
    const clr = await post(`/accounts/payments/${r.body.payment._id}/cheque`, { action: 'cleared', on: future(12) });
    expect(clr.body.payment.cheque.status).toBe('cleared');
    expect(clr.body.payment.clearedOn).toBeTruthy();
    expect((await post(`/accounts/payments/${r.body.payment._id}/cheque`, { action: 'deposited' })).status).toBe(409);

    // A second cheque, dated today, is taken as deposited; it comes back.
    const r2 = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 55000, mode: 'cheque', account: acct._id, cheque: { number: '000413', bank: 'Kotak' }, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 55000 }] });
    expect(r2.body.payment.cheque.status).toBe('deposited');
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(105000);
    expect((await post(`/accounts/payments/${r2.body.payment._id}/cheque`, { action: 'bounced' })).status).toBe(400);
    const b = await post(`/accounts/payments/${r2.body.payment._id}/cheque`, { action: 'bounced', reason: 'Funds insufficient', charges: 250 });
    expect(b.status).toBe(200);
    expect(b.body.bounced).toBe(true);
    expect(b.body.payment.status).toBe('cancelled');
    expect(b.body.payment.cheque).toMatchObject({ status: 'bounced', bounceReason: 'Funds insufficient', charges: 250 });
    expect(b.body.payment.cancel.reason).toMatch(/000413 returned: Funds insufficient/);
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(50000);
    const bounced = (await get('/accounts/pdc?status=bounced')).body;
    expect(bounced.rows.map((x) => x.voucherNo)).toEqual([r2.body.payment.voucherNo]);
  });
});

describe('interest on overdue receivables', () => {
  it('runs from the day after the due date at the books rate, drafts the debit note, and does not charge the same days twice', async () => {
    const { customer, inv } = await customerWithInvoice();
    expect((await get('/accounts/interest?asOf=2026-12-04')).body.groups).toEqual([]);   // no rate set
    const st = await put('/accounts/settings', { receivables: { interestRate: 18, graceDays: 0 } });
    expect(st.status).toBe(200);
    const i = (await get('/accounts/interest?asOf=2026-12-04')).body;
    expect(i.groups).toHaveLength(1);
    const row = i.groups[0].rows[0];
    // 5 Nov to 4 Dec: 30 days on ₹1,05,000 at 18%.
    expect(row.days).toBe(30);
    expect(row.interest).toBe(1553.42);
    expect(row.gstPercent).toBe(5);
    expect(i.total).toBe(1553.42);

    const d = (await get(`/accounts/interest/draft?customer=${customer._id}&asOf=2026-12-04`)).body;
    expect(d.body.kind).toBe('debit');
    expect(d.body.against.doc).toBe(String(inv._id));
    expect(d.body.lines[0].rate).toBe(1553.42);
    const note = await post('/accounts/notes', d.body);
    expect(note.status).toBe(201);
    expect(note.body.note.interest).toEqual([expect.objectContaining({ docNo: inv.invoiceNumber, days: 30, amount: 1553.42 })]);
    expect(note.body.note.totals.grand).toBe(1631);   // with 5% GST, rounded
    expect((await M.Invoice.findById(inv._id).lean()).debitedAmount).toBe(1631);

    // Six more days, and only those six.
    const later = (await get('/accounts/interest?asOf=2026-12-10')).body;
    const r = later.groups[0].rows[0];
    expect(r.days).toBe(6);
    expect(new Date(r.from).toISOString().slice(0, 10)).toBe('2026-12-05');
    expect(r.outstanding).toBe(106631);
    // A customer's own rate wins over the books'.
    await M.Customer.updateOne({ _id: customer._id }, { $set: { interestRate: 12 } });
    expect((await get('/accounts/interest?asOf=2026-12-10')).body.groups[0].rate).toBe(12);
    // Grace days hold it off.
    await M.Customer.updateOne({ _id: customer._id }, { $set: { interestGraceDays: 60 } });
    expect((await get('/accounts/interest?asOf=2026-12-10')).body.groups).toEqual([]);
  });
});

describe('balance confirmations', () => {
  it('lists balances on the day, writes the letter, records sending and the reply', async () => {
    const { customer } = await customerWithInvoice();
    await customerWithInvoice({ invoiceDate: new Date('2026-11-20') });   // after the day: not in the balance
    const before = (await get('/accounts/confirmations?asOf=2026-10-31')).body;
    expect(before.rows).toEqual([expect.objectContaining({ partyType: 'customer', partyName: customer.name, balance: 105000, confirmation: null })]);
    expect(before.totals).toMatchObject({ parties: 1, none: 1, customers: 105000 });

    const made = await post('/accounts/confirmations', { asOf: '2026-10-31', all: true });
    expect(made.status).toBe(201);
    expect(made.body.made).toHaveLength(1);
    const c = made.body.made[0];
    expect(c.confirmationNo).toMatch(/^BC\/2026-27\/0001$/);
    expect(c.balance).toBe(105000);
    expect(c.openCount).toBe(1);
    expect((await post('/accounts/confirmations', { asOf: '2026-10-31', all: true })).body.skipped).toBe(1);

    const letter = (await get(`/accounts/confirmations/${c._id}/letter`)).body;
    expect(letter.text).toMatch(/balance in your account as on 31-10-2026 stands at ₹1,05,000.00 Dr/);
    expect(letter.text).toMatch(/receivable from you/);
    expect(letter.statement.rows).toHaveLength(1);
    expect(letter.statement.closing).toBe(105000);

    expect((await post(`/accounts/confirmations/${c._id}/send`, { channel: 'email', to: 'acc@ravi.in' })).status).toBe(409);   // no SMTP here
    const sent = await post(`/accounts/confirmations/${c._id}/send`, { channel: 'print' });
    expect(sent.body.confirmation.status).toBe('sent');
    expect(sent.body.confirmation.sent.channel).toBe('print');

    expect((await post(`/accounts/confirmations/${c._id}/reply`, { status: 'confirmed', theirBalance: 100000 })).status).toBe(400);
    const disputed = await post(`/accounts/confirmations/${c._id}/reply`, { status: 'disputed', theirBalance: 100000, note: 'They have not booked DN/… yet' });
    expect(disputed.body.confirmation.status).toBe('disputed');
    expect(disputed.body.confirmation.reply.difference).toBe(-5000);
    const after = (await get('/accounts/confirmations?asOf=2026-10-31')).body;
    expect(after.totals.disputed).toBe(1);
    expect(after.rows[0].confirmation.status).toBe('disputed');
  });
});
