#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════
 *  excel-io.js  —  Raw Material + Elastic bulk import / export
 *
 *  ONE workbook is both the import and the export format. Every
 *  cross-reference is by NAME, never by Mongo _id, so the file
 *  round-trips: export → edit in Excel → re-import.
 *
 *  Sheets (filled / read in dependency order):
 *    Suppliers          name is the key
 *    RawMaterials       references a supplier via `supplierName`
 *    Elastics           one row per elastic; references raw
 *                       materials by NAME in the *_material columns
 *    ElasticWarpYarns   header/detail split for the warpYarn[] array
 *                       — one row per warp yarn, linked by `elasticName`
 *
 *  Usage (run from the repo root so config/.env loads):
 *    node scripts/excel-io.js template <out.xlsx>   # blank template
 *    node scripts/excel-io.js export   <out.xlsx>   # dump live DB
 *    node scripts/excel-io.js import   <in.xlsx>    # load into DB
 *
 *  Import semantics: UPSERT by name on every sheet. Re-importing a
 *  row whose name already exists updates it in place. A *_material
 *  value must match a RawMaterials.name present in the file or
 *  already in the DB, otherwise that elastic row is reported and
 *  skipped (nothing partial is written for it).
 * ════════════════════════════════════════════════════════════════
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });

const mongoose = require('mongoose');
const XLSX     = require('xlsx');

const auditFields = require('../models/plugins/auditFields.js');
mongoose.plugin(auditFields);

const Supplier    = require('../models/Supplier');
const RawMaterial = require('../models/RawMaterial');
const Elastic     = require('../models/Elastic');
const Costing     = require('../models/Costing');
const { calculateElasticCosting } = require('../utils/elasticCosting.js');

// ── Sheet column contracts (single source of truth) ────────────
const COLUMNS = {
  Suppliers:    ['name', 'phoneNumber', 'email', 'gstin', 'address', 'contactPerson'],
  RawMaterials: ['name', 'category', 'supplierName', 'price', 'stock', 'minStock'],
  Elastics: [
    'name', 'weaveType', 'spandexEnds', 'yarnEnds', 'pick', 'noOfHook', 'weight', 'minStock',
    'width', 'elongation', 'recovery', 'strech',
    'warpSpandex_material', 'warpSpandex_ends', 'warpSpandex_weight',
    'spandexCovering_material', 'spandexCovering_weight',
    'weftYarn_material', 'weftYarn_weight',
  ],
  ElasticWarpYarns: ['elasticName', 'material', 'ends', 'type', 'weight'],
};

const num = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v) => (v === undefined || v === null) ? undefined : String(v).trim();

// ════════════════════════════════════════════════════════════════
//  TEMPLATE  —  write a blank workbook with headers only
// ════════════════════════════════════════════════════════════════
function writeTemplate(outPath) {
  const wb = XLSX.utils.book_new();
  const instructions = [
    ['Raw Material & Elastic import/export template'],
    ['Fill sheets in order: Suppliers -> RawMaterials -> Elastics -> ElasticWarpYarns.'],
    ['Everything links by NAME. *_material must match a RawMaterials.name.'],
    ['An elastic can have many warp yarns: add one row per yarn in ElasticWarpYarns, keyed by elasticName.'],
    ['Import: node scripts/excel-io.js import <file.xlsx>   Export: node scripts/excel-io.js export <file.xlsx>'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(instructions), 'Instructions');
  for (const [sheet, cols] of Object.entries(COLUMNS)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols]), sheet);
  }
  XLSX.writeFile(wb, outPath);
  console.log(`Blank template written -> ${outPath}`);
}

