'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHO RAISED THE CREDIT LIMIT, AND WHO WROTE THE YARN OFF
//
//  Found reading api/customer.js line by line, and following "who
//  changed this?" into the weekly list of changes worth a second look
//  (services/auditWatch.js).
//
//  1. A CUSTOMER'S CREDIT TERMS CHANGED WITHOUT A TRACE. The credit
//     limit and the days of overdue allowed are what hold an order, a
//     challan or an invoice back; releasing one hold takes an admin and
//     a written reason, kept on the document. Raising the LIMIT took
//     neither, and left nothing: no line anywhere said the limit had
//     been ₹5 lakh on Monday and ₹15 lakh on Tuesday, or who made it so.
//
//  2. STOCK WRITTEN OFF BY HAND WAS NOT ON THE WEEKLY LIST. "Stock"
//     there meant a count posted or elastic adjusted. Raw material
//     adjusted by hand — the ordinary way yarn leaves the books without
//     an order — was not looked at.
//
//  3. THE CUSTOMER'S PAGE LISTED DELETED ORDERS among the recent ones.
//
//  4. A NAME OF NOTHING BUT SPACES WAS A NAME. The model's "min" and
//     "max" on text fields are number rules and checked nothing.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
const M = {};
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const call = (method, url, body) => {
  const r = request(app)[method](`/api/v2${url}`).set('Cookie', cookie());
  return body === undefined ? r : r.send(body);
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Customer', 'AccessEvent', 'Order', 'Elastic', 'RawMaterial', 'Supplier']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'credit-terms@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
const customer = (over = {}) => M.Customer.create({
  name: `Acme ${++seq}`, contactName: 'R', phoneNumber: '9000000002',
  creditLimit: 500000, maxOverdueDays: 30, paymentTerms: '30', ...over,
});
/** What the form sends: every field it shows, changed or not. */
const formOf = (c, change = {}) => ({
  _id: String(c._id), name: c.name, contactName: c.contactName, phoneNumber: c.phoneNumber,
  creditLimit: c.creditLimit, maxOverdueDays: c.maxOverdueDays, paymentTerms: c.paymentTerms, ...change,
});
const trail = () => M.AccessEvent.find({ code: 'CREDIT_TERMS_CHANGED' }).sort({ at: 1 }).lean();
const watch = async () => require('../../services/auditWatch').watch({ days: 7, now: new Date(Date.now() + 60_000) });

// ══════════════════════════════════════════════════════════════════
describe('changing a customer\'s credit terms', () => {
  it('is kept: what it was, what it is now, and who', async () => {
    const c = await customer();
    const res = await call('put', '/customer/update', formOf(c, { creditLimit: 1500000, maxOverdueDays: 90 }));
    expect(res.status).toBe(200);

    const rows = await trail();
    // Before: nothing, anywhere.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      label: 'Credit Terms Changed',
      subject: { id: String(c._id), name: c.name },
      meta: { changes: { creditLimit: { from: 500000, to: 1500000 }, maxOverdueDays: { from: 30, to: 90 } } },
    });
    expect(rows[0].actor.name).toBe('Owner');
    expect(Object.keys(rows[0].meta.changes)).toEqual(['creditLimit', 'maxOverdueDays']);
  });

  it('keeps the payment terms and the interest terms too', async () => {
    const c = await customer();
    await call('put', '/customer/update', formOf(c, { paymentTerms: '60', interestRate: 18, interestGraceDays: 15 }));
    expect((await trail())[0].meta.changes).toEqual({
      paymentTerms: { from: '30', to: '60' },
      interestRate: { from: null, to: 18 },
      interestGraceDays: { from: null, to: 15 },
    });
  });

  it('a save that changes none of them writes nothing', async () => {
    const c = await customer();
    // The same figures as the form sends them: text for a number is not a change.
    const res = await call('put', '/customer/update', formOf(c, { contactName: 'Ravi', creditLimit: '500000', maxOverdueDays: '30' }));
    expect(res.status).toBe(200);
    expect(await trail()).toEqual([]);
  });

  it('a save that is refused writes nothing', async () => {
    const c = await customer();
    const stale = await call('put', '/customer/update', { ...formOf(c, { creditLimit: 1500000 }), expectedVersion: 99 });
    expect(stale.status).toBe(409);
    const bad = await call('put', '/customer/update', formOf(c, { creditLimit: -5 }));
    expect(bad.status).toBe(400);
    expect(await trail()).toEqual([]);
    expect((await M.Customer.findById(c._id).lean()).creditLimit).toBe(500000);
  });

  it('can be read back on the customer, newest first, with the terms as they stand', async () => {
    const c = await customer({ name: 'Sri Lakshmi Garments' });
    await call('put', '/customer/update', formOf(c, { creditLimit: 800000 }));
    const then = await M.Customer.findById(c._id).lean();
    await call('put', '/customer/update', formOf(then, { creditLimit: 1500000, paymentTerms: '45' }));

    const res = await call('get', `/customer/${c._id}/credit-terms`);
    expect(res.status).toBe(200);
    expect(res.body.terms).toMatchObject({ creditLimit: 1500000, maxOverdueDays: 30, paymentTerms: '45', interestRate: null });
    expect(res.body.history.map((h) => [h.by, h.detail])).toEqual([
      ['Owner', 'Credit limit ₹8,00,000 to ₹15,00,000 · payment terms 30 to 45'],
      ['Owner', 'Credit limit ₹5,00,000 to ₹8,00,000'],
    ]);
    expect(res.body.history[0].at).toBeTruthy();

    // Another customer's changes are not this one's.
    const other = await customer();
    expect((await call('get', `/customer/${other._id}/credit-terms`)).body.history).toEqual([]);
    expect((await call('get', '/customer/not-an-id/credit-terms')).status).toBe(404);
  });

  it('is on the list of the week\'s changes worth a second look', async () => {
    const c = await customer({ name: 'Sri Lakshmi Garments' });
    await call('put', '/customer/update', formOf(c, { creditLimit: 1500000, maxOverdueDays: 90 }));

    const item = (await watch()).items.find((i) => i.kind === 'credit');
    expect(item).toMatchObject({
      severity: 'check', actor: 'Owner', entityType: 'Customer', entityId: String(c._id),
      title: 'Credit terms changed: Sri Lakshmi Garments',
    });
    expect(item.detail).toBe('Credit limit ₹5,00,000 to ₹15,00,000 · overdue days allowed 30 to 90');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('raw material adjusted by hand', () => {
  async function yarn() {
    const supplier = await M.Supplier.create({ name: `Kumar Yarns ${++seq}`, phoneNumber: '9000000001' });
    return M.RawMaterial.create({ name: `Nylon ${seq}`, category: 'warp', stock: 100, minStock: 10, price: 300, avgCost: 300, supplier: supplier._id });
  }
  const adjust = (m, adjustment, reason) => call('post', '/materials/bulk-adjust-stock', { adjustments: [{ _id: String(m._id), adjustment, reason }] });

  it('is on the weekly list: a write-off to be looked at, with its worth and its reason', async () => {
    const m = await yarn();
    expect((await adjust(m, -12.5, 'Damaged in the rain')).status).toBe(200);

    const items = (await watch()).items.filter((i) => i.kind === 'stock');
    // Before: not on the list at all.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      severity: 'check', actor: 'Owner', entityType: 'RawMaterial', entityId: String(m._id), entityNo: m.name,
      title: `${m.name}: 12.5 kg written off by hand`,
      detail: 'Reason: Damaged in the rain · worth ₹3,750',
    });
  });

  it('stock found is listed too, as a note', async () => {
    const m = await yarn();
    await adjust(m, 30, 'Found behind the rack');
    const [item] = (await watch()).items.filter((i) => i.kind === 'stock');
    expect(item).toMatchObject({ severity: 'info', title: `${m.name}: 30 kg added by hand` });
  });

  it('a posted count is not listed a second time, row by row', async () => {
    const m = await yarn();
    // What posting a count writes on the material (api/stockCount.js).
    await M.RawMaterial.collection.updateOne({ _id: m._id }, {
      $push: { stockMovements: { date: new Date(), type: 'STOCK_ADJUST', quantity: -4, balance: 96, reason: 'Count #3: recount of rack B', byName: 'Owner', unitCost: 300 } },
    });
    expect((await watch()).items.filter((i) => i.kind === 'stock')).toEqual([]);
  });

  it('an adjustment from before names were kept is still listed, by "Someone"', async () => {
    const m = await yarn();
    await M.RawMaterial.collection.updateOne({ _id: m._id }, {
      $push: { stockMovements: { date: new Date(), type: 'STOCK_ADJUST', quantity: -9, balance: 91, reason: 'Old write-off' } },
    });
    const [item] = (await watch()).items.filter((i) => i.kind === 'stock');
    expect(item).toMatchObject({ actor: 'Someone', title: `${m.name}: 9 kg written off by hand`, detail: 'Reason: Old write-off' });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the customer\'s recent paperwork', () => {
  it('does not list an order that was deleted', async () => {
    const c = await customer();
    const e = await M.Elastic.create({ name: '20mm', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
    const order = (status, po) => M.Order.create({
      customer: c._id, status, po, date: new Date('2026-11-01'), supplyDate: new Date('2026-11-25'),
      elasticOrdered: [{ elastic: e._id, quantity: 1000 }],
    });
    await order('Open', 'LIVE-1');
    await order('Deleted', 'GONE-1');
    await order('Completed', 'DONE-1');

    const res = await call('get', `/customer/${c._id}/recent`);
    expect(res.status).toBe(200);
    // Before: three, the deleted one among them.
    expect(res.body.orders.map((o) => o.po).sort()).toEqual(['DONE-1', 'LIVE-1']);
    expect(res.body.orderTotal).toBe(2);
  });
});

describe('a customer\'s name and tax number', () => {
  const add = (body) => call('post', '/customer/create', { contactName: 'R', phoneNumber: '9000000002', ...body });

  it('a name of nothing but spaces is no name', async () => {
    const res = await add({ name: '    ' });
    // Before: 201 — a customer with a blank name.
    expect(res.status).toBe(400);
    expect(await M.Customer.countDocuments({})).toBe(0);
  });

  it('are kept without the spaces around them, the tax number in capitals', async () => {
    const res = await add({ name: '  Sri Lakshmi Garments ', gstin: ' 33aabcu9603r1zm ', email: ' accounts@slg.in ' });
    expect(res.status).toBe(201);
    // Before: as typed — and a GSTIN in small letters is refused on an e-invoice.
    expect(res.body.data).toMatchObject({ name: 'Sri Lakshmi Garments', gstin: '33AABCU9603R1ZM', email: 'accounts@slg.in' });
  });

  it('a short name, or a long one, is still a name (unchanged)', async () => {
    expect((await add({ name: 'X' })).status).toBe(201);
    expect((await add({ name: 'Sri Venkateswara Textile Processing and Knitting Mills Private Limited — Unit II, Tiruppur (Export Division)' })).status).toBe(201);
  });
});
