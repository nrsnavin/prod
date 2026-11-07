'use strict';
// ══════════════════════════════════════════════════════════════════
//  EVERY REPORT, ONE ENGINE
//
//    • sales by customer, item, customer group, elastic group; purchases
//      by item and supplier; production by machine/operator/elastic —
//      each adding up to the same total, in India's business days
//    • every ready-made report runs, on data and on none
//    • a typed SQL query gives the same answer as the report; anything
//      but a read is refused; an unknown field says what there is
//    • money is for admin and accounts, not production
//    • Excel (typed cells, totals) and PDF downloads; saved queries
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin, prodUser;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const run = (body, u = admin) => request(app).get('/api/v2/reports/run').query({ payload: JSON.stringify(body) }).set('Cookie', cookie(u));
const at = (s) => new Date(`${s}+05:30`);
const db = () => mongoose.connection;
const PERIOD = { from: '2026-10-01', to: '2026-10-31' };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const User = require('../../models/User.js');
  admin = await User.create({ name: 'Owner', email: 're@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  prodUser = await User.create({ name: 'Sup', email: 're2@t.co', password: 'pass1234', role: 'production', department: 'production' });

  const [sun, kay, lux] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await db().collection('customers').insertMany([{ _id: sun, name: 'Sunrise Garments', group: 'Innerwear' }, { _id: kay, name: 'Kay Knits', group: 'Innerwear' }, { _id: lux, name: 'Lux Exports', group: '' }]);
  const [e20, e25, e40] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  await db().collection('elastics').insertMany([{ _id: e20, name: '20mm Black' }, { _id: e25, name: '25mm White' }, { _id: e40, name: '40mm Waistband' }]);
  await db().collection('elasticgroups').insertMany([
    { name: 'Narrow', customer: null, isActive: true, items: [{ elastic: e20 }, { elastic: e25 }] },
    { name: 'Lux specials', customer: lux, isActive: true, items: [{ elastic: e25 }] },
  ]);
  const line = (elastic, name, quantity, rate) => ({ elastic, name, hsn: '5806', unit: 'm', quantity, rate, taxable: quantity * rate, gstPercent: 5, cgst: quantity * rate * 0.025, sgst: quantity * rate * 0.025, igst: 0, amount: quantity * rate * 1.05 });
  await db().collection('invoices').insertMany([
    { invoiceNumber: 'INV/1', status: 'issued', invoiceDate: at('2026-10-05T10:00:00'), customer: sun, buyer: { name: 'Sunrise Garments', stateCode: '33' }, lines: [line(e20, '20mm Black', 1000, 2), line(e25, '25mm White', 500, 3)] },
    { invoiceNumber: 'INV/2', status: 'issued', invoiceDate: at('2026-10-31T23:30:00'), customer: lux, buyer: { name: 'Lux Exports', stateCode: '29' }, lines: [line(e25, '25mm White', 2000, 3)] },
    { invoiceNumber: 'INV/3', status: 'issued', invoiceDate: at('2026-10-20T10:00:00'), customer: kay, buyer: { name: 'Kay Knits', stateCode: '33' }, lines: [line(e40, '40mm Waistband', 300, 10)] },
    { invoiceNumber: 'INV/4', status: 'cancelled', invoiceDate: at('2026-10-21T10:00:00'), customer: kay, buyer: { name: 'Kay Knits' }, lines: [line(e40, '40mm Waistband', 9999, 10)] },
    // 1 Nov 00:10 IST is 31 Oct in UTC: it belongs to November.
    { invoiceNumber: 'INV/5', status: 'issued', invoiceDate: at('2026-11-01T00:10:00'), customer: sun, buyer: { name: 'Sunrise Garments' }, lines: [line(e20, '20mm Black', 777, 2)] },
  ]);
  const pc = new mongoose.Types.ObjectId(); const sp = new mongoose.Types.ObjectId();
  await db().collection('rawmaterials').insertMany([{ _id: pc, name: '40s PC Black', category: 'warp', unit: 'kg', stock: 100, minStock: 200, avgCost: 220 }, { _id: sp, name: 'Spandex 840D', category: 'rubber', unit: 'kg', stock: 50, minStock: 10, price: 900 }]);
  const bl = (rawMaterial, description, quantity, rate) => ({ rawMaterial, description, unit: 'kg', quantity, rate, taxable: quantity * rate, gstPercent: 5, cgst: 0, sgst: 0, igst: quantity * rate * 0.05, amount: quantity * rate * 1.05 });
  await db().collection('supplierbills').insertMany([
    { billNo: 'B/1', supplierBillNo: 'SY-11', status: 'open', billDate: at('2026-10-03T10:00:00'), supplierName: 'Sri Yarn', lines: [bl(pc, '40s PC Black', 100, 220)] },
    { billNo: 'B/2', supplierBillNo: 'LT-4', status: 'paid', billDate: at('2026-10-09T10:00:00'), supplierName: 'Lycra Traders', lines: [bl(sp, 'Spandex 840D', 10, 900), bl(null, 'Freight', 1, 500)] },
    { billNo: 'B/3', status: 'cancelled', billDate: at('2026-10-09T10:00:00'), supplierName: 'Sri Yarn', lines: [bl(pc, '40s PC Black', 999, 220)] },
  ]);
  const m1 = new mongoose.Types.ObjectId(); const ravi = new mongoose.Types.ObjectId();
  await db().collection('machines').insertOne({ _id: m1, ID: 'L-01' });
  await db().collection('employees').insertOne({ _id: ravi, name: 'Ravi' });
  await db().collection('shiftdetails').insertMany([
    { status: 'closed', date: at('2026-10-05T00:00:00'), shift: 'DAY', machine: m1, employee: ravi, productionMeters: 600, elastics: [{ head: 0, elastic: e20 }, { head: 1, elastic: e25 }], remark: { kind: 'yarn_break', minutes: 25 } },
    { status: 'closed', date: at('2026-10-06T00:00:00'), shift: 'NIGHT', machine: m1, employee: ravi, productionMeters: 400, elastics: [{ head: 0, elastic: e20 }] },
    { status: 'pending_verification', date: at('2026-10-07T00:00:00'), shift: 'DAY', machine: m1, employee: ravi, productionMeters: 9999, elastics: [] },
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const rowsOf = (res) => res.body.result.rows;

describe('sales', () => {
  it('by customer, in India\'s days, leaving out cancelled invoices and November', async () => {
    const res = await run({ report: 'sales-by-customer', ...PERIOD });
    expect(res.status).toBe(200);
    expect(rowsOf(res).map((r) => [r.customer, r.sum_taxable])).toEqual([['Lux Exports', 6000], ['Sunrise Garments', 3500], ['Kay Knits', 3000]]);
    expect(res.body.result.totals.sum_taxable).toBe(12500);
    // Sunrise's invoice has two lines: one invoice.
    expect(rowsOf(res).find((r) => r.customer === 'Sunrise Garments').countd_invoiceNo).toBe(1);
    expect(res.body.result.totals.countd_invoiceNo).toBe(3);
    expect(res.body.rangeLabel).toBe('1 Oct 2026 – 31 Oct 2026');
  });

  it('by item, customer group and elastic group all add up to the same total', async () => {
    const item = await run({ report: 'sales-by-item', ...PERIOD });
    expect(rowsOf(item).map((r) => [r.elastic, r.sum_quantity, r.avg_rate])).toEqual([['25mm White', 2500, 3], ['40mm Waistband', 300, 10], ['20mm Black', 1000, 2]]);
    const grp = await run({ report: 'sales-by-customer-group', ...PERIOD });
    expect(rowsOf(grp).map((r) => [r.customerGroup, r.sum_taxable])).toEqual([['Innerwear', 6500], ['No group', 6000]]);
    const eg = await run({ report: 'sales-by-elastic-group', ...PERIOD });
    // Lux's 25mm counts under Lux's own group; elsewhere under the common one.
    expect(rowsOf(eg).map((r) => [r.elasticGroup, r.sum_taxable])).toEqual([['Lux specials', 6000], ['Narrow', 3500], ['No group', 3000]]);
    for (const r of [item, grp, eg]) expect(r.body.result.totals.sum_taxable).toBe(12500);
  });

  it('a filter narrows a ready-made report', async () => {
    const res = await run({ report: 'sales-by-customer', ...PERIOD, filters: [{ field: 'customerGroup', op: '=', value: 'innerwear' }] });
    expect(rowsOf(res).map((r) => r.customer)).toEqual(['Sunrise Garments', 'Kay Knits']);
    expect(res.body.filterLine).toBe('Customer group is innerwear');
  });
});

describe('purchases and production', () => {
  it('purchases by item and by supplier, cancelled bills left out', async () => {
    const item = await run({ report: 'purchases-by-item', ...PERIOD });
    expect(rowsOf(item).map((r) => [r.material, r.sum_taxable])).toEqual([['40s PC Black', 22000], ['Spandex 840D', 9000], ['Freight', 500]]);
    const sup = await run({ report: 'purchases-by-supplier', ...PERIOD });
    expect(rowsOf(sup).map((r) => [r.supplier, r.countd_billNo, r.sum_taxable])).toEqual([['Sri Yarn', 1, 22000], ['Lycra Traders', 1, 9500]]);
    const cat = await run({ report: 'purchases-by-category', ...PERIOD });
    expect(rowsOf(cat).find((r) => r.category === 'Not a stock material').sum_taxable).toBe(500);
  });

  it('production only counts verified shifts, and splits a shift across its elastics', async () => {
    const m = await run({ report: 'production-by-machine', ...PERIOD });
    expect(rowsOf(m)).toEqual([{ machine: 'L-01', sum_metres: 1000, sum_shifts: 2 }]);
    const e = await run({ report: 'production-by-elastic', ...PERIOD });
    expect(rowsOf(e).map((r) => [r.elastic, r.sum_metres])).toEqual([['20mm Black', 700], ['25mm White', 300]]);
    const d = await run({ report: 'downtime-by-reason', ...PERIOD });
    expect(rowsOf(d)).toEqual([{ downtimeKind: 'yarn break', sum_downtimeMinutes: 25, count_downtimeKind: 1 }]);
  }, 30_000);

  it('every ready-made report runs, on this data and on an empty period', async () => {
    const { REPORTS } = require('../../services/reportEngine/catalog');
    for (const r of REPORTS) {
      for (const period of [PERIOD, { from: '2020-01-01', to: '2020-01-31' }]) {
        const res = await run({ report: r.id, ...period });
        if (res.status !== 200) throw new Error(`${r.id}: ${res.status} ${res.body.message}`);
        expect(Array.isArray(res.body.result.rows)).toBe(true);
      }
    }
  }, 60_000);
});

describe('a typed query', () => {
  it('gives the same answer as the report, with its own dates', async () => {
    const res = await run({ sql: "SELECT customer, SUM(taxable) AS sales FROM sales WHERE date BETWEEN '2026-10-01' AND '2026-10-31' AND customer_group = 'Innerwear' GROUP BY customer ORDER BY sales DESC", preset: 'today' });
    expect(res.status).toBe(200);
    expect(rowsOf(res)).toEqual([{ customer: 'Sunrise Garments', sales: 3500 }, { customer: 'Kay Knits', sales: 3000 }]);
    expect(res.body.result.columns.map((c) => c.label)).toEqual(['Customer', 'sales']);
  });

  it('builds from dropdowns too: raw rows, LIKE, IN, LIMIT', async () => {
    const res = await run({ query: { dataset: 'sales', select: ['invoiceNo', 'item', 'taxable'], where: [{ field: 'item', op: 'contains', value: 'white' }], orderBy: [{ key: 'taxable', dir: 'desc' }], limit: 1 }, ...PERIOD });
    expect(rowsOf(res)).toEqual([{ invoiceNo: 'INV/2', item: '25mm White', taxable: 6000 }]);
    expect(res.body.result).toMatchObject({ rowCount: 2, truncated: true, totals: { taxable: 7500 } });
  });

  it('refuses anything but a read, and says what fields there are', async () => {
    for (const sql of ['DELETE FROM sales', 'UPDATE sales SET taxable = 0', "SELECT * FROM sales; DROP TABLE x", 'SELECT * FROM sales WHERE a = 1 OR b = 2']) {
      const res = await run({ sql, ...PERIOD });
      expect(res.status).toBe(400);
    }
    const unknown = await run({ sql: 'SELECT profit FROM sales', ...PERIOD });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toMatch(/"profit" is not a field of sales\. Fields: date, month, invoiceNo/);
    const ungrouped = await run({ sql: 'SELECT customer, SUM(taxable) FROM sales', ...PERIOD });
    expect(ungrouped.body.message).toMatch(/Customer must be grouped by, or totalled/);
    const noTable = await run({ sql: 'SELECT * FROM users', ...PERIOD });
    expect(noTable.body.message).toMatch(/No dataset "users"/);
  });
});

describe('who may read what', () => {
  it('keeps money from production, and shows them their own reports', async () => {
    expect((await run({ report: 'sales-by-customer', ...PERIOD }, prodUser)).status).toBe(403);
    expect((await run({ sql: 'SELECT * FROM purchases' }, prodUser)).status).toBe(403);
    expect((await run({ report: 'production-by-machine', ...PERIOD }, prodUser)).status).toBe(200);
    const cat = await request(app).get('/api/v2/reports/catalog').set('Cookie', cookie(prodUser));
    expect(cat.body.datasets.map((d) => d.id)).not.toContain('sales');
    expect(cat.body.reports.some((r) => r.id === 'sales-by-customer')).toBe(false);
    expect(cat.body.reports.some((r) => r.id === 'production-by-operator')).toBe(true);
  });
});

describe('downloads and saved queries', () => {
  it('downloads Excel with typed cells and a totals row, and a PDF', async () => {
    const x = await run({ report: 'sales-by-customer', ...PERIOD, format: 'xlsx' }).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(x.status).toBe(200);
    expect(x.headers['content-disposition']).toMatch(/sales-by-customer_2026-10-01_2026-10-31\.xlsx/);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body);
    const ws = wb.worksheets[0];
    const header = ws.getRow(5).values.slice(1);
    expect(header).toEqual(['Customer', 'Number of invoices', 'Total quantity', 'Total taxable value', 'Total GST', 'Total amount']);
    expect(ws.getRow(6).values.slice(1, 5)).toEqual(['Lux Exports', 1, 2000, 6000]);
    const total = ws.getRow(9).getCell(4).value;
    expect(total).toMatchObject({ formula: 'SUM(D6:D8)', result: 12500 });

    const p = await run({ report: 'sales-register', ...PERIOD, format: 'pdf' }).buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(p.status).toBe(200);
    expect(p.body.slice(0, 5).toString()).toBe('%PDF-');
    const csv = await run({ report: 'sales-by-customer', ...PERIOD, format: 'csv' });
    expect(csv.text.split('\n')[0]).toMatch(/^Customer,Number of invoices/);
  });

  it('saves a query that runs, and refuses one that would not', async () => {
    const save = (body, u = admin) => request(app).post('/api/v2/reports/saved').set('Cookie', cookie(u)).send(body);
    const ok = await save({ name: 'Innerwear sales', sql: "SELECT customer, SUM(taxable) FROM sales WHERE customer_group = 'Innerwear' GROUP BY customer", shared: true });
    expect(ok.status).toBe(201);
    expect((await save({ name: 'Broken', sql: 'SELECT nonsense FROM sales' })).status).toBe(400);
    const cat = await request(app).get('/api/v2/reports/catalog').set('Cookie', cookie(admin));
    expect(cat.body.saved.map((s) => s.name)).toEqual(['Innerwear sales']);
    // A shared money query is not shown to production.
    const theirs = await request(app).get('/api/v2/reports/catalog').set('Cookie', cookie(prodUser));
    expect(theirs.body.saved).toEqual([]);
    expect((await request(app).delete(`/api/v2/reports/saved/${ok.body.saved._id}`).set('Cookie', cookie(prodUser))).status).toBe(403);
    expect((await request(app).delete(`/api/v2/reports/saved/${ok.body.saved._id}`).set('Cookie', cookie(admin))).status).toBe(200);
  });

  it('keeps the customer group on the customer, and lists the groups in use', async () => {
    // A required detail left out is said plainly, not a server error.
    const missing = await request(app).post('/api/v2/customer/create').set('Cookie', cookie(admin)).send({ name: 'New Co', contactName: 'R' });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe('Phone number is required');
    const c = await request(app).post('/api/v2/customer/create').set('Cookie', cookie(admin)).send({ name: 'New Co', contactName: 'R', phoneNumber: '9840000001', group: ' Exporters ' });
    expect(c.status).toBe(201);
    expect(c.body.data.group).toBe('Exporters');
    const g = await request(app).get('/api/v2/customer/groups').set('Cookie', cookie(admin));
    expect(g.body.groups).toEqual(['Exporters', 'Innerwear']);
  });
});
