'use strict';
/**
 * Shared Raw-Material + Elastic Excel logic.
 *
 * Operates on ExcelJS workbook objects and the Mongoose models, so
 * both the CLI tool (scripts/excel-io.js) and the HTTP route
 * (api/io.js) use the exact same import / export / template logic.
 * Nothing here touches the filesystem or the network — callers
 * decide where the bytes come from / go to.
 */
const ExcelJS = require('exceljs');

const Supplier    = require('../models/Supplier');
const RawMaterial = require('../models/RawMaterial');
const Elastic     = require('../models/Elastic');
const Costing     = require('../models/Costing');
const { calculateElasticCosting } = require('./elasticCosting.js');
const { elasticNameKey } = require('./elasticName.js');

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
    'conversionCost',
  ],
  ElasticWarpYarns: ['elasticName', 'material', 'ends', 'type', 'weight'],
  // Read-only reference in the elastic upload template: the raw materials
  // that exist, which the *_material dropdowns are drawn from.
  Materials: ['name', 'category', 'supplier', 'price'],
};

const MATERIAL_SRC = 'RawMaterials!$A$2:$A$1000';
const SUPPLIER_SRC = 'Suppliers!$A$2:$A$1000';
const DROPDOWNS = {
  RawMaterials: {
    supplierName: { range: SUPPLIER_SRC },
    category:     { list: 'warp,weft,covering,Rubber,other' },
  },
  Elastics: {
    warpSpandex_material:     { range: MATERIAL_SRC },
    spandexCovering_material: { range: MATERIAL_SRC },
    weftYarn_material:        { range: MATERIAL_SRC },
  },
  ElasticWarpYarns: { material: { range: MATERIAL_SRC } },
};
const DROPDOWN_ROWS = 1000;

const num = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const str = (v) => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') {
    if (typeof v.text === 'string')   v = v.text;
    else if ('result' in v)           v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
  }
  const s = String(v).trim();
  return s === '' ? undefined : s;
};

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

// ── Workbook writer (shared by template + export) ──────────────
function buildSheet(wb, name, rows, { dropdowns } = {}) {
  const cols = COLUMNS[name];
  const ws = wb.addWorksheet(name);
  ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.max(14, c.length + 3) }));

  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D6FEB' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  if (rows && rows.length) ws.addRows(rows);

  const dd = dropdowns || DROPDOWNS[name];
  if (dd) {
    for (const [header, cfg] of Object.entries(dd)) {
      const letter = colLetter(cols.indexOf(header) + 1);
      const formulae = cfg.range ? [cfg.range] : [`"${cfg.list}"`];
      ws.dataValidations.add(`${letter}2:${letter}${DROPDOWN_ROWS}`, {
        type: 'list', allowBlank: true, formulae, showErrorMessage: false,
      });
    }
  }
  return ws;
}

function buildTemplateWorkbook() {
  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('Instructions');
  info.getColumn(1).width = 110;
  [
    'Raw Material & Elastic import/export template',
    '',
    'Fill order: Suppliers -> RawMaterials -> Elastics -> ElasticWarpYarns.',
    'Everything links by NAME. The *_material and supplierName columns are DROPDOWNS',
    'sourced from the RawMaterials / Suppliers sheets — add your rows there first,',
    'then pick from the dropdown on the Elastics / ElasticWarpYarns sheets.',
    'An elastic can have many warp yarns: one row per yarn in ElasticWarpYarns (keyed by elasticName).',
  ].forEach((t, i) => { info.getCell(i + 1, 1).value = t; });
  info.getCell(1, 1).font = { bold: true, size: 13 };
  for (const name of ['Suppliers', 'RawMaterials', 'Elastics', 'ElasticWarpYarns']) buildSheet(wb, name, []);
  return wb;
}

// ── Export: pull DB → round-trippable workbook ─────────────────
async function buildExportWorkbook() {
  const [suppliers, materials, elastics] = await Promise.all([
    Supplier.find({}).lean(),
    RawMaterial.find({}).populate('supplier', 'name').lean(),
    Elastic.find({ archived: { $ne: true } })
      .populate('warpSpandex.id spandexCovering.id weftYarn.id warpYarn.id', 'name')
      .populate('costing', 'conversionCost')
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
  const elRows = [], warpRows = [];
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
      conversionCost: e.costing && e.costing.conversionCost,
    });
    for (const w of (e.warpYarn || [])) {
      warpRows.push({ elasticName: e.name, material: nameOf(w.id), ends: w.ends, type: w.type, weight: w.weight });
    }
  }

  const wb = new ExcelJS.Workbook();
  buildSheet(wb, 'Suppliers', supRows);
  buildSheet(wb, 'RawMaterials', matRows);
  buildSheet(wb, 'Elastics', elRows);
  buildSheet(wb, 'ElasticWarpYarns', warpRows);
  return { workbook: wb, counts: {
    suppliers: supRows.length, rawMaterials: matRows.length,
    elastics: elRows.length, warpYarns: warpRows.length,
  } };
}

