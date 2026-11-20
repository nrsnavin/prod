'use strict';
// ══════════════════════════════════════════════════════════════════
//  BILLS, THE OPENING BALANCES, CUSTOMER MAIL, AND WHAT IS SENT OUT
//
//  Found reading api/accountsBills.js, accountsBooks.js,
//  accountsReaders.js and accountsDocs.js line by line.
//
//  1. A CANCELLED BILL WAS STILL "OUTSTANDING". The list and the bill's
//     own page gave what is left on it as its total less what was paid —
//     for a cancelled bill, all of it: "₹10,500.00 outstanding, 40 days
//     overdue" beside the word Cancelled.
//
//  2. "THANK YOU, WE HAVE RECEIVED…" FOR A CHEQUE THAT CAME BACK. The
//     WhatsApp draft for a voucher did not look at whether the voucher
//     still stood. A bounced cheque cancels its receipt; the button
//     stayed, and wrote the customer a thank-you for money that had
//     not come.
//
//  3. CUSTOMER MAIL WAITING, PAST THE TWO HUNDREDTH. The list is the
//     newest 200 mails, handled or not, and "N to look at" was counted
//     off it: an order mailed three weeks ago and never opened dropped
//     off both.
//
//  4. A service bill could be put under a head that does not exist (and
//     then is on no budget); a head renamed to another's name answered
//     "Duplicate key name Entered"; the opening balances' day could not
//     be today before 05:30; and an import whose sheet said "Party
//     Type" and "Bill Date" read the type as the party and the date as
//     the bill number.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supplier, customer, bank, n = 0;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: admin.role }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const clock = (at) => jest.useFakeTimers({ now: new Date(at), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
const DAY = 86_400_000;
const india = (offset = 0) => new Date(Date.now() + offset * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const x of ['User', 'Supplier', 'Customer', 'SupplierBill', 'ExpenseCategory', 'InboxMail', 'Payment', 'BankAccount', 'AccountNote']) M[x] = require(`../../models/${x}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'abd@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await get('/accounts/bank-accounts');
  bank = (await post('/accounts/bank-accounts', { name: 'Kotak CA', kind: 'bank' })).body.account;
  supplier = await M.Supplier.create({ name: 'Sri Dyers', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
  customer = await M.Customer.create({ name: 'Apex Garments', contactName: 'R', phoneNumber: '9677707535', paymentTerms: '30' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => jest.useRealTimers());

const bill = async (over = {}) => {
  n += 1;
  const res = await post('/accounts/bills', { supplier: supplier._id, supplierBillNo: `SD/${n}`, kind: 'service', billDate: india(-60), lines: [{ description: 'Dyeing', quantity: 1, rate: 10000, gstPercent: 5 }], ...over });
  return res;
};

// ══════════════════════════════════════════════════════════════════
describe('a cancelled bill', () => {
  it('has nothing outstanding on it: on the list and on its own page', async () => {
    const kept = (await bill()).body.bill;
    const gone = (await bill()).body.bill;
    expect((await post(`/accounts/bills/${gone._id}/cancel`, { reason: 'Entered twice by mistake' })).status).toBe(200);
    const list = Object.fromEntries((await get('/accounts/bills')).body.bills.map((b) => [b.billNo, b]));
    // Before: 10500 — the whole bill, "outstanding" and 30 days overdue.
    expect(list[gone.billNo]).toMatchObject({ status: 'cancelled', outstanding: 0 });
    expect(list[kept.billNo]).toMatchObject({ status: 'open', outstanding: 10500 });
    expect((await get(`/accounts/bills/${gone._id}`)).body.bill.outstanding).toBe(0);
    expect((await get(`/accounts/bills/${kept._id}`)).body.bill.outstanding).toBe(10500);
  });
});

describe('the head on a service bill', () => {
  it('is one that exists', async () => {
    const res = await bill({ category: String(new mongoose.Types.ObjectId()) });
    // Before: 201 — a cost on no head, and so on no budget.
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Category not found');
    const head = await M.ExpenseCategory.create({ name: 'Job work (bills)', ledger: 'Job Work' });
    const ok = await bill({ category: String(head._id) });
    expect(ok.status).toBe(201);
    expect(String(ok.body.bill.category)).toBe(String(head._id));
  });

  it('renamed to a name another head has is told so', async () => {
    const a = await M.ExpenseCategory.create({ name: 'Freight (test)' });
    const b = await M.ExpenseCategory.create({ name: 'Cartage (test)' });
    const res = await put(`/accounts/categories/${b._id}`, { name: a.name });
    // Before: 400 "Duplicate key name Entered".
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A category with that name exists');
    expect((await put(`/accounts/categories/${b._id}`, { name: 'Cartage and loading (test)' })).status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('telling a party about a voucher on WhatsApp', () => {
  const receipt = async (cheque) => {
    const res = await post('/accounts/payments', { kind: 'receipt', partyType: 'customer', customer: customer._id, amount: 50000, mode: cheque ? 'cheque' : 'bank', account: bank._id, date: india(-3), ...(cheque ? { cheque: { number: '000412', bank: 'SBI', date: india(-3) } } : { reference: 'UTR1' }) });
    expect(res.status).toBe(201);
    return res.body.payment || res.body.voucher;
  };

  it('a cheque that came back is not thanked for: the draft says it was returned', async () => {
    const v = await receipt(true);
    const back = await post(`/accounts/payments/${v._id}/cheque`, { action: 'bounced', on: india(0), reason: 'Funds insufficient' });
    expect(back.status).toBe(200);
    const draft = await post('/accounts/share/draft', { kind: 'payment', id: v._id });
    expect(draft.status).toBe(200);
    // Before: "Thank you — we have received ₹50,000.00 …".
    expect(draft.body.message).not.toMatch(/Thank you|we have received/);
    expect(draft.body.message).toMatch(/Your cheque 000412 for ₹50,000\.00 was returned by the bank/);
    expect(draft.body.message).toMatch(/Funds insufficient/);
    expect(draft.body.message).toMatch(new RegExp(`${v.voucherNo.replace(/[/]/g, '\\/')} is cancelled`));
    expect(draft.body.to).toBe('+919677707535');
  });

  it('a voucher cancelled for any other reason has nothing to say', async () => {
    const v = await receipt(false);
    expect((await post(`/accounts/payments/${v._id}/cancel`, { reason: 'Entered against the wrong customer' })).status).toBe(200);
    const draft = await post('/accounts/share/draft', { kind: 'payment', id: v._id });
    // Before: 200, thanking them for it.
    expect(draft.status).toBe(409);
    expect(draft.body.message).toMatch(/is cancelled/);
  });

  it('one that stands is thanked for as before (unchanged)', async () => {
    const v = await receipt(false);
    const draft = await post('/accounts/share/draft', { kind: 'payment', id: v._id });
    expect(draft.status).toBe(200);
    expect(draft.body.message).toMatch(/we have received ₹50,000\.00/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('customer mail once there is a lot of it', () => {
  beforeAll(async () => {
    const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY);
    const mail = (i, status, daysAgo) => ({ messageId: `m-${status}-${i}`, source: 'mail', from: `buyer${i}@apex.in`, subject: `Mail ${status} ${i}`, receivedAt: at(daysAgo), text: '', files: [], customerName: 'Apex Garments', kind: 'purchase_order', summary: '', status, note: '', createdAt: at(daysAgo), updatedAt: at(daysAgo) });
    await M.InboxMail.collection.insertMany([
      ...Array.from({ length: 205 }, (_, i) => mail(i, 'done', 1 + i / 20)),
      mail(1, 'new', 20), mail(2, 'new', 25),
      mail(1, 'dismissed', 2),
    ]);
  });

  it('still lists what nobody has looked at, and counts it', async () => {
    const res = await get('/accounts/customer-mail');
    const waiting = res.body.rows.filter((r) => r.status === 'new').map((r) => r.subject);
    // Before: neither — two hundred handled mails had come in since.
    expect(waiting).toEqual(['Mail new 1', 'Mail new 2']);
    expect(res.body.waiting).toBe(2);
    // The handled ones are still the newest two hundred, and the dismissed stay out.
    expect(res.body.rows.filter((r) => r.status === 'done')).toHaveLength(200);
    expect(res.body.rows.some((r) => r.status === 'dismissed')).toBe(false);
  });

  it('one kind asked for is that kind (unchanged)', async () => {
    const res = await get('/accounts/customer-mail?status=dismissed');
    expect(res.body.rows.map((r) => r.subject)).toEqual(['Mail dismissed 1']);
    expect(res.body.waiting).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the opening balances', () => {
  it('can be as on today from midnight, not from half past five', async () => {
    clock('2026-11-20T20:00:00Z');            // 01:30 on 21 November in India
    const today = await put('/accounts/opening-onboarding', { asOn: '2026-11-21' });
    // Before: 400 "The balances are as on a day already past".
    expect(today.status).toBe(200);
    expect((await put('/accounts/opening-onboarding', { asOn: '2026-11-22' })).status).toBe(400);
  });

  it('an import reads a sheet headed "Party Type" and "Bill Date" for what its columns are', async () => {
    const csv = 'Party Type,Party,Bill Date,Bill No,Amount,Dr/Cr\nCustomer,Apex Garments,12-03-2026,INV-1182,"48,500.00",Dr\nSupplier,Sri Dyers,20-03-2026,SD/0998,32150,Cr\n';
    const res = await request(app).post('/api/v2/accounts/opening-balances/import').set('Cookie', cookie()).attach('file', Buffer.from(csv), 'balances.csv');
    expect(res.status).toBe(200);
    // Before: every row "Customer is not a customer on file", its bill number the date.
    expect(res.body.problems).toBe(0);
    expect(res.body.rows[0]).toMatchObject({ partyType: 'customer', partyName: 'Apex Garments', refNo: 'INV-1182', date: '2026-03-12', amount: 48500, kind: 'due', problem: null });
    expect(res.body.rows[1]).toMatchObject({ partyType: 'supplier', partyName: 'Sri Dyers', refNo: 'SD/0998', amount: 32150, kind: 'due', problem: null });
  });

  it('the template\'s own headings are read as before (unchanged)', async () => {
    const csv = 'Type,Party,GSTIN,Ref,Date,Due date,Amount,Dr/Cr\nCustomer,Apex Garments,,INV-1,2026-03-12,2026-04-11,1000,Dr\n';
    const res = await request(app).post('/api/v2/accounts/opening-balances/import').set('Cookie', cookie()).attach('file', Buffer.from(csv), 'balances.csv');
    expect(res.body.rows[0]).toMatchObject({ partyType: 'customer', partyName: 'Apex Garments', refNo: 'INV-1', date: '2026-03-12', dueDate: '2026-04-11', amount: 1000, kind: 'due', problem: null });
  });
});