// ════════════════════════════════════════════════════════════════
//  EXPORT  —  dump live DB into the round-trippable workbook
// ════════════════════════════════════════════════════════════════
async function exportAll(outPath) {
  const [suppliers, materials, elastics] = await Promise.all([
    Supplier.find({}).lean(),
    RawMaterial.find({}).populate('supplier', 'name').lean(),
    Elastic.find({ archived: { $ne: true } })
      .populate('warpSpandex.id spandexCovering.id weftYarn.id warpYarn.id', 'name')
      .lean(),
  ]);

  const nameOf = (ref) => (ref && ref.name) ? ref.name : '';

  const supRows = suppliers.map((s) => ({
    name: s.name, phoneNumber: s.phoneNumber || '', email: s.email || '',
    gstin: s.gstin || '', address: s.address || '', contactPerson: s.contactPerson || '',
  }));

  const matRows = materials.map((m) => ({
    name: m.name, category: m.category, supplierName: nameOf(m.supplier),
    price: m.price || 0, stock: m.stock || 0, minStock: m.minStock || 0,
  }));

  const elRows = [];
  const warpRows = [];
  for (const e of elastics) {
    const tp = e.testingParameters || {};
    elRows.push({
      name: e.name, weaveType: e.weaveType, spandexEnds: e.spandexEnds,
      yarnEnds: e.yarnEnds, pick: e.pick, noOfHook: e.noOfHook,
      weight: e.weight, minStock: e.minStock || 0,
      width: tp.width, elongation: tp.elongation, recovery: tp.recovery, strech: tp.strech,
      warpSpandex_material: nameOf(e.warpSpandex && e.warpSpandex.id),
      warpSpandex_ends: e.warpSpandex && e.warpSpandex.ends,
      warpSpandex_weight: e.warpSpandex && e.warpSpandex.weight,
      spandexCovering_material: nameOf(e.spandexCovering && e.spandexCovering.id),
      spandexCovering_weight: e.spandexCovering && e.spandexCovering.weight,
      weftYarn_material: nameOf(e.weftYarn && e.weftYarn.id),
      weftYarn_weight: e.weftYarn && e.weftYarn.weight,
    });
    for (const w of (e.warpYarn || [])) {
      warpRows.push({
        elasticName: e.name, material: nameOf(w.id),
        ends: w.ends, type: w.type, weight: w.weight,
      });
    }
  }

  const wb = XLSX.utils.book_new();
  const sheet = (cols, rows) =>
    XLSX.utils.json_to_sheet(rows, { header: cols });
  XLSX.utils.book_append_sheet(wb, sheet(COLUMNS.Suppliers, supRows), 'Suppliers');
  XLSX.utils.book_append_sheet(wb, sheet(COLUMNS.RawMaterials, matRows), 'RawMaterials');
  XLSX.utils.book_append_sheet(wb, sheet(COLUMNS.Elastics, elRows), 'Elastics');
  XLSX.utils.book_append_sheet(wb, sheet(COLUMNS.ElasticWarpYarns, warpRows), 'ElasticWarpYarns');
  XLSX.writeFile(wb, outPath);

  console.log(`Exported -> ${outPath}`);
  console.log(`  suppliers=${supRows.length} rawMaterials=${matRows.length} `
            + `elastics=${elRows.length} warpYarns=${warpRows.length}`);
}