// ── Import: workbook → DB (upsert by name) ─────────────────────
function readSheet(wb, name) {
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col] = str(cell.value); });
  const out = [];
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    const obj = { __row: rn };
    let any = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = headers[col];
      if (!h) return;
      obj[h] = cell.value;
      if (str(cell.value) !== undefined) any = true;
    });
    if (any) out.push(obj);
  });
  return out;
}

/**
 * @param {ExcelJS.Workbook} wb  already-loaded workbook
 * @returns {Promise<{suppliers,materials,elastics,skipped:string[]}>}
 */
async function importWorkbook(wb, { scope = 'all' } = {}) {
  const report = { suppliers: 0, materials: 0, elastics: 0, added: 0, updated: 0, skipped: [], warnings: [] };

  // The elastic upload reads ONLY the elastic sheets: a Materials sheet in
  // it is a reference to pick from, never something to write back.
  if (scope === 'elastics') {
    await importElasticSheets(wb, report);
    return report;
  }

  for (const row of readSheet(wb, 'Suppliers')) {
    const name = str(row.name);
    if (!name) continue;
    await Supplier.findOneAndUpdate(
      { name },
      { $set: {
          name, phoneNumber: str(row.phoneNumber), email: str(row.email),
          gstin: str(row.gstin), address: str(row.address), contactPerson: str(row.contactPerson),
        } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    report.suppliers++;
  }

  const supplierMap = new Map(
    (await Supplier.find({}, 'name').lean()).map((s) => [s.name, s._id]),
  );

  for (const row of readSheet(wb, 'RawMaterials')) {
    const name = str(row.name);
    if (!name) continue;
    const supplierName = str(row.supplierName);
    const supplierId = supplierName ? supplierMap.get(supplierName) : undefined;
    if (supplierName && !supplierId) {
      report.skipped.push(`RawMaterial "${name}": supplier "${supplierName}" not found`);
      continue;
    }
    // Stock only for a NEW material, as its opening figure. An existing
    // material's stock moves through the stock ledger (receipts, issues,
    // counts); a sheet setting it directly — or zeroing it from a blank
    // cell — left the ledger and the shelf disagreeing with nothing to
    // explain it.
    await RawMaterial.findOneAndUpdate(
      { name },
      {
        $set: {
          name, category: str(row.category) || 'other', supplier: supplierId,
          price: num(row.price) ?? 0, minStock: num(row.minStock) ?? 0,
        },
        $setOnInsert: { stock: num(row.stock) ?? 0 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    report.materials++;
  }

  await importElasticSheets(wb, report);

  return report;
}


// ── Elastics: upload by sheet, matched by name ─────────────────
//
// One row per elastic on "Elastics"; its warp yarns, one row each, on
// "ElasticWarpYarns" (keyed by elasticName). Materials are named, and
// must already exist — this never creates or changes a raw material.
//
// A row for an elastic that already exists UPDATES it, and a blank cell
// leaves that field as it is: a sheet holding only names and new weights
// must not zero every pick, hook count and testing figure it left empty,
// and an elastic with no warp-yarn rows keeps the warp yarns it has. A
// NEW elastic needs its spandex ends, pick, hooks and weight. A row that
// cannot be saved is skipped with the reason; the rest go in.

const foldName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

const PARTS = [
  { key: 'warpSpandex', label: 'Warp spandex', ends: true },
  { key: 'spandexCovering', label: 'Spandex covering' },
  { key: 'weftYarn', label: 'Weft yarn' },
];
const REQUIRED_FOR_NEW = ['spandexEnds', 'pick', 'noOfHook', 'weight'];

async function importElasticSheets(wb, report) {
  const materials = await RawMaterial.find({ archived: { $ne: true } }, 'name').lean();
  const materialByName = new Map(materials.map((m) => [foldName(m.name), m._id]));

  const warpRowsByKey = new Map();
  for (const row of readSheet(wb, 'ElasticWarpYarns')) {
    const en = str(row.elasticName);
    if (!en) continue;
    const key = elasticNameKey(en);
    if (!warpRowsByKey.has(key)) warpRowsByKey.set(key, []);
    warpRowsByKey.get(key).push(row);
  }
  const seen = new Set();

  for (const row of readSheet(wb, 'Elastics')) {
    const name = str(row.name);
    if (!name) continue;
    const where = `Elastics row ${row.__row} "${name}"`;
    const key = elasticNameKey(name);
    seen.add(key);
    const problems = [];

    const set = { name };
    const put = (path, v) => { if (v !== undefined) set[path] = v; };
    const nonNeg = (col) => {
      const v = num(row[col]);
      if (v !== undefined && v < 0) { problems.push(`${col} cannot be negative`); return undefined; }
      if (row[col] !== undefined && str(row[col]) !== undefined && v === undefined) {
        problems.push(`${col} must be a number`);
      }
      return v;
    };
    const material = (label, value) => {
      const n = str(value);
      if (!n) return undefined;
      const id = materialByName.get(foldName(n));
      if (!id) problems.push(`${label}: no raw material named "${n}" — add it under Raw Materials first`);
      return id;
    };

    put('weaveType', str(row.weaveType));
    for (const f of ['spandexEnds', 'yarnEnds', 'pick', 'noOfHook', 'weight', 'minStock']) put(f, nonNeg(f));
    put('testingParameters.width', nonNeg('width'));
    put('testingParameters.elongation', nonNeg('elongation'));
    put('testingParameters.recovery', nonNeg('recovery'));
    put('testingParameters.strech', str(row.strech));
    for (const part of PARTS) {
      put(`${part.key}.id`, material(part.label, row[`${part.key}_material`]));
      put(`${part.key}.weight`, nonNeg(`${part.key}_weight`));
      if (part.ends) put(`${part.key}.ends`, nonNeg(`${part.key}_ends`));
    }
    const warpRows = warpRowsByKey.get(key);
    if (warpRows) {
      set.warpYarn = warpRows.map((w) => ({
        id: material(`Warp yarn (ElasticWarpYarns row ${w.__row})`, w.material),
        ends: num(w.ends), type: str(w.type), weight: num(w.weight),
      })).filter((w) => w.id);
    }
    const conversion = nonNeg('conversionCost');

    const existing = await Elastic.findOne({ nameKey: key });
    if (!existing) {
      const missing = REQUIRED_FOR_NEW.filter((f) => set[f] === undefined);
      if (missing.length) problems.push(`a new elastic needs ${missing.join(', ')}`);
    }
    if (problems.length) { report.skipped.push(`${where}: ${problems.join('; ')}`); continue; }

    // Through the document, so the schema's own checks and the name key
    // run exactly as they do for one created on screen.
    const doc = existing || new Elastic({ weaveType: '8' });
    doc.set(set);
    try {
      await doc.save();
    } catch (err) {
      report.skipped.push(`${where}: ${err.message}`);
      continue;
    }

    try {
      const { materialCost, details } = await calculateElasticCosting(doc.toObject());
      const prior = doc.costing ? await Costing.findById(doc.costing).select('conversionCost').lean() : null;
      const conversionCost = conversion ?? prior?.conversionCost ?? 1.25;
      const costing = await Costing.findOneAndUpdate(
        { elastic: doc._id },
        { $set: {
            date: new Date(), elastic: doc._id, conversionCost, materialCost, details,
            totalCost: materialCost + conversionCost, status: 'Draft',
          } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      if (String(doc.costing) !== String(costing._id)) {
        doc.costing = costing._id;
        await doc.save();
      }
    } catch (err) {
      report.warnings.push(`${where}: saved, but its cost could not be worked out — ${err.message}`);
    }

    if (existing) report.updated++; else report.added++;
    report.elastics++;
  }

  for (const [key, rows] of warpRowsByKey) {
    if (!seen.has(key)) {
      report.skipped.push(
        `ElasticWarpYarns row ${rows[0].__row}: "${str(rows[0].elasticName)}" has no row on the Elastics sheet — add one (the name is enough)`
      );
    }
  }
}

// ── The elastic upload template ────────────────────────────────
//
// Instructions, the two sheets to fill, and the raw materials that exist
// as a reference sheet the material dropdowns are drawn from — so a
// material is picked, not typed, and a typo cannot invent one.
async function buildElasticTemplateWorkbook({ withExample = false } = {}) {
  const materials = await RawMaterial.find({ archived: { $ne: true } })
    .populate('supplier', 'name').sort({ category: 1, name: 1 }).lean();

  const wb = new ExcelJS.Workbook();
  const info = wb.addWorksheet('Instructions');
  info.getColumn(1).width = 26;
  info.getColumn(2).width = 12;
  info.getColumn(3).width = 70;
  info.getColumn(4).width = 18;
  const lines = [
    ['Elastic products — bulk upload'],
    [],
    ['1. Fill the Elastics sheet: one row per elastic.'],
    ['2. Fill ElasticWarpYarns: one row per warp yarn of each elastic (an elastic can have several).'],
    ['3. Pick materials from the dropdowns. They list the Materials sheet — the raw materials already in the app.'],
    ['   A material that is not there must be added under Raw Materials first.'],
    ['4. Upload it on the Elastic Products screen: Bulk upload.'],
    [],
    ['A row whose name matches an existing elastic UPDATES it; blank cells leave its values as they are.'],
    ['An elastic with no ElasticWarpYarns rows keeps the warp yarns it has. Rows that cannot be saved are listed with the reason.'],
    ['The cost sheet is worked out on upload from the grammages and today’s material prices.'],
    [],
    ['Column', 'Required', 'What it is', 'Example'],
    ['name', 'yes', 'Elastic name, as it should appear everywhere', '20mm Knitted White'],
    ['weaveType', '', 'Weave type (default 8)', '8'],
    ['spandexEnds', 'new', 'Number of spandex ends', '40'],
    ['yarnEnds', '', 'Number of yarn ends', '120'],
    ['pick', 'new', 'Pick', '12'],
    ['noOfHook', 'new', 'Number of hooks', '8'],
    ['weight', 'new', 'Weight, grams per metre', '2.4'],
    ['minStock', '', 'Reorder level, metres', '500'],
    ['width', '', 'Width, mm', '20'],
    ['elongation', '', 'Elongation % (default 120)', '120'],
    ['recovery', '', 'Recovery % (default 90)', '90'],
    ['strech', '', 'Stretch, as described', 'firm'],
    ['warpSpandex_material', '', 'Warp spandex (rubber) — pick from the list', 'Spandex 840D'],
    ['warpSpandex_ends', '', 'Warp spandex ends', '40'],
    ['warpSpandex_weight', '', 'Warp spandex, grams per metre', '0.5'],
    ['spandexCovering_material', '', 'Spandex covering — pick from the list', 'Cover 40D'],
    ['spandexCovering_weight', '', 'Covering, grams per metre', '0.2'],
    ['weftYarn_material', '', 'Weft yarn — pick from the list', 'Poly 300D'],
    ['weftYarn_weight', '', 'Weft, grams per metre', '0.4'],
    ['conversionCost', '', '₹ a metre on top of materials (default 1.25, or the elastic’s current one)', '1.5'],
    [],
    ['ElasticWarpYarns sheet'],
    ['elasticName', 'yes', 'The elastic’s name, as on the Elastics sheet', '20mm Knitted White'],
    ['material', 'yes', 'Warp yarn — pick from the list', 'Poly 150D'],
    ['ends', '', 'Ends of this yarn', '120'],
    ['type', '', 'Optional note, e.g. ground / binder', 'ground'],
    ['weight', '', 'This yarn, grams per metre', '1.0'],
    [],
    ['new = required when the elastic does not exist yet.'],
  ];
  lines.forEach((cells, i) => cells.forEach((v, j) => { info.getCell(i + 1, j + 1).value = v; }));
  info.getCell(1, 1).font = { bold: true, size: 14 };
  for (const r of [13, 35]) info.getRow(r).font = { bold: true };

  const n = Math.max(materials.length, 1) + 1;
  const src = `Materials!$A$2:$A$${n}`;
  const example = withExample && materials.length > 0;
  const pick = (cat) => materials.find((m) => foldName(m.category).includes(cat))?.name || materials[0]?.name;
  buildSheet(wb, 'Elastics', example ? [{
    name: '20mm Knitted White (example — replace)', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12,
    noOfHook: 8, weight: 2.4, minStock: 500, width: 20, elongation: 120, recovery: 90, strech: 'firm',
    warpSpandex_material: pick('rubber') || pick('spandex'), warpSpandex_ends: 40, warpSpandex_weight: 0.5,
    spandexCovering_material: pick('cover'), spandexCovering_weight: 0.2,
    weftYarn_material: pick('weft'), weftYarn_weight: 0.4, conversionCost: 1.5,
  }] : [], {
    dropdowns: {
      warpSpandex_material: { range: src },
      spandexCovering_material: { range: src },
      weftYarn_material: { range: src },
    },
  });
  buildSheet(wb, 'ElasticWarpYarns', example ? [
    { elasticName: '20mm Knitted White (example — replace)', material: pick('warp'), ends: 120, type: 'ground', weight: 1.0 },
  ] : [], { dropdowns: { material: { range: src } } });
  const ref = buildSheet(wb, 'Materials', materials.map((m) => ({
    name: m.name, category: m.category, supplier: m.supplier?.name || '', price: m.price || 0,
  })), { dropdowns: {} });
  ref.getColumn(1).width = 34;
  await ref.protect('', { selectLockedCells: true, selectUnlockedCells: true, autoFilter: true, sort: true });
  return wb;
}

module.exports = {
  COLUMNS,
  buildTemplateWorkbook,
  buildElasticTemplateWorkbook,
  buildExportWorkbook,
  importWorkbook,
};
