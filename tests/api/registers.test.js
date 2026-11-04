'use strict';
// ══════════════════════════════════════════════════════════════════
//  REGISTERS: FIXED ASSETS, CLOSING STOCK, BUDGETS, COST CENTRES
//
//    Fixed assets  an asset put to use mid-year is depreciated pro rata
//                  by days under Schedule II and at half the block rate
//                  under s.32 when used under 180 days; the year's total
//                  posts as one journal, and posting again replaces it
//    Closing stock the shelf on a day, at average cost, less what moved
//                  after; posted as a journal with its reversal next day
//    Budgets       twelve figures a head; an over-spent month is called
//    Cost centres  a bill booked to an order shows on the order's P&L
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
  for (const n of ['User', 'Supplier', 'SupplierBill', 'Journal', 'RawMaterial', 'ExpenseCategory', 'Expense', 'Order', 'Customer', 'FixedAsset']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'reg@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users'].includes(c.collectionName)) await c.deleteMany({});
  }
});

describe('fixed assets', () => {
  it('depreciates a mid-year addition pro rata under Schedule II and at the block rate under s.32', async () => {
    const r = await post('/accounts/fixed-assets', { name: 'Needle loom 12', block: 'plant', purchaseDate: '2026-09-20', putToUse: '2026-10-01', cost: 1000000 });
    expect(r.status).toBe(201);
    expect(r.body.asset.assetNo).toMatch(/^FA\/2026-27\/0001$/);
    const y = r.body.year;
    // WDV rate for 15 years to 5%: 1 − 0.05^(1/15) ≈ 18.1%; 182 of 365 days in use.
    expect(y.companiesAct.rate).toBeCloseTo(18.1, 0);
    expect(y.days).toBe(182);
    expect(y.companiesAct.depreciation).toBeGreaterThan(90000);
    expect(y.companiesAct.depreciation).toBeLessThan(90500);
    // 182 days is not under 180: the full 15%.
    expect(y.halfRate).toBe(false);
    expect(y.incomeTax.depreciation).toBe(150000);
    expect(y.incomeTax.closing).toBe(850000);

    // Put to use in November: under 180 days, half the rate.
    const late = await post('/accounts/fixed-assets', { name: 'Compressor', block: 'plant', purchaseDate: '2026-11-01', cost: 200000 });
    expect(late.body.year.halfRate).toBe(true);
    expect(late.body.year.incomeTax.depreciation).toBe(15000);

    const reg = (await get('/accounts/fixed-assets?fy=2026-27')).body;
    expect(reg.rows).toHaveLength(2);
    expect(reg.totals.additions).toBe(1200000);
    expect(reg.totals.itDep).toBe(165000);
    expect(reg.journal).toBeNull();

    // The next year runs on the written-down value for a full year.
    const next = (await get('/accounts/fixed-assets?fy=2027-28')).body;
    const loom = next.rows.find((a) => a.name === 'Needle loom 12');
    expect(loom.year.companiesAct.opening).toBe(y.companiesAct.closing);
    expect(loom.year.fraction).toBe(1);
    expect(loom.year.incomeTax.depreciation).toBe(127500);
  });

  it('posts the year as one journal, replaces it on re-posting, and stops at disposal', async () => {
    const a = (await post('/accounts/fixed-assets', { name: 'Office PC', block: 'computer', purchaseDate: '2026-04-01', cost: 60000 })).body;
    const first = await post('/accounts/fixed-assets/depreciation', { fy: '2026-27' });
    expect(first.status).toBe(201);
    expect(first.body.journal.purpose).toBe('depreciation');
    expect(first.body.journal.total).toBe(a.year.companiesAct.depreciation);
    expect(first.body.register.journal.journalNo).toBe(first.body.journal.journalNo);

    await post('/accounts/fixed-assets', { name: 'Printer', block: 'computer', purchaseDate: '2026-04-01', cost: 12000 });
    const again = await post('/accounts/fixed-assets/depreciation', { fy: '2026-27' });
    expect(again.status).toBe(201);
    expect(again.body.journal.total).toBeGreaterThan(first.body.journal.total);
    const posted = await M.Journal.find({ source: 'depreciation', sourceRef: '2026-27' }).lean();
    expect(posted.map((j) => j.status).sort()).toEqual(['cancelled', 'posted']);

    const sold = await post(`/accounts/fixed-assets/${a.asset._id}/dispose`, { how: 'sold', date: '2027-09-30', amount: 20000, reason: 'Replaced' });
    expect(sold.status).toBe(200);
    expect(sold.body.asset.status).toBe('sold');
    // Half a year's Schedule II depreciation, then the gain or loss against the written-down value.
    expect(sold.body.year.fy).toBe('2027-28');
    expect(sold.body.year.days).toBe(183);
    expect(sold.body.year.disposal.gainLoss).toBe(Math.round((20000 - sold.body.year.disposal.wdv) * 100) / 100);
    // Nothing under s.32 in the year of sale; the money comes off the block.
    expect(sold.body.year.incomeTax.depreciation).toBe(0);
    const after = (await get('/accounts/fixed-assets?fy=2028-29')).body;
    expect(after.rows.find((x) => x.name === 'Office PC')).toBeUndefined();
  });
});

