'use strict';
// ══════════════════════════════════════════════════════════════════
//  BULK UPLOADING ELASTIC PRODUCTS FROM EXCEL
//
//  Download the template, fill it, upload it. Materials are picked by
//  name from the raw materials that exist; the upload never writes a
//  material. An existing elastic is updated by name and keeps whatever
//  the sheet leaves blank; a row that cannot be saved says why and does
//  not stop the others.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const ExcelJS  = require('exceljs');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Elastic, Costing, RawMaterial, User;
let admin, accounts, production, warp, rubber, cover, weft;

const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Elastic = require('../../models/Elastic');
  Costing = require('../../models/Costing');
  RawMaterial = require('../../models/RawMaterial');
  User = require('../../models/User');
  admin = await User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  accounts = await User.create({ name: 'Fin', email: 'f@t.co', password: 'pass1234', role: 'accounts', department: 'finance', features: ['/', '/elastics'] });
  production = await User.create({ name: 'Prod', email: 'p@t.co', password: 'pass1234', role: 'production', department: 'production', features: ['/', '/elastics'] });
  const mat = (name, category, price, stock = 100) => RawMaterial.create({ name, category, price, stock });
  warp = await mat('Poly 150D', 'warp', 200);
  rubber = await mat('Spandex 840D', 'rubber', 900);
  cover = await mat('Cover 40D', 'covering', 300);
  weft = await mat('Poly 300D', 'weft', 180);
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => { await Elastic.deleteMany({}); await Costing.deleteMany({}); });

/** GET a binary .xlsx and load it. */
async function download(u = admin, query = '') {
  const res = await request(app).get(`/api/v2/elastic/bulk/template${query}`).set('Cookie', cookie(u))
    .buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
  return { res, wb: res.status === 200 ? await new ExcelJS.Workbook().xlsx.load(res.body) : null };
}

/** Fill the template's sheets with plain objects keyed by header. */
function fill(wb, sheet, rows) {
  const ws = wb.getWorksheet(sheet);
  const headers = ws.getRow(1).values; // 1-based
  rows.forEach((r, i) => {
    const row = ws.getRow(i + 2);
    for (const [k, v] of Object.entries(r)) row.getCell(headers.indexOf(k)).value = v;
    row.commit();
  });
}

async function upload(wb, u = admin) {
  const buf = await wb.xlsx.writeBuffer();
  return request(app).post('/api/v2/elastic/bulk/upload').set('Cookie', cookie(u))
    .attach('file', Buffer.from(buf), 'elastics.xlsx');
}

const full = (name, over = {}) => ({
  name, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  warpSpandex_material: 'Spandex 840D', warpSpandex_ends: 40, warpSpandex_weight: 0.5,
  spandexCovering_material: 'Cover 40D', spandexCovering_weight: 0.2,
  weftYarn_material: 'Poly 300D', weftYarn_weight: 0.4, conversionCost: 1.5,
  ...over,
});

