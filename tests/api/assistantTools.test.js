'use strict';
// ══════════════════════════════════════════════════════════════════
//  ASK JARVIS: WHO MAY ASK WHAT, AND WHAT THE MODEL IS HANDED
//
//  Found reading api/assistant.js line by line.
//
//  1. A LOGIN WITH NO FEATURE LIST GOT EVERY TOOL. A list narrows the
//     tools; with no list at all (an account from before the lists, the
//     owner's) the tools were "left to the role gate" — and Ask Jarvis
//     has none: it is open to every login. A production login of that
//     kind, shut out of /accounts by its role, was told the bank
//     balances and any customer's statement for the asking.
//
//  2. DATES WITHOUT A YEAR. Invoices, bills and statement rows went to
//     the model as String(date).slice(0, 10): "Sat Oct 03".
//
//  3. "PENDING" WAS WHAT HAD NOT BEEN PLANNED. Orders at risk, and an
//     order looked up by number, reported pendingElastic — what no job
//     has been raised for — as the metres pending: an order planned in
//     full, with nothing made, had none. And an order due today was
//     "overdue" from half past five that morning.
//
//  4. Materials to reorder listed retired ones; "last month" for the
//     closing checklist was the server's; an account with no active
//     flag on it was left out of the cash position.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockCreate = jest.fn();
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: (...a) => mockCreate(...a) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, floor, clerk, narrowed;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body, u = admin) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body);
const clock = (at) => jest.useFakeTimers({ now: new Date(at), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });

/**
 * One question in which the model calls `tool`: what it was offered, and
 * what the tool handed back to it.
 */
