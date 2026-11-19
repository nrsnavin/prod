'use strict';
// ══════════════════════════════════════════════════════════════════
//  A QUOTATION: WHO IT IS FOR, THE DAY IT IS DATED, AND WHEN IT HAS RUN OUT
//
//  Found reading api/quote.js and what reads it, line by line.
//
//  1. NO ADDRESS FROM THE CUSTOMER MASTER. The route said "the customer
//     master holds no address — it never has", and copied only the name,
//     GSTIN and phone. The master has carried the billing address, city
//     and pin code since challans and invoices began printing them. A
//     quotation for a customer picked from the list went out with a
//     blank address unless somebody typed it again.
//
//  2. THE QUOTE DATE WAS A MOMENT, NOT A DAY. With no date sent it was
//     "now" — and the financial year and the number were read off that
//     moment on the server's clock. A quote raised at half past midnight
//     on 1 April was numbered in the year that had just ended.
//
//  3. A VALID-UNTIL THAT WAS NOT A DATE WAS IGNORED. On a new quote it
//     silently became thirty days; on a reprice it was dropped and the
//     save reported success.
//
//  4. THE LIST NEVER SAID HOW MANY PAGES. The phone reads `pages`; with
//     none sent it took "1", and nothing past the first twenty quotes
//     could be reached from it.
//
//  5. "EXPIRED" WAS A FILTER THAT FOUND NOTHING. No screen sets that
//     status — the phone says outright that expiry "is a fact about the
//     date, not a decision" — and nothing sets it overnight. So the
//     phone's Expired chip was always empty, and the pricing history's
//     "expired" count was always nought, while quotes sent months ago
//     sat on "sent".
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const factoryDay = require('../../utils/factoryDay');