describe('the template', () => {
  test('has instructions, the two sheets to fill, and the materials to pick from', async () => {
    const { res, wb } = await download();
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/elastic_products_upload\.xlsx/);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Instructions', 'Elastics', 'ElasticWarpYarns', 'Materials', 'Lists']);
    expect(wb.getWorksheet('Lists').state).toBe('hidden');
    expect(wb.getWorksheet('Elastics').getRow(1).values).toEqual(expect.arrayContaining(['name', 'weftYarn_material', 'conversionCost']));
    const mats = wb.getWorksheet('Materials').getColumn(1).values.slice(2);
    expect(mats).toEqual(expect.arrayContaining(['Poly 150D', 'Spandex 840D', 'Cover 40D', 'Poly 300D']));
    // The material columns are dropdowns drawn from that sheet.
    const dv = wb.getWorksheet('Elastics').dataValidations.model;
    expect(Object.keys(dv).length).toBeGreaterThan(0);
  });

  test('each material column offers only the materials for its slot, as the elastic form does', async () => {
    const MaterialGroup = require('../../models/MaterialGroup');
    // A group named "Spandex Yarn" puts its materials in the spandex slot,
    // whatever their category says.
    const g = await MaterialGroup.create({ name: 'Spandex Yarn', code: 'SPX' });
    const extra = await RawMaterial.create({ name: 'Lycra 1120D', category: 'Spandex Yarn', group: g._id, price: 950, stock: 0 });
    try {
      const { wb } = await download();
      const lists = wb.getWorksheet('Lists');
      const listFor = (sheet, header) => {
        const ws = wb.getWorksheet(sheet);
        const col = ws.getRow(1).values.indexOf(header);
        const letter = String.fromCharCode(64 + col);
        const range = ws.dataValidations.model[`${letter}2`].formulae[0];
        const [, c, from, to] = range.match(/^Lists!\$([A-Z])\$(\d+):\$[A-Z]\$(\d+)$/);
        const names = [];
        for (let r = Number(from); r <= Number(to); r++) names.push(lists.getCell(`${c}${r}`).value);
        return names;
      };
      expect(listFor('ElasticWarpYarns', 'material')).toEqual(['Poly 150D']);
      expect(listFor('Elastics', 'warpSpandex_material')).toEqual(['Lycra 1120D']);
      expect(listFor('Elastics', 'spandexCovering_material')).toEqual(['Cover 40D']);
      expect(listFor('Elastics', 'weftYarn_material')).toEqual(['Poly 300D']);

      // And the material picked from that dropdown is the one saved.
      fill(wb, 'Elastics', [full('Lycra Tape', { warpSpandex_material: 'Lycra 1120D' })]);
      expect((await upload(wb)).body).toMatchObject({ added: 1, skipped: [] });
      const e = await Elastic.findOne({ name: 'Lycra Tape' }).lean();
      expect(String(e.warpSpandex.id)).toBe(String(extra._id));
    } finally {
      await RawMaterial.deleteOne({ _id: extra._id });
      await MaterialGroup.deleteOne({ _id: g._id });
    }
  });

  test('a slot with no materials of its own falls back to the whole list', async () => {
    await RawMaterial.updateOne({ _id: cover._id }, { $set: { category: 'other' } });
    try {
      const { wb } = await download();
      const ws = wb.getWorksheet('Elastics');
      const letter = String.fromCharCode(64 + ws.getRow(1).values.indexOf('spandexCovering_material'));
      expect(ws.dataValidations.model[`${letter}2`].formulae[0]).toBe('Materials!$A$2:$A$5');
    } finally {
      await RawMaterial.updateOne({ _id: cover._id }, { $set: { category: 'covering' } });
    }
  });

  test('can come with a worked example row', async () => {
    const { wb } = await download(admin, '?example=1');
    expect(String(wb.getWorksheet('Elastics').getRow(2).getCell(1).value)).toMatch(/example/);
  });

  test('finance can download it; production cannot', async () => {
    expect((await download(accounts)).res.status).toBe(200);
    expect((await download(production)).res.status).toBe(403);
  });
});