// ════════════════════════════════════════════════════════════════
//  IMPORT  —  load the workbook into the DB (upsert by name)
// ════════════════════════════════════════════════════════════════
function readSheet(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

async function importAll(inPath) {
  const wb = XLSX.readFile(inPath);
  const report = { suppliers: 0, materials: 0, elastics: 0, skipped: [] };

  // ── 1. Suppliers ──────────────────────────────────────────
  for (const row of readSheet(wb, 'Suppliers')) {
    const name = str(row.name);
    if (!name) continue;
    await Supplier.findOneAndUpdate(
      { name },
      { $set: {
          name,
          phoneNumber:   str(row.phoneNumber),
          email:         str(row.email),
          gstin:         str(row.gstin) || undefined,
          address:       str(row.address),
          contactPerson: str(row.contactPerson),
        } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    report.suppliers++;
  }

  // Build supplier name -> _id map (covers pre-existing + just-added).
  const supplierMap = new Map(
    (await Supplier.find({}, 'name').lean()).map((s) => [s.name, s._id]),
  );

  // ── 2. Raw materials ──────────────────────────────────────
  for (const row of readSheet(wb, 'RawMaterials')) {
    const name = str(row.name);
    if (!name) continue;
    const supplierName = str(row.supplierName);
    const supplierId = supplierName ? supplierMap.get(supplierName) : undefined;
    if (supplierName && !supplierId) {
      report.skipped.push(`RawMaterial "${name}": supplier "${supplierName}" not found`);
      continue;
    }
    await RawMaterial.findOneAndUpdate(
      { name },
      { $set: {
          name,
          category: str(row.category) || 'other',
          supplier: supplierId,
          price:    num(row.price)    ?? 0,
          stock:    num(row.stock)    ?? 0,
          minStock: num(row.minStock) ?? 0,
        } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    report.materials++;
  }

  // Build raw-material name -> _id map.
  const materialMap = new Map(
    (await RawMaterial.find({}, 'name').lean()).map((m) => [m.name, m._id]),
  );
  const resolveMat = (name, ctx, missing) => {
    const n = str(name);
    if (!n) return undefined;
    const id = materialMap.get(n);
    if (!id) missing.push(`${ctx}: material "${n}" not found`);
    return id;
  };

  // ── 3. Group warp yarns by elastic name ───────────────────
  const warpByElastic = new Map();
  for (const row of readSheet(wb, 'ElasticWarpYarns')) {
    const en = str(row.elasticName);
    if (!en) continue;
    if (!warpByElastic.has(en)) warpByElastic.set(en, []);
    warpByElastic.get(en).push(row);
  }

  // ── 4. Elastics (upsert + recompute costing) ──────────────
  for (const row of readSheet(wb, 'Elastics')) {
    const name = str(row.name);
    if (!name) continue;
    const missing = [];

    const warpYarn = (warpByElastic.get(name) || []).map((w) => ({
      id:     resolveMat(w.material, `Elastic "${name}" warpYarn`, missing),
      ends:   num(w.ends),
      type:   str(w.type),
      weight: num(w.weight),
    })).filter((w) => w.id);

    const doc = {
      name,
      weaveType:   str(row.weaveType) || '8',
      spandexEnds: num(row.spandexEnds) ?? 0,
      yarnEnds:    num(row.yarnEnds),
      pick:        num(row.pick) ?? 0,
      noOfHook:    num(row.noOfHook) ?? 0,
      weight:      num(row.weight) ?? 0,
      minStock:    num(row.minStock) ?? 0,
      testingParameters: {
        width:      num(row.width),
        elongation: num(row.elongation) ?? 120,
        recovery:   num(row.recovery) ?? 90,
        strech:     str(row.strech),
      },
      warpSpandex: {
        id:     resolveMat(row.warpSpandex_material, `Elastic "${name}" warpSpandex`, missing),
        ends:   num(row.warpSpandex_ends),
        weight: num(row.warpSpandex_weight),
      },
      spandexCovering: {
        id:     resolveMat(row.spandexCovering_material, `Elastic "${name}" spandexCovering`, missing),
        weight: num(row.spandexCovering_weight),
      },
      weftYarn: {
        id:     resolveMat(row.weftYarn_material, `Elastic "${name}" weftYarn`, missing),
        weight: num(row.weftYarn_weight),
      },
      warpYarn,
    };

    if (missing.length) {
      report.skipped.push(...missing);
      continue;   // never write a partially-linked elastic
    }

    // Costing reuses the exact server util — materials must exist
    // (they do, we just resolved them).
    const { materialCost, details } = await calculateElasticCosting(doc);
    const conversionCost = 1.25;
    const totalCost = materialCost + conversionCost;

    const elastic = await Elastic.findOneAndUpdate(
      { name },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // One Costing row per elastic, refreshed on each import.
    const costing = await Costing.findOneAndUpdate(
      { elastic: elastic._id },
      { $set: {
          date: new Date(), elastic: elastic._id,
          conversionCost, materialCost, details, totalCost, status: 'Draft',
        } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (String(elastic.costing) !== String(costing._id)) {
      elastic.costing = costing._id;
      await elastic.save();
    }
    report.elastics++;
  }

  console.log('Import complete:');
  console.log(`  suppliers upserted   = ${report.suppliers}`);
  console.log(`  rawMaterials upserted= ${report.materials}`);
  console.log(`  elastics upserted    = ${report.elastics}`);
  if (report.skipped.length) {
    console.log(`  SKIPPED (${report.skipped.length}):`);
    for (const s of report.skipped) console.log(`    - ${s}`);
  }
}

// ════════════════════════════════════════════════════════════════
//  CLI
// ════════════════════════════════════════════════════════════════
async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (!cmd || !['template', 'export', 'import'].includes(cmd) || !file) {
    console.error('Usage: node scripts/excel-io.js <template|export|import> <file.xlsx>');
    process.exit(1);
  }

  // `template` is offline — no DB needed.
  if (cmd === 'template') {
    writeTemplate(file);
    return;
  }

  if (!process.env.MONGO_URL) {
    throw new Error('MONGO_URL not set. Run from the repo root so config/.env loads.');
  }
  await mongoose.connect(process.env.MONGO_URL, {});
  console.log(`Connected: ${mongoose.connection.host}\n`);
  try {
    if (cmd === 'export') await exportAll(file);
    if (cmd === 'import') await importAll(file);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
