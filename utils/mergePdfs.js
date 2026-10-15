'use strict';
// Several PDFs as one, in the order given — for printing a selection
// (challans, order reports) in one go rather than a file per document.

const { PDFDocument } = require('pdf-lib');

async function mergePdfs(buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    const src = await PDFDocument.load(buf);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

module.exports = { mergePdfs };