describe('uploading', () => {
  test('adds new elastics with their warp yarns, costed on the way in', async () => {
    const { wb } = await download();
    fill(wb, 'Elastics', [full('20mm Knitted White'), full('25mm Woven', { weftYarn_material: 'poly 300d' })]);
    fill(wb, 'ElasticWarpYarns', [
      { elasticName: '20mm Knitted White', material: 'Poly 150D', ends: 120, weight: 1.0 },
      { elasticName: '20mm knitted white', material: 'Poly 150D', ends: 20, weight: 0.2 },
    ]);
    const res = await upload(wb, accounts);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 2, updated: 0, skipped: [] });

    const e = await Elastic.findOne({ name: '20mm Knitted White' }).lean();
    expect(e).toMatchObject({ pick: 12, noOfHook: 8, weight: 2.4, spandexEnds: 40 });
    expect(e.warpYarn).toHaveLength(2);
    expect(String(e.weftYarn.id)).toBe(String(weft._id));
    const c = await Costing.findById(e.costing).lean();
    // 1.2 g × 200 + 0.5 × 900 + 0.2 × 300 + 0.4 × 180 = 822 → ₹0.822
    expect(Math.round(c.materialCost * 1000) / 1000).toBe(0.822);
    expect(c.conversionCost).toBe(1.5);
    // Materials matched case-insensitively ("poly 300d").
    expect(String((await Elastic.findOne({ name: '25mm Woven' }).lean()).weftYarn.id)).toBe(String(weft._id));
  });

  test('updates an existing elastic by name, leaving blank cells as they were', async () => {
    let { wb } = await download();
    fill(wb, 'Elastics', [full('20mm Knitted White')]);
    fill(wb, 'ElasticWarpYarns', [{ elasticName: '20mm Knitted White', material: 'Poly 150D', ends: 120, weight: 1.0 }]);
    await upload(wb);

    ({ wb } = await download());
    fill(wb, 'Elastics', [{ name: '20MM KNITTED WHITE', weight: 2.6, minStock: 800 }]);
    const res = await upload(wb);
    expect(res.body).toMatchObject({ added: 0, updated: 1 });

    expect(await Elastic.countDocuments()).toBe(1);
    const e = await Elastic.findOne().lean();
    expect(e).toMatchObject({ weight: 2.6, minStock: 800, pick: 12, noOfHook: 8, spandexEnds: 40 });
    expect(e.warpYarn).toHaveLength(1); // no warp rows this time: kept
    expect((await Costing.findById(e.costing).lean()).conversionCost).toBe(1.5); // kept
  });

  test('a row that cannot be saved says why; the others still go in', async () => {
    const { wb } = await download();
    fill(wb, 'Elastics', [
      full('Good One'),
      { name: 'No Pick', weight: 2, noOfHook: 8, spandexEnds: 40 },
      full('Bad Material', { weftYarn_material: 'Unobtainium' }),
      full('Negative', { weight: -1 }),
    ]);
    fill(wb, 'ElasticWarpYarns', [{ elasticName: 'Not On Sheet', material: 'Poly 150D', weight: 1 }]);
    const res = await upload(wb);
    expect(res.body.added).toBe(1);
    const why = res.body.skipped.join('\n');
    expect(why).toMatch(/row 3 "No Pick": a new elastic needs pick/);
    expect(why).toMatch(/"Bad Material".*no raw material named "Unobtainium"/);
    expect(why).toMatch(/"Negative": weight cannot be negative/);
    expect(why).toMatch(/"Not On Sheet" has no row on the Elastics sheet/);
    expect(await Elastic.countDocuments()).toBe(1);
  });

  test('never changes a raw material, whatever the Materials sheet says', async () => {
    const { wb } = await download();
    const ref = wb.getWorksheet('Materials');
    ref.unprotect();
    ref.getRow(2).getCell(4).value = 99999; // a price edited in the reference sheet
    fill(wb, 'Elastics', [full('20mm Knitted White')]);
    await upload(wb);
    const after = await RawMaterial.find({}).lean();
    expect(after.map((m) => [m.name, m.price, m.stock]).sort()).toEqual([
      ['Cover 40D', 300, 100], ['Poly 150D', 200, 100], ['Poly 300D', 180, 100], ['Spandex 840D', 900, 100],
    ].sort());
  });

  test('a file that is not the template is refused plainly', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1');
    const res = await upload(wb);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no "Elastics" sheet/);
  });
});

describe('the full data import', () => {
  test('no longer overwrites an existing material\'s stock', async () => {
    const { importWorkbook } = require('../../utils/excelIo');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('RawMaterials');
    ws.addRow(['name', 'category', 'supplierName', 'price', 'stock', 'minStock']);
    ws.addRow(['Poly 150D', 'warp', '', 210, '', 50]);
    ws.addRow(['Brand New Yarn', 'warp', '', 150, 25, 0]);
    await importWorkbook(wb);
    const poly = await RawMaterial.findOne({ name: 'Poly 150D' }).lean();
    expect(poly).toMatchObject({ price: 210, stock: 100, minStock: 50 });
    expect((await RawMaterial.findOne({ name: 'Brand New Yarn' }).lean()).stock).toBe(25);
    await RawMaterial.updateOne({ _id: warp._id }, { $set: { price: 200, minStock: 0 } });
    await RawMaterial.deleteOne({ name: 'Brand New Yarn' });
  });
});
