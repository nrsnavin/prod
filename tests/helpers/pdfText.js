'use strict';
//
// Pull the visible text out of a pdfkit Buffer, so a PDF test can assert
// on what the sheet SAYS rather than on its byte length.
//
// pdfkit writes each page's content as a Flate-compressed stream of
// operators; the text lands in `[<hex> kern <hex>] TJ` arrays. With the
// built-in Helvetica the hex is WinAnsi, one byte a character. With an
// embedded TrueType font (the invoice, for its rupee sign) it is glyph
// ids, two bytes each, and the font's ToUnicode CMap says which
// character each one is — so the runs are decoded through whichever
// font the stream had selected (`/F2 8.5 Tf`) when they were drawn.
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

const winAnsi = (bytes) => {
  let s = '';
  for (const b of bytes) s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : (WINANSI_HIGH[b] ?? '');
  return s;
};

/** The bytes of object `num`'s stream, inflated; null when there is none. */
function streamOf(pdf, num) {
  const re = new RegExp(`(?:^|\\n)${num} 0 obj\\b([\\s\\S]*?)endobj`);
  const m = re.exec(pdf);
  if (!m) return null;
  const s = /stream\r?\n([\s\S]*?)endstream/.exec(m[1]);
  if (!s) return null;
  try { return zlib.inflateSync(Buffer.from(s[1], 'latin1')).toString('latin1'); } catch { return s[1]; }
}

/** The dictionary text of object `num`. */
function dictOf(pdf, num) {
  const m = new RegExp(`(?:^|\\n)${num} 0 obj\\s*<<([\\s\\S]*?)>>\\s*(?:stream|endobj)`).exec(pdf);
  return m ? m[1] : '';
}

// A glyph that stands for several characters (a ligature, "fl") is
// written as `<0066 006C>`, the units separated by spaces.
const utf16 = (hex) => {
  const buf = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
  let s = '';
  for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
  return s;
};

/** code → character, from a ToUnicode CMap (bfchar, bfrange, and pdfkit's array bfrange). */
function parseCmap(text) {
  const map = new Map();
  for (const sect of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of sect[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]+)>/g)) map.set(parseInt(m[1], 16), utf16(m[2]));
  }
  for (const sect of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of sect[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((x) => utf16(x[1]));
        items.forEach((ch, i) => map.set(lo + i, ch));
      } else {
        const base = parseInt(m[3].slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      }
    }
  }
  return map;
}

/** Font resource name (F1, F2 …) → ToUnicode map, for the embedded fonts only. */
function fontMaps(pdf) {
  const maps = new Map();
  for (const m of pdf.matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
    const [, name, num] = m;
    if (maps.has(name)) continue;
    const dict = dictOf(pdf, num);
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dict);
    if (!tu) { maps.set(name, null); continue; }
    const cmap = streamOf(pdf, tu[1]);
    maps.set(name, cmap ? parseCmap(cmap) : null);
  }
  return maps;
}

function decodeHex(hex, cmap) {
  const bytes = Buffer.from(hex, 'hex');
  if (!cmap) return winAnsi(bytes);
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += cmap.get((bytes[i] << 8) | bytes[i + 1]) ?? '';
  return s;
}

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
  const pdf = buffer.toString('latin1');
  const fonts = fontMaps(pdf);
  const out = [];
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(pdf)) !== null) {
    let body;
    try {
      body = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue; // not a Flate stream (fonts, images) — skip it
    }
    if (!/\bT[Jj]\b/.test(body)) continue; // a CMap or an image, not a page
    let cmap = null;
    // Font selections and text shows, in the order the stream has them.
    for (const t of body.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj/g)) {
      if (t[1]) { cmap = fonts.get(t[1]) ?? null; continue; }
      let line = '';
      if (t[2] !== undefined) {
        for (const h of t[2].matchAll(/<([0-9A-Fa-f]+)>/g)) line += decodeHex(h[1], cmap);
      } else {
        line = decodeHex(t[3], cmap);
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