let mongo, app, Quote, User, admin;
const DAY = 86_400_000;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2/quote${url}`).set('Cookie', cookie());

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app   = require('../../app.js');
  Quote = require('../../models/Quote');
  User  = require('../../models/User');
  admin = await User.create({ name: 'Sales', email: 'quote-lapsed@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.useRealTimers();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const body = (over = {}) => ({
  customerName: 'Ravi Textiles',
  productName:  '20mm Woven Elastic',
  materials: [{ label: 'Warp yarn', weightGrams: 4.2, ratePerKg: 240 }],
  conversionCost: 1.25,
  marginPercent: 20,
  gstPercent: 5,
  quantityMetres: 5000,
  ...over,
});
const create = (over) => request(app).post('/api/v2/quote/create').set('Cookie', cookie()).send(body(over));

/** A customer on the books, as the customer form leaves one. */
async function customer(over = {}) {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('customers').insertOne({
    _id, name: 'Ravi Textiles', gstin: '33ABCDE1234F1Z5', phoneNumber: '9876543210', contactName: 'Ravi',
    address: '12 Mill Road', city: 'Tiruppur', pincode: '641604', status: 'Active', paymentTerms: '30', ...over,
  });
  return String(_id);
}

const today = () => factoryDay.calendarDay();
const dayFromToday = (n) => new Date(today().getTime() + n * DAY);
let seq = 0;
/** A quote already on file, costed at ₹4 a metre and priced at ₹5. */
function seed(over = {}) {
  seq += 1;
  return Quote.create({
    quoteNo: `QT-26/27-${String(seq).padStart(4, '0')}`, financialYear: '26/27', sequence: seq,
    date: dayFromToday(-40), validTill: dayFromToday(-10),
    customerName: 'Ravi Textiles', status: 'sent',
    lines: [{ productName: '20mm Woven Elastic', materials: [], totalCost: 4, rateBeforeTax: 5, quantityMetres: 1000, valueBeforeTax: 5000 }],
    grandTotal: 5250, totalQuantityMetres: 1000,
    ...over,
  });
}
const numbers = (res) => res.body.quotes.map((q) => q.quoteNo).sort();

// ══════════════════════════════════════════════════════════════════
describe('the address on a quote for a customer on the books', () => {
  it('comes from the customer master when none is typed', async () => {
    const id = await customer();
    const res = await create({ customer: id, customerName: '' });
    expect(res.status).toBe(201);
    // Before: "" — the route believed the master held no address.
    expect(res.body.quote.customerAddress).toBe('12 Mill Road, Tiruppur - 641604');
    expect(res.body.quote).toMatchObject({ customerName: 'Ravi Textiles', customerGstin: '33ABCDE1234F1Z5', customerPhone: '9876543210' });
  });

  it('an address typed on the quote is the one used', async () => {
    const id = await customer();
    const res = await create({ customer: id, customerAddress: 'Buying office, 4 Anna Salai, Chennai' });
    expect(res.body.quote.customerAddress).toBe('Buying office, 4 Anna Salai, Chennai');
  });

  it('is whatever the master has: a city alone, or nothing', async () => {
    const cityOnly = await customer({ address: '', pincode: '' });
    expect((await create({ customer: cityOnly })).body.quote.customerAddress).toBe('Tiruppur');

    const none = await customer({ address: '', city: '', pincode: '' });
    expect((await create({ customer: none })).body.quote.customerAddress).toBe('');
  });

  it('a quote for somebody not on the books keeps what was typed (unchanged)', async () => {
    const res = await create({ customerName: 'New Mills', customerAddress: 'Erode' });
    expect(res.body.quote).toMatchObject({ customerName: 'New Mills', customerAddress: 'Erode' });
    expect(res.body.quote.customer).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the day a quote is dated', () => {
  it('is today in India when no date is sent — a calendar day, like every other document', async () => {
    const q = (await create()).body.quote;
    // Before: the moment of the request, to the millisecond.
    expect(new Date(q.date).toISOString()).toBe(today().toISOString());
    expect(new Date(q.validTill).toISOString()).toBe(dayFromToday(30).toISOString());
  });

  it('half past midnight on 1 April is the new year, and numbered in it', async () => {
    // 00:30 on 1 April 2026 in India; still 31 March by the server's clock.
    jest.useFakeTimers({ now: new Date('2026-03-31T19:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] });
    const q = (await create()).body.quote;
    // Before: 25/26, QT-25/26-0001 — the year that had just ended.
    expect(q.financialYear).toBe('26/27');
    expect(q.quoteNo).toBe('QT-26/27-0001');
    expect(new Date(q.date).toISOString().slice(0, 10)).toBe('2026-04-01');
  });

  it('a date that is sent is that day (unchanged)', async () => {
    const q = (await create({ date: '2026-08-12', validTill: '2026-08-20' })).body.quote;
    expect(new Date(q.date).toISOString()).toBe('2026-08-12T00:00:00.000Z');
    expect(new Date(q.validTill).toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('a valid-until that is not a date is refused, not swapped for thirty days', async () => {
    const res = await create({ date: '2026-08-12', validTill: 'end of the month' });
    // Before: 201, valid until 11 September — a date nobody chose.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid.until/i);
    expect(await Quote.countDocuments()).toBe(0);
  });
});

describe('repricing a quote', () => {
  const update = (payload) => request(app).put('/api/v2/quote/update').set('Cookie', cookie()).send(payload);

  it('refuses a valid-until that is not a date instead of dropping it', async () => {
    const q = (await create({ date: '2026-08-12', validTill: '2026-08-20' })).body.quote;
    const res = await update({ id: q._id, auditReason: 'customer asked for longer', validTill: 'next month' });
    // Before: 200 "success", and the date had not moved.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/valid.until/i);
    const kept = await Quote.findById(q._id).lean();
    expect(kept.validTill.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(kept.fingerprints).toHaveLength(1);
  });

  it('takes a new valid-until as that day (unchanged)', async () => {
    const q = (await create({ date: '2026-08-12', validTill: '2026-08-20' })).body.quote;
    const res = await update({ id: q._id, auditReason: 'customer asked for longer', validTill: '2026-09-05' });
    expect(res.status).toBe(200);
    expect(new Date(res.body.quote.validTill).toISOString()).toBe('2026-09-05T00:00:00.000Z');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the list of quotes', () => {
  it('says how many pages there are', async () => {
    for (let i = 0; i < 25; i++) await seed();
    // Before: no `pages` at all; the phone took 1 and stopped at twenty.
    expect((await get('/list')).body).toMatchObject({ total: 25, page: 1, pages: 2 });
    expect((await get('/list?limit=10&page=3')).body).toMatchObject({ total: 25, page: 3, pages: 3 });
  });

  it('is one page when there is nothing', async () => {
    expect((await get('/list')).body).toMatchObject({ total: 0, pages: 1 });
  });
});

describe('the Expired filter', () => {
  let ranOut, draftRanOut, lastDay, markedExpired;
  beforeEach(async () => {
    ranOut        = await seed({ status: 'sent',  validTill: dayFromToday(-1) });
    draftRanOut   = await seed({ status: 'draft', validTill: dayFromToday(-1), customerName: 'Kumar Garments' });
    lastDay       = await seed({ status: 'sent',  validTill: dayFromToday(0) });      // good through today
    await seed({ status: 'accepted',  validTill: dayFromToday(-1) });                 // the customer said yes
    await seed({ status: 'declined',  validTill: dayFromToday(-1) });                 // and no
    await seed({ status: 'cancelled', validTill: dayFromToday(-1) });                 // withdrawn
    markedExpired = await seed({ status: 'expired', validTill: dayFromToday(7) });    // set through the API
  });

  it('lists what has run out with no answer — nobody sets that status by hand', async () => {
    const res = await get('/list?status=expired');
    // Before: only the one somebody had marked through the API.
    expect(numbers(res)).toEqual([ranOut.quoteNo, draftRanOut.quoteNo, markedExpired.quoteNo].sort());
    expect(res.body.total).toBe(3);
  });

  it('a quote is good through its last day', async () => {
    const res = await get('/list?status=expired');
    expect(numbers(res)).not.toContain(lastDay.quoteNo);
  });

  it('still narrows by what is searched for', async () => {
    const res = await get('/list?status=expired&search=kumar');
    expect(numbers(res)).toEqual([draftRanOut.quoteNo]);
    expect(res.body.total).toBe(1);
  });

  it('leaves the other filters as they were', async () => {
    expect(numbers(await get('/list?status=sent'))).toEqual([ranOut.quoteNo, lastDay.quoteNo].sort());
    expect((await get('/list')).body.total).toBe(7);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('pricing history', () => {
  it('says how many sent quotes ran out unanswered, and does not call them lost', async () => {
    await seed({ status: 'accepted' });
    await seed({ status: 'declined' });
    await seed({ status: 'sent',  validTill: dayFromToday(-1) });     // ran out, no answer recorded
    await seed({ status: 'sent',  validTill: dayFromToday(-20) });    // and another
    await seed({ status: 'sent',  validTill: dayFromToday(0) });      // still in play
    await seed({ status: 'draft', validTill: dayFromToday(-1) });     // never sent

    const res = await get('/win-loss');
    expect(res.status).toBe(200);
    // The rate is still of the quotes the customer answered.
    expect(res.body).toMatchObject({ quotes: 2, wins: 1, losses: 1, baselineWinRatePct: 50 });
    // Before: no such figure — those two were invisible to the history.
    expect(res.body.unanswered).toBe(2);
  });

  it('counts them for the customer asked about', async () => {
    const id = await customer();
    await seed({ status: 'sent', validTill: dayFromToday(-1), customer: id });
    await seed({ status: 'sent', validTill: dayFromToday(-1) });
    expect((await get(`/win-loss?customerId=${id}`)).body.unanswered).toBe(1);
    expect((await get('/win-loss')).body.unanswered).toBe(2);
  });

  it('is nought, not missing, when every sent quote has an answer', async () => {
    await seed({ status: 'accepted' });
    expect((await get('/win-loss')).body.unanswered).toBe(0);
  });
});
