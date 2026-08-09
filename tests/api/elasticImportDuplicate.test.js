'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE EXCEL IMPORT CANNOT FORK A PRODUCT
//
//  The import is the one write path that never touches the API's own
//  duplicate check — it upserts straight into the collection. Keyed on
//  the exact name, a sheet saying "Newday Romeo Black" would insert a
//  second row beside the catalogue's "NEWDAY ROMEO BLACK", which is
//  precisely the duplicate this work exists to prevent, arriving
//  through the door nobody was watching.
//
//  Worse, it would arrive in bulk: a sheet is dozens of rows, and once
//  the unique index is in place the whole import fails on the first one
//  instead.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
const { MongoMemoryServer } = require('mongodb-memory-server');

const { importWorkbook } = require('../../utils/excelIo.js');

let mongo, Elastic, Supplier, RawMaterial;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } });
  await mongoose.connect(mongo.getUri());
  Elastic = require('../../models/Elastic');
  Supplier = require('../../models/Supplier');
  RawMaterial = require('../../models/RawMaterial');
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

/** A workbook with one Elastics row, shaped like the real template. */
function sheetWith(name) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Elastics');
  const cols = [
    'name', 'weaveType', 'spandexEnds', 'yarnEnds', 'pick', 'noOfHook',
    'weight', 'minStock', 'width', 'elongation', 'recovery', 'strech',
    'warpSpandex_material', 'warpSpandex_ends', 'warpSpandex_weight',
    'spandexCovering_material', 'spandexCovering_weight',
    'weftYarn_material', 'weftYarn_weight',
  ];
  ws.addRow(cols);
  ws.addRow([name, '8', 40, 120, 12, 8, 2.4, 0, 20, 120, 90, '', '', '', '', '', '', '', '']);
  return wb;
}

it('updates the elastic already in the catalogue instead of adding a twin', async () => {
  await Elastic.create({
    name: 'NEWDAY ROMEO BLACK', weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });

  // The same product, typed the way the person filling in the sheet
  // types it.
  const report = await importWorkbook(sheetWith('Newday  Romeo Black'));

  expect(report.elastics).toBe(1);
  expect(await Elastic.countDocuments()).toBe(1);

  // The sheet's spelling wins — an import may restyle an existing
  // product, it just may not fork it.
  const only = await Elastic.findOne();
  expect(only.name).toBe('Newday  Romeo Black');
  expect(only.nameKey).toBe('newday romeo black');
});

it('still adds a genuinely new product', async () => {
  await importWorkbook(sheetWith('NEWDAY ROMEO BLACK'));
  await importWorkbook(sheetWith('NEWDAY ROMEO WHITE'));
  expect(await Elastic.countDocuments()).toBe(2);
});

it('gives an inserted row its key, so the next import matches it', async () => {
  // On an upsert the key comes from the filter and the name from $set;
  // if those two ever disagreed the second import would insert again.
  await importWorkbook(sheetWith('Fresh Product'));
  const first = await Elastic.findOne();
  expect(first.nameKey).toBe('fresh product');

  await importWorkbook(sheetWith('FRESH PRODUCT'));
  expect(await Elastic.countDocuments()).toBe(1);
});
