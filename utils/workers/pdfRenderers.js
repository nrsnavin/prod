'use strict';
// The PDF renderers a worker may run, by name. Each entry is the module
// and the export that builds the document; every one of them is pure —
// plain data in, a Buffer out. Required lazily, so a worker only loads
// the renderers it is actually asked for.

const RENDERERS = Object.freeze({
  mrp:            ['../mrpPdf', 'buildMrpPdf'],
  orderStatus:    ['../orderStatusPdf', 'buildOrderStatusPdf'],
  orderPnl:       ['../orderPnlPdf', 'buildOrderPnlPdf'],
  materialLedger: ['../materialLedgerPdf', 'buildMaterialLedgerPdf'],
  shiftSheet:     ['../shiftSheetPdf', 'buildShiftSheetPdf'],
  morningDigest:  ['../reportPdf', 'buildMorningDigestPdf'],
  eveningReport:  ['../reportPdf', 'buildEveningReportPdf'],
  template:       ['../../services/pdf/templateRenderer', 'renderTemplatePdf'],
});

async function render(name, args) {
  const entry = RENDERERS[name];
  if (!entry) throw new Error(`Unknown PDF "${name}"`);
  const [mod, fn] = entry;
  const build = require(mod)[fn];
  if (typeof build !== 'function') throw new Error(`PDF "${name}" has no ${fn}()`);
  const out = await build(...args);
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

module.exports = { RENDERERS, render };
