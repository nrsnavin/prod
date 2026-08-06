'use strict';
//
// Pull the visible text out of a pdfkit Buffer, so a PDF test can assert
// on what the sheet SAYS rather than on its byte length.
//
// pdfkit writes each page's content as a Flate-compressed stream of
// operators; the text lands in `[<hex> kern <hex>] TJ` arrays, encoded
// WinAnsi by the built-in Helvetica. Decompress, pull the hex runs, and
// map the bytes back to characters.
//
// This is the only way these tests can catch the failure that matters
// with a printed document: a figure that is present in the data and
// absent from the paper.

const zlib = require('zlib');

const WINANSI_HIGH = {
  0x85: '…',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”',
  0x95: '•', 0x96: '–', 0x97: '—',
  0xa0: ' ', 0xb7: '·', 0xb9: '¹',
};

/**
 * Every drawn text run, IN DRAW ORDER.
 *
 * pdfkit emits one run per `.text()` call, so a table row arrives as
 * consecutive runs — cell, cell, cell. That ordering is what lets a
 * test assert a FIGURE SAT IN A PARTICULAR ROW rather than merely
 * appearing somewhere on the sheet. Without it, "is 40,710 on the
 * page?" passes even when the cost summary has lost its overhead line,
 * because the same number is in the job table's total.
 */
function pdfRuns(buffer) {
  const out = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(buffer.toString('latin1'))) !== null) {
    let body;
    try {
      body = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue; // not a Flate stream (fonts, images) — skip it
    }
    // Every hex run inside a TJ array is a piece of shown text.
    for (const t of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let line = '';
      for (const h of t[1].matchAll(/<([0-9A-Fa-f]+)>/g)) {
        const bytes = Buffer.from(h[1], 'hex');
        for (const b of bytes) {
          line += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : (WINANSI_HIGH[b] ?? '');
        }
      }
      if (line.trim()) out.push(line);
    }
    // Single-run shows: (text) Tj
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      const bytes = Buffer.from(t[1], 'hex');
      let line = '';
      for (const b of bytes) {
        line += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : (WINANSI_HIGH[b] ?? '');
      }
      if (line.trim()) out.push(line);
    }
  }
  return out;
}

/** The same runs, joined — for assertions that only need presence. */
function pdfText(buffer) {
  return pdfRuns(buffer).join('\n');
}

/**
 * Do these values appear as CONSECUTIVE runs — i.e. as one row?
 * Each expected value must be contained in the run at that position,
 * so a cell may carry extra text (a marker, a unit) around it.
 */
function hasRow(runs, expected) {
  const [first, ...rest] = expected.map(String);
  for (let i = 0; i < runs.length; i++) {
    if (!runs[i].includes(first)) continue;
    if (rest.every((v, k) => (runs[i + 1 + k] ?? '').includes(v))) return true;
  }
  return false;
}

/** How many pages the document ended up with. */
function pdfPageCount(buffer) {
  const s = buffer.toString('latin1');
  const m = s.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
  if (m) return Number(m[1]);
  return (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
}

module.exports = { pdfText, pdfRuns, hasRow, pdfPageCount };
