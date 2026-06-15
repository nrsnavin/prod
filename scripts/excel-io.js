#!/usr/bin/env node
/**
 * ════════════════════════════════════════════════════════════════
 *  excel-io.js  —  Raw Material + Elastic bulk import / export CLI
 *
 *  Thin wrapper around utils/excelIo.js (which holds the actual
 *  import/export/template logic, shared with the HTTP route in
 *  api/io.js). This file only deals with files + the DB connection.
 *
 *  Usage (run from the repo root so config/.env loads):
 *    node scripts/excel-io.js template <out.xlsx>   # blank + dropdowns
 *    node scripts/excel-io.js export   <out.xlsx>   # dump live DB
 *    node scripts/excel-io.js import   <in.xlsx>    # load into DB
 *
 *  See scripts/EXCEL_IO.md for the workbook format and dropdowns.
 * ════════════════════════════════════════════════════════════════
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });

const mongoose = require('mongoose');
const ExcelJS  = require('exceljs');

const auditFields = require('../models/plugins/auditFields.js');
mongoose.plugin(auditFields);

const {
  buildTemplateWorkbook,
  buildExportWorkbook,
  importWorkbook,
} = require('../utils/excelIo.js');

async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (!cmd || !['template', 'export', 'import'].includes(cmd) || !file) {
    console.error('Usage: node scripts/excel-io.js <template|export|import> <file.xlsx>');
    process.exit(1);
  }

  if (cmd === 'template') {
    await buildTemplateWorkbook().xlsx.writeFile(file);
    console.log(`Blank template (with dropdowns) written -> ${file}`);
    return;
  }

  if (!process.env.MONGO_URL) {
    throw new Error('MONGO_URL not set. Run from the repo root so config/.env loads.');
  }
  await mongoose.connect(process.env.MONGO_URL, {});
  console.log(`Connected: ${mongoose.connection.host}\n`);
  try {
    if (cmd === 'export') {
      const { workbook, counts } = await buildExportWorkbook();
      await workbook.xlsx.writeFile(file);
      console.log(`Exported -> ${file}`);
      console.log(`  suppliers=${counts.suppliers} rawMaterials=${counts.rawMaterials} `
                + `elastics=${counts.elastics} warpYarns=${counts.warpYarns}`);
    }
    if (cmd === 'import') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(file);
      const r = await importWorkbook(wb);
      console.log('Import complete:');
      console.log(`  suppliers upserted   = ${r.suppliers}`);
      console.log(`  rawMaterials upserted= ${r.materials}`);
      console.log(`  elastics upserted    = ${r.elastics}`);
      if (r.skipped.length) {
        console.log(`  SKIPPED (${r.skipped.length}):`);
        for (const s of r.skipped) console.log(`    - ${s}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
