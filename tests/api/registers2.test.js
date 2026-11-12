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
    expect(clr.body.payment.cheque.clearedOn).toBeTruthy();
    expect((await post(`/accounts/payments/${r.body.payment._id}/cheque`, { action: 'deposited' })).status).toBe(409);

    // A second cheque, dated today, is received and in hand like any other —
    // deposited into the bank it went to, on the day; then it comes back.
    const r2 = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 55000, mode: 'cheque', account: acct._id, cheque: { number: '000413', bank: 'Kotak' }, allocations: [{ docType: 'Invoice', doc: inv._id, amount: 55000 }] });
    expect(r2.body.payment.cheque).toMatchObject({ status: 'held', number: '000413' });
    expect(r2.body.payment.cheque.receivedOn).toBeTruthy();
    expect((await get('/accounts/pdc')).body.totals.dueToday).toMatchObject({ count: 1, amount: 55000 });
    const other = await bank();
    expect((await post(`/accounts/payments/${r2.body.payment._id}/cheque`, { action: 'deposited', account: 'nope' })).status).toBe(400);
    const dep2 = await post(`/accounts/payments/${r2.body.payment._id}/cheque`, { action: 'deposited', on: future(0), account: other._id });
    expect(dep2.status).toBe(200);
    expect(dep2.body.payment).toMatchObject({ account: String(other._id), accountName: other.name, cheque: { status: 'deposited' } });
    expect(dep2.body.payment.cheque.depositedOn).toBeTruthy();
    expect((await M.Invoice.findById(inv._id).lean()).paidAmount).toBe(105000);
    // One already banked when it is entered skips the drawer.
    const r3 = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 1, mode: 'cheque', account: acct._id, cheque: { number: '000414', deposited: true } });
    expect(r3.body.payment.cheque).toMatchObject({ status: 'deposited', number: '000414' });
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

  it('the days a note says it covers are checked on the server, not taken from the browser', async () => {
    const { customer, inv } = await customerWithInvoice();   // due 4 Nov
    const other = await customerWithInvoice();
    await put('/accounts/settings', { receivables: { interestRate: 18, graceDays: 0 } });
    const d = (await get(`/accounts/interest/draft?customer=${customer._id}&asOf=2026-12-04`)).body;
    expect((await post('/accounts/notes', d.body)).status).toBe(201);

    // The same note sent again charges the same days: refused. (Nothing stopped it.)
    const again = await post('/accounts/notes', d.body);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(new RegExp(`Interest on ${inv.invoiceNumber} was already charged from 05-11-2026 to 04-12-2026 by DN/`));
    // A day of overlap is refused; from the day after is the next note.
    const next = (from, to, extra = {}) => ({ ...d.body, date: to, reason: 'Interest on overdue invoices', lines: [{ description: `Interest on ${inv.invoiceNumber}`, quantity: 1, rate: 300, gstPercent: 5 }], interest: [{ invoice: inv._id, docNo: inv.invoiceNumber, from, to, rate: 18, amount: 300 }], ...extra });
    expect((await post('/accounts/notes', next('2026-12-04', '2026-12-10'))).status).toBe(409);
    const ok = await post('/accounts/notes', next('2026-12-05', '2026-12-10'));
    expect(ok.status).toBe(201);
    expect(ok.body.note.interest[0].days).toBe(6);   // counted from the dates, whatever was sent

    // Another customer's invoice; days before it fell due; days after the note's own date.
    const theirs = await post('/accounts/notes', next('2026-12-11', '2026-12-20', { interest: [{ invoice: other.inv._id, from: '2026-12-11', to: '2026-12-20', amount: 300 }] }));
    expect(theirs.status).toBe(400);
    expect(theirs.body.message).toMatch(/belongs to another customer/);
    const early = await post('/accounts/notes', next('2026-11-01', '2026-11-03'));
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/fell due on 04-11-2026 — interest runs from the day after/);
    const late = await post('/accounts/notes', next('2026-12-11', '2026-12-25', { date: '2026-12-20' }));
    expect(late.status).toBe(400);
    expect(late.body.message).toMatch(/after the note's own date/);
    // Two notes for the same days sent together: one.
    const both = await Promise.all([post('/accounts/notes', next('2026-12-11', '2026-12-31')), post('/accounts/notes', next('2026-12-11', '2026-12-31'))]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await M.AccountNote.countDocuments({ 'interest.0': { $exists: true }, status: 'issued' })).toBe(3);
    // A cancelled note's days can be charged again.
    expect((await post(`/accounts/notes/${ok.body.note._id}/cancel`, { reason: 'Charged at the wrong rate' })).status).toBe(200);
    expect((await post('/accounts/notes', next('2026-12-05', '2026-12-10'))).status).toBe(201);
  });

  it('worked from each payment\'s date when the books say so: an invoice paid late is charged for its lateness', async () => {
    const { customer, inv } = await customerWithInvoice({ invoiceDate: new Date('2026-06-05'), dueDate: new Date('2026-07-05') });   // ₹1,05,000 due 5 Jul
    const acct = await bank();
    const pay = (amount, date) => post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount, mode: 'bank', account: acct._id, date, allocations: [{ docType: 'Invoice', doc: inv._id, amount }] });
    expect((await pay(50000, '2026-08-04')).status).toBe(201);   // 30 days late
    expect((await pay(55000, '2026-09-05')).status).toBe(201);   // 62 days late
    expect((await put('/accounts/settings', { receivables: { interestRate: 18, graceDays: 0 } })).status).toBe(200);

    // On today's balance — how it is worked unless the books say otherwise — a paid invoice bears nothing.
    const onBalance = (await get('/accounts/interest?asOf=2026-09-30')).body;
    expect(onBalance.settings.basis).toBe('balance');
    expect(onBalance.groups).toEqual([]);

    expect((await put('/accounts/settings', { receivables: { interestBasis: 'sometimes' } })).status).toBe(400);
    expect((await put('/accounts/settings', { receivables: { interestBasis: 'payments' } })).body.settings.receivables.interestBasis).toBe('payments');
    const i = (await get('/accounts/interest?asOf=2026-09-30')).body;
    expect(i.settings.basis).toBe('payments');
    const row = i.groups[0].rows[0];
    expect(row).toMatchObject({ docNo: inv.invoiceNumber, outstanding: 0, rate: 18 });
    expect(row.parts.map((p) => [p.amount, p.days])).toEqual([[50000, 30], [55000, 62]]);
    // 50,000 × 18% × 30/365 + 55,000 × 18% × 62/365
    expect(row.interest).toBe(2421.37);

    // Grace: a part paid within the grace days bears nothing; one paid after bears from the due date.
    await M.Customer.updateOne({ _id: customer._id }, { $set: { interestGraceDays: 45 } });
    const g = (await get('/accounts/interest?asOf=2026-09-30')).body.groups[0].rows[0];
    expect(g.parts.map((p) => [p.amount, p.days])).toEqual([[55000, 62]]);
    expect(g.interest).toBe(1681.64);
    await M.Customer.updateOne({ _id: customer._id }, { $unset: { interestGraceDays: '' } });

    // The note it drafts says what was charged, and its days are not charged again.
    const d = (await get(`/accounts/interest/draft?customer=${customer._id}&asOf=2026-09-30`)).body;
    expect(d.body.lines[0].description).toMatch(/₹50000\.00 × 30 days, ₹55000\.00 × 62 days/);
    expect(d.body.lines[0].rate).toBe(2421.37);
    const note = await post('/accounts/notes', d.body);
    expect(note.status).toBe(201);
    const later = (await get('/accounts/interest?asOf=2026-10-10')).body.groups[0].rows[0];
    // Only the note's own amount, unpaid for ten days since it was raised.
    expect(later.parts).toEqual([expect.objectContaining({ amount: note.body.note.totals.grand, days: 10 })]);
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