describe('closing stock', () => {
  it('values the shelf on a day, net of what moved after it, and posts the journal with its reversal', async () => {
    await M.RawMaterial.create({ name: 'Nylon 70D', category: 'warp', unit: 'kg', stock: 120, avgCost: 300, price: 320, stockMovements: [{ date: new Date('2026-10-05'), type: 'PO_INWARD', quantity: 20 }] });
    await M.RawMaterial.create({ name: 'Spandex 420D', category: 'weft', unit: 'kg', stock: 10, avgCost: 0, price: 0 });
    const v = (await get('/accounts/closing-stock?asOf=2026-09-30')).body;
    const nylon = v.rawMaterials.rows.find((r) => r.name === 'Nylon 70D');
    expect(nylon.quantity).toBe(100);
    expect(nylon.value).toBe(30000);
    expect(v.rawMaterials.total).toBe(30000);
    expect(v.warnings).toEqual([expect.stringMatching(/Spandex 420D.*₹0/)]);
    expect(v.journals.closing).toBeNull();

    const p = await post('/accounts/closing-stock', { asOf: '2026-09-30' });
    expect(p.status).toBe(201);
    expect(p.body.closing.total).toBe(30000);
    expect(p.body.closing.date.slice(0, 10)).toBe('2026-09-30');
    expect(p.body.opening.date.slice(0, 10)).toBe('2026-10-01');
    expect(p.body.closing.lines.map((l) => [l.ledger, l.debit, l.credit])).toEqual([['Stock-in-Hand', 30000, 0], ['Closing Stock', 0, 30000]]);
    expect(p.body.opening.lines.map((l) => [l.ledger, l.debit, l.credit])).toEqual([['Closing Stock', 30000, 0], ['Stock-in-Hand', 0, 30000]]);
    expect(p.body.valuation.journals.closing.journalNo).toBe(p.body.closing.journalNo);
  });
});

describe('budgets', () => {
  it('spreads an annual figure, reads the actual off the books, and calls the month that went over', async () => {
    const cat = await M.ExpenseCategory.create({ name: 'Electricity', approvalAbove: 10_000_000 });
    const saved = await put('/accounts/budgets', { fy: '2026-27', rows: [{ category: cat._id, annual: 120000 }] });
    expect(saved.status).toBe(200);
    const row = saved.body.rows.find((r) => r.name === 'Electricity');
    expect(row.budget).toEqual(Array(12).fill(10000));
    expect(row.state).toBe('ok');
    const e = await post('/accounts/expenses', { category: cat._id, description: 'TNEB bill', amount: 12500, date: '2026-05-10', payeeName: 'TNEB' });
    expect(e.status).toBe(201);
    expect(e.body.expense.status).toBe('approved');
    const cmp = (await get('/accounts/budgets?fy=2026-27')).body;
    const r = cmp.rows.find((x) => x.name === 'Electricity');
    expect(r.actual[1]).toBe(12500);           // May
    expect(r.overMonths).toEqual(['May']);
    expect(r.ytdActual).toBe(12500);
    expect(cmp.totals.actualTotal).toBe(12500);
  });
});

describe('cost centres', () => {
  it('books a bill to an order and shows it on the order P&L and the cost-centre report', async () => {
    const s = await M.Supplier.create({ name: 'Erode Dyers', gstin: '33AAAPS0001F1Z5', address: 'Erode' });
    const customer = await M.Customer.create({ name: 'Ravi Textiles', contactName: 'R', phoneNumber: '9300000001' });
    const order = await M.Order.create({ orderNo: 501, customer: customer._id, elasticOrdered: [], po: 'PO-9', date: new Date('2026-09-01'), supplyDate: new Date('2026-10-15') });
    const b = await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'D/1', kind: 'service', billDate: '2026-10-02', lines: [{ description: 'Dyeing', quantity: 1, rate: 8000, gstPercent: 5 }], costCentre: { order: order._id } });
    expect(b.status).toBe(201);
    expect(b.body.bill.costCentre).toMatchObject({ kind: 'order', orderNo: order.orderNo, name: `Order #${order.orderNo}` });
    const none = await post('/accounts/bills', { supplier: s._id, supplierBillNo: 'D/2', kind: 'service', billDate: '2026-10-03', lines: [{ description: 'Dyeing', quantity: 1, rate: 1000, gstPercent: 5 }] });
    expect(none.body.bill.costCentre?.kind).toBeUndefined();

    const forOrder = (await get(`/accounts/cost-centres/order/${order._id}`)).body;
    expect(forOrder.total).toBe(8000);          // net of the GST claimed
    const rep = (await get('/accounts/cost-centres?from=2026-10-01&to=2026-10-31')).body;
    expect(rep.orders).toEqual([expect.objectContaining({ name: `Order #${order.orderNo}`, total: 8000, count: 1 })]);
    expect(rep.unallocated).toBe(1000);

    const { orderPnl } = require('../../services/orderPnl');
    const pnl = await orderPnl(order._id);
    expect(pnl.costs.booked).toBe(8000);
    expect(pnl.costs.total).toBe(8000);
    expect(pnl.bookedLines).toHaveLength(1);
  });
});
