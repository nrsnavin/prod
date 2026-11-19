'use strict';
// ══════════════════════════════════════════════════════════════════
//  AN EXPENSE CLAIM: WHOSE IT IS, WHAT DAY IT IS FOR, AND WHAT IS OWED
//
//  Found reading api/claims.js line by line.
//
//  1. ANOTHER PERSON'S EXPENSE, HANDED BACK AS "YOURS". A request id is
//     unique across every expense. Filing with one somebody else had
//     used was meant to be a clash (409) — the comment says so. But the
//     options that keep a replay to "this person's own claim" were a
//     local of the route, and the function that files the claim used a
//     different thing of the same name (a helper function). So the
//     lookup had no filter and no field list: the other person's
//     expense came back whole — lines, notes, audit trail — marked
//     `replay: true`, and the phone showed "claim sent" for a claim that
//     was never made.
//
//  2. A RECEIPT WITH NO NUMBER AND NO DATE WAS A SERVER ERROR. The
//     "claimed before?" check was an $or of the ways to recognise the
//     receipt; with neither to go on the $or was empty, which the
//     database refuses. A toll slip or a tea bill is exactly that.
//
//  3. TOMORROW WAS NOT "THE FUTURE". The date was compared with the
//     clock plus a day, so a claim dated tomorrow always went in — and
//     was counted against tomorrow's cap. A day is compared with a day.
//
//  4. WHAT IS OWED WAS ADDED UP FROM THE NEWEST 60. The list shows 60;
//     the totals above it were worked out from those same rows, so an
//     approved claim further back than that was not money owed.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockReadBill = jest.fn();
jest.mock('../../utils/billOcr', () => ({ readBill: (...a) => mockReadBill(...a) }));

