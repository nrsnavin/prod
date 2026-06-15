'use strict';
/**
 * ════════════════════════════════════════════════════════════════
 *  Data import / export (Raw Materials + Elastics) over HTTP.
 *  Mount: app.use('/api/v2/io', require('./api/io.js'));
 *
 *    GET  /template        download the blank workbook (dropdowns)
 *    GET  /export          download the live DB as a workbook
 *    POST /import          upload a filled workbook (multipart 'file')
 *
 *  All three reuse utils/excelIo.js, the same logic the CLI uses,
 *  so the app and the command line can't drift apart.
 * ════════════════════════════════════════════════════════════════
 */
const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const ExcelJS = require('exceljs');

const { isAuthenticated, isAdmin } = require('../middleware/auth');
const {
  buildTemplateWorkbook,
  buildExportWorkbook,
  importWorkbook,
} = require('../utils/excelIo.js');

// In-memory upload, 5 MB cap. A material/elastic workbook is tiny;
// the cap stops someone streaming a huge file into the parser.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── GET /template ──────────────────────────────────────────────
router.get('/template', isAuthenticated, isAdmin('admin'), async (_req, res, next) => {
  try {
    const wb = buildTemplateWorkbook();
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition',
      'attachment; filename="material_elastic_template.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// ── GET /export ────────────────────────────────────────────────
router.get('/export', isAuthenticated, isAdmin('admin'), async (_req, res, next) => {
  try {
    const { workbook } = await buildExportWorkbook();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader('Content-Disposition',
      `attachment; filename="material_elastic_export_${stamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

// ── POST /import ───────────────────────────────────────────────
router.post(
  '/import',
  isAuthenticated, isAdmin('admin'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, message: 'No file uploaded (field name must be "file").' });
      }
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(req.file.buffer);
      } catch (_) {
        return res.status(400).json({ success: false, message: 'Could not read the file as an .xlsx workbook.' });
      }

      const report = await importWorkbook(wb);
      return res.json({
        success: true,
        message:
          `Imported ${report.suppliers} suppliers, ${report.materials} raw materials, `
          + `${report.elastics} elastics.`
          + (report.skipped.length ? ` ${report.skipped.length} row(s) skipped.` : ''),
        ...report,
      });
    } catch (err) { next(err); }
  },
);

module.exports = router;
