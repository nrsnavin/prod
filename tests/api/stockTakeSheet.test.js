'use strict';
// ══════════════════════════════════════════════════════════════════
//  STOCK TAKE ON A SHEET — api/rawMaterial.js
//
//  The count sheet goes out with a blank Counted stock column; the
//  filled sheet comes back and is read against the live stock, row by
//  row, without writing anything. Posting goes through
//  /bulk-adjust-stock as the on-screen stock take does.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, RawMaterial, User, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const download = (url) => request(app).get(url).set('Cookie', cookie())
  .buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial = require('../../models/RawMaterial');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'st@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 90_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

async function seed() {
  const nylon = await RawMaterial.create({ name: 'Nylon 70D', category: 'covering', stock: 100, price: 300 });
  const spandex = await RawMaterial.create({ name: 'Spandex 40D', category: 'rubber', stock: 250.5, price: 600 });
  const old = await RawMaterial.create({ name: 'Old Yarn', category: 'warp', stock: 5, price: 10, archived: true });
  return { nylon, spandex, old };
}

const sheetOf = async (body) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(body); return wb.getWorksheet('Stock take'); };
const rowsOf = (ws) => { const out = []; ws.eachRow((r, n) => { if (n > 1) out.push([1, 2, 3, 4, 5].map((c) => r.getCell(c).value)); }); return out; };

describe('the count sheet', () => {
  it('lists every material that is not archived, by category and name, with the counted column blank', async () => {
    const s = await seed();
    const res = await download('/api/v2/materials/stock-take.xlsx');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/stock-take-\d{4}-\d{2}-\d{2}\.xlsx/);
    const ws = await sheetOf(res.body);
    expect([1, 2, 3, 4, 5].map((c) => ws.getRow(1).getCell(c).value)).toEqual(['Ref', 'Material', 'Category', 'Unit', 'Counted stock']);
    expect(rowsOf(ws)).toEqual([
      [String(s.nylon._id), 'Nylon 70D', 'covering', 'kg', null],
      [String(s.spandex._id), 'Spandex 40D', 'rubber', 'kg', null],
    ]);
  });

  it('can be narrowed to a category, or to chosen materials', async () => {
    const s = await seed();
    expect(rowsOf(await sheetOf((await download('/api/v2/materials/stock-take.xlsx?category=rubber')).body)).map((r) => r[1])).toEqual(['Spandex 40D']);
    expect(rowsOf(await sheetOf((await download(`/api/v2/materials/stock-take.xlsx?ids=${s.nylon._id}`)).body)).map((r) => r[1])).toEqual(['Nylon 70D']);
    expect((await download('/api/v2/materials/stock-take.xlsx?category=nothing')).status).toBe(400);
  });
});

describe('the filled sheet', () => {
  /** The exported sheet with the counted column filled in as given, plus any extra rows. */
  async function filled(fill, extra = []) {
    const res = await download('/api/v2/materials/stock-take.xlsx');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('Stock take');
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const name = row.getCell(2).value;
      if (name in fill) row.getCell(5).value = fill[name];
    });
    for (const r of extra) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const preview = (buf) => request(app).post('/api/v2/materials/stock-take/preview').set('Cookie', cookie())
    .attach('file', buf, { filename: 'stock-take.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  it('reads each row against the live stock, leaves blanks alone, names what it cannot read, and writes nothing', async () => {
    const s = await seed();
    const buf = await filled({ 'Nylon 70D': 98, 'Spandex 40D': '' }, [
      ['', 'Spandex 40D', 'rubber', 'kg', '1,250'],          // by name, with a thousands comma — but listed twice
      ['', 'Unknown Yarn', 'warp', 'kg', 3],
      ['', 'Old Yarn', 'warp', 'kg', 'five'],
    ]);
    const res = await preview(buf);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      { _id: String(s.nylon._id), name: 'Nylon 70D', category: 'covering', unit: 'kg', archived: false, systemStock: 100, counted: 98, adjustment: -2 },
      { _id: String(s.spandex._id), name: 'Spandex 40D', category: 'rubber', unit: 'kg', archived: false, systemStock: 250.5, counted: 1250, adjustment: 999.5 },
    ]);
    expect(res.body.blank).toBe(1);
    expect(res.body.unknown).toEqual([{ row: 5, name: 'Unknown Yarn' }]);
    expect(res.body.errors).toEqual([{ row: 6, name: 'Old Yarn', error: '"five" is not a quantity' }]);
    expect(res.body.changed).toBe(2);
    expect((await RawMaterial.findById(s.nylon._id).lean()).stock).toBe(100);
  });

  it('refuses a sheet without the columns, or that is not a workbook', async () => {
    await seed();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['Thing', 'Qty']);
    const bad = await preview(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/"Material" column/);
    expect((await preview(Buffer.from('not a workbook'))).status).toBe(400);
    expect((await request(app).post('/api/v2/materials/stock-take/preview').set('Cookie', cookie())).status).toBe(400);
  });

  it('the on-screen posting then applies the differences, each as a ledger entry', async () => {
    const s = await seed();
    const { rows } = (await preview(await filled({ 'Nylon 70D': 98 }))).body;
    const post = await request(app).post('/api/v2/materials/bulk-adjust-stock').set('Cookie', cookie())
      .send({ adjustments: rows.filter((r) => r.adjustment !== 0).map((r) => ({ _id: r._id, adjustment: r.adjustment, reason: 'Stock take (Excel sheet)' })) });
    expect(post.status).toBe(200);
    expect((await RawMaterial.findById(s.nylon._id).lean()).stock).toBe(98);
    expect((await RawMaterial.findById(s.spandex._id).lean()).stock).toBe(250.5);
  });
});