async function ask(user, tool, input = {}) {
  mockCreate.mockReset();
  mockCreate
    .mockResolvedValueOnce({ stop_reason: 'tool_use', usage: {}, content: [{ type: 'tool_use', id: 'tu1', name: tool, input }] })
    .mockResolvedValueOnce({ stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Done.' }] });
  const res = await post('/assistant/chat', { messages: [{ role: 'user', content: 'A question' }] }, user);
  const offered = (mockCreate.mock.calls[0][0].tools || []).map((t) => t.name);
  const sent = mockCreate.mock.calls[0][0].messages;       // the one list, added to as the answer is built
  const back = sent[sent.length - 1].content[0];
  return { status: res.status, offered, result: JSON.parse(back.content) };
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'Order', 'RawMaterial', 'BankAccount', 'Machine']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ast@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  // Logins from before the feature lists: a role, and no list.
  floor = await M.User.create({ name: 'Floor', email: 'ast-floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
  clerk = await M.User.create({ name: 'Clerk', email: 'ast-clerk@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
  // And one with a list, narrowed to orders.
  narrowed = await M.User.create({ name: 'Orders only', email: 'ast-orders@t.co', password: 'pass1234', role: 'accounts', department: 'finance', features: ['/orders'] });
  await request(app).get('/api/v2/accounts/bank-accounts').set('Cookie', cookie(admin));   // seeds the accounts
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.useRealTimers();
  for (const name of ['orders', 'rawmaterials', 'supplierbills', 'partyledgerentries', 'suppliers', 'customers']) await mongoose.connection.collection(name).deleteMany({});
});

const BOOKS = ['get_receivables', 'get_payables', 'get_party_statement', 'get_expense_summary', 'get_cash_position', 'get_cash_forecast', 'get_close_checklist'];
const NO = { error: "You don't have access to this feature." };

// ══════════════════════════════════════════════════════════════════
describe('what a login may ask Jarvis is what its role may open', () => {
  it('none of the lists were set up: the floor is not told the bank balance', async () => {
    expect(floor.features).toBeUndefined();
    const r = await ask(floor, 'get_cash_position');
    expect(r.status).toBe(200);
    // Before: every account and its balance.
    expect(r.result).toEqual(NO);
    for (const t of [...BOOKS, 'get_orders_at_risk', 'find_order']) expect(r.offered).not.toContain(t);
    // What production may open over the API it may ask about.
    expect(r.offered).toEqual(expect.arrayContaining(['get_wastage_summary', 'get_machine_status', 'find_material', 'get_materials_to_reorder']));
  });

  it('nor a customer\'s statement, nor the orders', async () => {
    expect((await ask(floor, 'get_party_statement', { name: 'Apex' })).result).toEqual(NO);
    expect((await ask(floor, 'get_orders_at_risk')).result).toEqual(NO);
    expect((await ask(floor, 'get_receivables')).result).toEqual(NO);
  });

  it('accounts, likewise, is not told about the looms — and keeps the books', async () => {
    const r = await ask(clerk, 'get_machine_status');
    expect(r.result).toEqual(NO);
    expect(r.offered).not.toContain('get_wastage_summary');
    expect(r.offered).toEqual(expect.arrayContaining([...BOOKS, 'get_orders_at_risk', 'find_order', 'find_material']));
    expect(Array.isArray((await ask(clerk, 'get_cash_position')).result)).toBe(true);
  });

  it('the owner keeps everything (unchanged)', async () => {
    const r = await ask(admin, 'get_machine_status');
    expect(r.result).toHaveProperty('summary');
    expect(r.offered).toEqual(expect.arrayContaining([...BOOKS, 'get_orders_at_risk', 'get_wastage_summary', 'get_machine_status', 'find_material']));
  });

  it('a list still narrows inside the role (unchanged)', async () => {
    const r = await ask(narrowed, 'get_cash_position');
    expect(r.result).toEqual(NO);
    expect(r.offered.filter((t) => t !== 'run_report').sort()).toEqual(['find_order', 'get_orders_at_risk']);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what the model is handed', () => {
  it('dates are days with their year, not "Sat Oct 03"', async () => {
    const s = await M.Supplier.create({ name: 'Sri Yarns', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
    const bill = await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'SY/118', kind: 'service', billDate: '2026-10-03', lines: [{ description: 'Dyeing', quantity: 1, rate: 10000, gstPercent: 5 }] });
    expect(bill.status).toBe(201);
    const pay = (await ask(admin, 'get_payables')).result;
    // Before: "Sat Oct 03".
    expect(pay.bySupplier[0].bills[0]).toMatchObject({ theirNo: 'SY/118', date: '2026-10-03', outstanding: 10500 });
    const st = (await ask(admin, 'get_party_statement', { name: 'sri yarns', partyType: 'supplier', days: 3650 })).result;
    expect(st.party).toBe('Sri Yarns');
    expect(st.rows.length).toBeGreaterThan(0);
    for (const row of st.rows) expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(st.rows[0].date).toBe('2026-10-03');
  });

  describe('orders at risk', () => {
    const el = new mongoose.Types.ObjectId();
    let cust;
    const order = (orderNo, supplyDate, over = {}) => ({
      orderNo, customer: cust._id, status: 'InProgress', date: new Date('2026-11-01T00:00:00Z'), supplyDate,
      elasticOrdered: [{ elastic: el, quantity: 5000 }], producedElastic: [], packedElastic: [], pendingElastic: [], createdAt: new Date(), updatedAt: new Date(), ...over,
    });
    beforeEach(async () => {
      clock('2026-11-20T04:30:00Z');          // ten in the morning on 20 November, in India
      cust = await M.Customer.create({ name: 'Apex Garments', contactName: 'R', phoneNumber: '9300000002', paymentTerms: '30' });
      await M.Order.collection.insertMany([
        // Planned onto jobs in full, nothing packed, due today.
        order(41, new Date('2026-11-20T00:00:00Z')),
        // Due yesterday, a fifth packed, some of the rest not planned.
        order(42, new Date('2026-11-19T00:00:00Z'), { packedElastic: [{ elastic: el, quantity: 1000 }], pendingElastic: [{ elastic: el, quantity: 1500 }] }),
        // Packed in full, not yet closed: nothing owed.
        order(43, new Date('2026-11-21T00:00:00Z'), { packedElastic: [{ elastic: el, quantity: 5000 }] }),
        // Not approved yet, and due in the week: still a promise.
        order(44, new Date('2026-11-24T00:00:00Z'), { status: 'Open', pendingElastic: [{ elastic: el, quantity: 5000 }] }),
        // Far off.
        order(45, new Date('2027-01-15T00:00:00Z')),
        // Cancelled with nothing sent: it owes nobody anything.
        order(46, new Date('2026-11-18T00:00:00Z'), { status: 'Cancelled', pendingElastic: [{ elastic: el, quantity: 5000 }] }),
      ]);
    });

    it('count what the customer is still owed, and call late only what is past its day', async () => {
      const rows = (await ask(admin, 'get_orders_at_risk', { horizonDays: 7 })).result;
      const by = Object.fromEntries(rows.map((r) => [r.orderNo, r]));
      expect(Object.keys(by).sort()).toEqual(['41', '42', '44']);
      // Before: pendingMeters 0 (it is all planned), and overdue: true (it is past 05:30).
      expect(by[41]).toMatchObject({ customer: 'Apex Garments', supplyDate: '2026-11-20', daysToSupply: 0, overdue: false, pendingMeters: 5000, notPlannedMeters: 0 });
      expect(by[42]).toMatchObject({ supplyDate: '2026-11-19', daysToSupply: -1, overdue: true, pendingMeters: 4000, notPlannedMeters: 1500 });
      expect(by[44]).toMatchObject({ status: 'Open', daysToSupply: 4, overdue: false, pendingMeters: 5000, notPlannedMeters: 5000 });
      // The soonest first.
      expect(rows.map((r) => r.orderNo)).toEqual([42, 41, 44]);
    });

    it('an order looked up by its number says the same', async () => {
      const o = (await ask(admin, 'find_order', { orderNo: 42 })).result;
      // Before: pending 1500 — what had not been planned.
      expect(o).toMatchObject({ orderNo: 42, status: 'InProgress', customer: 'Apex Garments', supplyDate: '2026-11-19', ordered: 5000, pending: 4000, notPlanned: 1500 });
      expect((await ask(admin, 'find_order', { orderNo: 43 })).result).toMatchObject({ ordered: 5000, pending: 0 });
      expect((await ask(admin, 'find_order', { orderNo: 46 })).result).toMatchObject({ status: 'Cancelled', ordered: 5000, pending: 0, notPlanned: 0 });
      expect((await ask(admin, 'find_order', { orderNo: 999 })).result).toEqual({ error: 'No order #999' });
    });
  });

  it('materials to reorder are materials still in use', async () => {
    await M.RawMaterial.collection.insertMany([
      { name: 'Polyester 150D', category: 'yarn', stock: 20, minStock: 100, archived: false },
      { name: 'Polyester 150D (old)', category: 'yarn', stock: 0, minStock: 100, archived: true },
      { name: 'Rubber 42s', category: 'rubber', stock: 500, minStock: 100 },
    ]);
    const rows = (await ask(admin, 'get_materials_to_reorder')).result;
    // Before: the retired one too, with a quantity to buy.
    expect(rows.map((m) => m.name)).toEqual(['Polyester 150D']);
    // Looked up by name, a retired material says that it is one.
    const found = (await ask(admin, 'find_material', { query: 'polyester' })).result;
    expect(found.find((m) => m.name === 'Polyester 150D (old)')).toMatchObject({ retired: true });
    expect(found.find((m) => m.name === 'Polyester 150D')).toMatchObject({ retired: false, low: true });
  });

  it('the closing checklist with no month asked is last month in India', async () => {
    clock('2026-11-30T20:00:00Z');            // 01:30 on 1 December in India
    // Before: October — the month before the server's own.
    expect((await ask(admin, 'get_close_checklist')).result.month).toBe('2026-11');
    expect((await ask(admin, 'get_close_checklist', { month: '2026-13' })).result.month).toBe('2026-11');
    expect((await ask(admin, 'get_close_checklist', { month: '2026-08' })).result.month).toBe('2026-08');
  });

  it('the cash position has every account that was not closed', async () => {
    await M.BankAccount.collection.insertOne({ name: 'Old SBI CA', kind: 'bank', openingBalance: 0, createdAt: new Date(), updatedAt: new Date() });
    const closed = await M.BankAccount.create({ name: 'Closed ICICI', kind: 'bank', active: false });
    const names = (await ask(admin, 'get_cash_position')).result.map((a) => a.account);
    // Before: left out — it has no "active" on it at all.
    expect(names).toContain('Old SBI CA');
    expect(names).not.toContain(closed.name);
  });
});