let mongo, app, admin, ravi, kumar, fuel, factoryDay;
const M = {};
const DAY = 86_400_000;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const get = (url, u) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u));
const scan = (u) => request(app).post('/api/v2/claims/scan').set('Cookie', cookie(u))
  .attach('file', Buffer.from('fake-image'), { filename: 'p.jpg', contentType: 'image/jpeg' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  factoryDay = require('../../utils/factoryDay');
  for (const n of ['User', 'Expense', 'ExpenseCategory']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'cl-own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  ravi  = await M.User.create({ name: 'Ravi', email: 'cl-ravi@t.co', password: 'pass1234', role: 'production', department: 'production' });
  kumar = await M.User.create({ name: 'Kumar', email: 'cl-kumar@t.co', password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
  mockReadBill.mockReset();
});
beforeEach(async () => {
  await get('/accounts/categories', admin);                        // seeds the heads
  fuel = await M.ExpenseCategory.findOne({ name: /transport/i });
});

const today = () => factoryDay.calendarDay();
const ymd = (d) => d.toISOString().slice(0, 10);
const claim = (u, over = {}) => post('/claims', {
  category: String(fuel._id), description: 'Diesel for the genset', amount: 800, date: ymd(today()), ...over,
}, u);

let seq = 0;
/** A claim on file, as it would be once made. */
const onFile = (u, over = {}) => {
  seq += 1;
  const grand = over.grand ?? 500;
  return M.Expense.create({
    expenseNo: `EXP/T/${String(seq).padStart(4, '0')}`, financialYear: '2026-27', sequence: 9000 + seq,
    date: over.date || today(), category: fuel._id, categoryName: fuel.name, description: `Claim ${seq}`,
    payeeName: u.name, claimant: { user: u._id, name: u.name }, source: 'claim',
    totals: { taxable: grand, cgst: 0, sgst: 0, igst: 0, tax: 0, roundOff: 0, grand },
    status: over.status || 'pending', paidAmount: over.paidAmount || 0,
  });
};

// ══════════════════════════════════════════════════════════════════
describe('a request id somebody else has used', () => {
  it('is a clash — not their expense handed back as yours', async () => {
    const theirs = await claim(ravi, { requestId: 'req-shared-1', description: 'Ravi: diesel, private note', note: 'for the night shift genset' });
    expect(theirs.status).toBe(201);

    const res = await claim(kumar, { requestId: 'req-shared-1', description: 'Kumar: toll at Avinashi', amount: 120 });
    // Before: 200, `replay: true`, and Ravi's expense — whole.
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/request id is already used/i);
    expect(res.body.claim).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/Ravi|night shift/);
    expect(await M.Expense.countDocuments({ 'claimant.user': kumar._id })).toBe(0);
  });

  it('is a replay for the one who used it: the same claim, once (unchanged)', async () => {
    const first = await claim(ravi, { requestId: 'req-ravi-1' });
    const again = await claim(ravi, { requestId: 'req-ravi-1' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replay: true, claim: { _id: first.body.claim._id, expenseNo: first.body.claim.expenseNo } });
    expect(await M.Expense.countDocuments()).toBe(1);
  });

  it('two of the same sent together make one claim, and both are answered with it', async () => {
    const [a, b] = await Promise.all([claim(ravi, { requestId: 'req-ravi-2' }), claim(ravi, { requestId: 'req-ravi-2' })]);
    expect(await M.Expense.countDocuments()).toBe(1);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const replayed = a.status === 200 ? a : b;
    expect(replayed.body.replay).toBe(true);
    // What a claimant is shown of a claim — not the stored document.
    // Before: the whole record, audit trail and all.
    expect(replayed.body.claim.expenseNo).toBe((a.status === 201 ? a : b).body.claim.expenseNo);
    expect(replayed.body.claim.fingerprints).toBeUndefined();
    expect(replayed.body.claim.lines).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('reading a receipt', () => {
  const receipt = (over = {}) => ({
    kind: 'receipt', problem: null, supplierName: 'NH Toll Plaza', supplierGstin: '', billNo: '', billDate: null,
    lines: [{ description: 'Toll', quantity: 1, rate: 120, amount: 120 }], totals: { grand: 120 },
    confidence: 0.8, model: 'v', usage: {}, latencyMs: 5, ...over,
  });

  it('with no number and no date on it is still a claim to fill in', async () => {
    mockReadBill.mockResolvedValue(receipt());
    const res = await scan(ravi);
    // Before: 500 — an empty $or.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ problem: null, alreadyClaimed: null, draft: { amount: 120, date: null, refNo: '' } });
  });

  it('with no number and no date is not "claimed before" because something else once was', async () => {
    // An earlier claim that has nothing to do with this slip.
    const earlier = await claim(ravi, { amount: 960, date: ymd(new Date(today().getTime() - 9 * DAY)), refNo: 'IO/551', description: 'Diesel 10 L' });
    expect(earlier.status).toBe(201);

    mockReadBill.mockResolvedValue(receipt());
    const res = await scan(ravi);
    expect(res.status).toBe(200);
    // Before: "already claimed as <the diesel claim>" — with nothing to
    // recognise the receipt by, every earlier claim matched.
    expect(res.body.alreadyClaimed).toBeNull();
  });

  it('with nothing readable but the name is too', async () => {
    mockReadBill.mockResolvedValue(receipt({ lines: [], totals: {} }));
    const res = await scan(ravi);
    expect(res.status).toBe(200);
    expect(res.body.draft).toMatchObject({ amount: null, date: null });
    expect(res.body.alreadyClaimed).toBeNull();
  });

  it('says when the same receipt was claimed before: by its number, or its amount that day (unchanged)', async () => {
    const day = ymd(new Date(today().getTime() - 3 * DAY));
    const filed = await claim(ravi, { amount: 120, date: day, refNo: 'TP/881', description: 'Toll at Avinashi' });
    expect(filed.status).toBe(201);

    mockReadBill.mockResolvedValue(receipt({ billNo: 'TP/881', billDate: day }));
    expect((await scan(ravi)).body.alreadyClaimed).toBe(filed.body.claim.expenseNo);

    mockReadBill.mockResolvedValue(receipt({ billNo: '', billDate: day }));
    expect((await scan(ravi)).body.alreadyClaimed).toBe(filed.body.claim.expenseNo);

    // Somebody else's claim of the same amount that day is not "claimed before".
    expect((await scan(kumar)).body.alreadyClaimed).toBeNull();
    // Nor is the same amount on another day.
    mockReadBill.mockResolvedValue(receipt({ billNo: '', billDate: ymd(new Date(today().getTime() - 2 * DAY)) }));
    expect((await scan(ravi)).body.alreadyClaimed).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the day a claim is for', () => {
  it('is not tomorrow', async () => {
    const tomorrow = ymd(new Date(today().getTime() + DAY));
    const res = await claim(ravi, { date: tomorrow });
    // Before: 201 — "the future" began the day after tomorrow.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/future/i);
    expect(await M.Expense.countDocuments()).toBe(0);
  });

  it('is today, or any day before (unchanged)', async () => {
    expect((await claim(ravi, { date: ymd(today()) })).status).toBe(201);
    expect((await claim(ravi, { date: ymd(new Date(today().getTime() - 5 * DAY)), description: 'Diesel last week' })).status).toBe(201);
    // No date sent: today.
    const res = await claim(ravi, { date: undefined, description: 'Diesel, no date given', amount: 50 });
    expect(res.status).toBe(201);
    expect(new Date(res.body.claim.date).toISOString()).toBe(today().toISOString());
  });

  it('is a date (unchanged)', async () => {
    expect((await claim(ravi, { date: 'yesterday' })).status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what is owed, and what is waiting', () => {
  it('is added up from every claim — not only the 60 on the list', async () => {
    // An approved claim, part paid, from long ago…
    await onFile(ravi, { status: 'approved', grand: 2500, paidAmount: 500, date: new Date(today().getTime() - 200 * DAY) });
    // …a pending one from then too…
    await onFile(ravi, { status: 'pending', grand: 300, date: new Date(today().getTime() - 199 * DAY) });
    // …and 60 since, all settled.
    for (let i = 0; i < 60; i++) await onFile(ravi, { status: 'paid', grand: 100, paidAmount: 100, date: new Date(today().getTime() - (i + 1) * DAY) });
    // Somebody else's is not Ravi's money.
    await onFile(kumar, { status: 'approved', grand: 900 });

    const res = await get('/claims', ravi);
    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(60);
    // Before: 0 and 0 — both were further back than the list goes.
    expect(res.body.owed).toBe(2000);
    expect(res.body.waiting).toBe(300);
  });

  it('counts neither a rejected nor a withdrawn claim (unchanged)', async () => {
    await onFile(ravi, { status: 'rejected', grand: 400 });
    await onFile(ravi, { status: 'cancelled', grand: 400 });
    await onFile(ravi, { status: 'approved', grand: 250 });
    await onFile(ravi, { status: 'pending', grand: 150 });
    expect((await get('/claims', ravi)).body).toMatchObject({ owed: 250, waiting: 150 });
    expect((await get('/claims', kumar)).body).toMatchObject({ owed: 0, waiting: 0, claims: [] });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a claim is its claimant\'s', () => {
  it('to see, and to withdraw while it waits (unchanged)', async () => {
    const mine = await claim(ravi);
    const id = mine.body.claim._id;
    expect((await get(`/claims/${id}`, ravi)).status).toBe(200);
    expect((await get(`/claims/${id}`, kumar)).status).toBe(404);
    expect((await post(`/claims/${id}/withdraw`, {}, kumar)).status).toBe(404);

    const gone = await post(`/claims/${id}/withdraw`, {}, ravi);
    expect(gone.status).toBe(200);
    expect(gone.body.claim.status).toBe('cancelled');
    expect((await post(`/claims/${id}/withdraw`, {}, ravi)).status).toBe(409);
    expect((await get('/claims/not-an-id', ravi)).status).toBe(404);
  });
});
