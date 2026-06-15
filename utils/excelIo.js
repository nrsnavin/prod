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
function buildSheet(wb, name, rows) {
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

  const dd = DROPDOWNS[name];
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
  for (const name of Object.keys(COLUMNS)) buildSheet(wb, name, []);
  return wb;
}

// ── Export: pull DB → round-trippable workbook ─────────────────
async function buildExportWorkbook() {
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
    const obj = {};
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
async function importWorkbook(wb) {
  const report = { suppliers: 0, materials: 0, elastics: 0, skipped: [] };

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
    await RawMaterial.findOneAndUpdate(
      { name },
      { $set: {
          name, category: str(row.category) || 'other', supplier: supplierId,
          price: num(row.price) ?? 0, stock: num(row.stock) ?? 0, minStock: num(row.minStock) ?? 0,
        } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    report.materials++;
  }

  const materialMap = new Map(
    (await RawMaterial.find({}, 'name').lean()).map((m) => [m.name, m._id]),
  );
  const resolveMat = (n, ctx, missing) => {
    const name = str(n);
    if (!name) return undefined;
    const id = materialMap.get(name);
    if (!id) missing.push(`${ctx}: material "${name}" not found`);
    return id;
  };

  const warpByElastic = new Map();
  for (const row of readSheet(wb, 'ElasticWarpYarns')) {
    const en = str(row.elasticName);
    if (!en) continue;
    if (!warpByElastic.has(en)) warpByElastic.set(en, []);
    warpByElastic.get(en).push(row);
  }

  for (const row of readSheet(wb, 'Elastics')) {
    const name = str(row.name);
    if (!name) continue;
    const missing = [];
    const warpYarn = (warpByElastic.get(name) || []).map((w) => ({
      id: resolveMat(w.material, `Elastic "${name}" warpYarn`, missing),
      ends: num(w.ends), type: str(w.type), weight: num(w.weight),
    })).filter((w) => w.id);

    const doc = {
      name,
      weaveType: str(row.weaveType) || '8',
      spandexEnds: num(row.spandexEnds) ?? 0,
      yarnEnds: num(row.yarnEnds),
      pick: num(row.pick) ?? 0,
      noOfHook: num(row.noOfHook) ?? 0,
      weight: num(row.weight) ?? 0,
      minStock: num(row.minStock) ?? 0,
      testingParameters: {
        width: num(row.width), elongation: num(row.elongation) ?? 120,
        recovery: num(row.recovery) ?? 90, strech: str(row.strech),
      },
      warpSpandex: {
        id: resolveMat(row.warpSpandex_material, `Elastic "${name}" warpSpandex`, missing),
        ends: num(row.warpSpandex_ends), weight: num(row.warpSpandex_weight),
      },
      spandexCovering: {
        id: resolveMat(row.spandexCovering_material, `Elastic "${name}" spandexCovering`, missing),
        weight: num(row.spandexCovering_weight),
      },
      weftYarn: {
        id: resolveMat(row.weftYarn_material, `Elastic "${name}" weftYarn`, missing),
        weight: num(row.weftYarn_weight),
      },
      warpYarn,
    };

    if (missing.length) { report.skipped.push(...missing); continue; }

    const { materialCost, details } = await calculateElasticCosting(doc);
    const conversionCost = 1.25;
    const totalCost = materialCost + conversionCost;

    const elastic = await Elastic.findOneAndUpdate(
      { name }, { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const costing = await Costing.findOneAndUpdate(
      { elastic: elastic._id },
      { $set: { date: new Date(), elastic: elastic._id, conversionCost, materialCost, details, totalCost, status: 'Draft' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    if (String(elastic.costing) !== String(costing._id)) {
      elastic.costing = costing._id;
      await elastic.save();
    }
    report.elastics++;
  }

  return report;
}

module.exports = {
  COLUMNS,
  buildTemplateWorkbook,
  buildExportWorkbook,
  importWorkbook,
};
