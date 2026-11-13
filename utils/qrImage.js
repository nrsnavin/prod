'use strict';
// ═════════════════════════════════════════════════════════════════
//  THE QR CODES IN A PHOTO OR A PDF
//
//  A supplier's e-invoice carries a QR code signed by the GST portal
//  (utils/einvoiceQr.js reads it). This finds QR codes in what a bill
//  arrives as: a phone photo (JPEG or PNG), or a PDF from the supplier's
//  billing software, where the code is an image inside the page.
//
//    qrTexts({ buffer, mimetype }) → Promise<string[]>   (may be empty)
//
//  Photos are decoded here (jpeg-js, pngjs) and searched with jsQR, the
//  library the web app's scanner uses. In a PDF only the images are
//  searched, and only the square ones a QR code would be: a code drawn
//  as vector boxes, or an image in a format other than JPEG or
//  Flate-compressed pixels, is not found, and the bill is read as before.
//  Nothing here throws on a file it cannot read: it finds nothing.
// ═════════════════════════════════════════════════════════════════
const zlib = require('zlib');
const jsQR = require('jsqr');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

/** A dense code (an e-invoice's holds a signed token) needs pixels; past this a photo is shrunk. */
const SIDES = [2400, 1600, 1000];
const MAX_PDF_IMAGES = 12;

/** RGBA pixels, shrunk by sampling so the longer side is at most `side`. */
function shrink(img, side) {
  const { width: w, height: h, data } = img;
  const scale = Math.min(1, side / Math.max(w, h));
  if (scale === 1) return img;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const s = (sy * w + sx) * 4;
      const d = (y * nw + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
    }
  }
  return { width: nw, height: nh, data: out };
}

/** The code in one picture, trying it large first and then smaller. */
function decode(img) {
  if (!img || !(img.width > 20) || !(img.height > 20)) return null;
  const tried = new Set();
  for (const side of SIDES) {
    const s = shrink(img, side);
    const key = `${s.width}x${s.height}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const data = s.data instanceof Uint8ClampedArray ? s.data : new Uint8ClampedArray(s.data.buffer, s.data.byteOffset, s.data.byteLength);
    const found = jsQR(data, s.width, s.height, { inversionAttempts: 'attemptBoth' });
    if (found && found.data) return found.data;
  }
  return null;
}

function photoPixels(buffer, mimetype) {
  if (mimetype === 'image/jpeg') {
    const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 60, maxMemoryUsageInMB: 600 });
    return { width: raw.width, height: raw.height, data: raw.data };
  }
  if (mimetype === 'image/png') {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  return null;
}

// ── Images inside a PDF ──────────────────────────────────────────
const nameOf = (v) => (v && typeof v.asString === 'function' ? v.asString() : v && v.encodedName) || String(v || '');
const numberOf = (v) => (v && typeof v.asNumber === 'function' ? v.asNumber() : Number(v));

/** PNG row filters, which a Flate image with /Predictor 10–15 carries per row. */
function unpredict(buf, columns, colors, bpc) {
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
  const rowLen = Math.ceil(columns * colors * bpc / 8);
  const rows = Math.floor(buf.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  let prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = buf[r * (rowLen + 1)];
    const line = buf.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = Buffer.alloc(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 0xff;
    }
    cur.copy(out, r * rowLen);
    prev = cur;
  }
  return out;
}

/** Samples (1, 2, 4 or 8 bits) → RGBA, through a palette when there is one. */
function samplesToRgba(raw, width, height, comps, bpc, palette, invert) {
  const data = new Uint8ClampedArray(width * height * 4);
  const rowBits = width * comps * bpc;
  const rowBytes = Math.ceil(rowBits / 8);
  const max = (1 << bpc) - 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = [];
      for (let c = 0; c < comps; c++) {
        const bit = x * comps * bpc + c * bpc;
        const byte = raw[y * rowBytes + (bit >> 3)] || 0;
        let v = bpc === 8 ? byte : (byte >> (8 - bpc - (bit & 7))) & max;
        if (invert) v = max - v;
        px.push(v);
      }
      let r; let g; let b;
      if (palette) {
        const i = px[0] * palette.comps;
        if (palette.comps === 1) { r = g = b = palette.bytes[i] || 0; } else { r = palette.bytes[i] || 0; g = palette.bytes[i + 1] || 0; b = palette.bytes[i + 2] || 0; }
      } else if (comps === 1) {
        r = g = b = Math.round(px[0] * 255 / max);
      } else if (comps === 3) {
        [r, g, b] = px.map((v) => Math.round(v * 255 / max));
      } else if (comps === 4) {
        const [cc, m, yy, k] = px.map((v) => v / max);
        r = 255 * (1 - cc) * (1 - k); g = 255 * (1 - m) * (1 - k); b = 255 * (1 - yy) * (1 - k);
      } else {
        return null;
      }
      const d = (y * width + x) * 4;
      data[d] = r; data[d + 1] = g; data[d + 2] = b; data[d + 3] = 255;
    }
  }
  return { width, height, data };
}

/** How many colour components a colour space has, and its palette when indexed. */
function colourSpace(cs, context, key) {
  const lookup = (v) => (v && v.constructor && v.constructor.name === 'PDFRef' ? context.lookup(v) : v);
  cs = lookup(cs);
  if (!cs) return { comps: 1 };
  const n = nameOf(cs).replace(/^\//, '');
  if (n === 'DeviceGray' || n === 'CalGray' || n === 'G') return { comps: 1 };
  if (n === 'DeviceRGB' || n === 'CalRGB' || n === 'RGB') return { comps: 3 };
  if (n === 'DeviceCMYK' || n === 'CMYK') return { comps: 4 };
  if (typeof cs.asArray === 'function') {
    const arr = cs.asArray();
    const kind = nameOf(arr[0]).replace(/^\//, '');
    if (kind === 'ICCBased') {
      const stream = lookup(arr[1]);
      const N = stream && stream.dict ? numberOf(stream.dict.get(key('N'))) : NaN;
      return { comps: [1, 3, 4].includes(N) ? N : 3 };
    }
    if (kind === 'Indexed' || kind === 'I') {
      const base = colourSpace(arr[1], context, key);
      const table = lookup(arr[3]);
      let bytes = null;
      if (table && typeof table.asBytes === 'function') bytes = Buffer.from(table.asBytes());
      else if (table && table.contents) bytes = Buffer.from(table.contents);
      if (!bytes || base.palette) return null;
      return { comps: 1, palette: { comps: base.comps, bytes } };
    }
    if (kind === 'CalRGB') return { comps: 3 };
    if (kind === 'CalGray') return { comps: 1 };
  }
  return null;
}

async function pdfImages(buffer) {
  const { PDFDocument, PDFName, PDFRawStream } = require('pdf-lib');
  let pdf;
  try { pdf = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false }); } catch (_) { return []; }
  const ctx = pdf.context;
  const key = (k) => PDFName.of(k);
  const found = [];
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    if (nameOf(dict.get(key('Subtype'))) !== '/Image') continue;
    const width = numberOf(dict.get(key('Width')));
    const height = numberOf(dict.get(key('Height')));
    // A QR code is square; its picture is too, give or take a margin.
    if (!(width >= 40 && height >= 40) || width > 5000 || height > 5000) continue;
    const ratio = width / height;
    if (ratio < 0.8 || ratio > 1.25) continue;
    found.push({ obj, dict, width, height });
  }
  const images = [];
  for (const { obj, dict, width, height } of found.slice(0, MAX_PDF_IMAGES)) {
    try {
      let filter = ctx.lookup(dict.get(key('Filter')));
      if (filter && typeof filter.asArray === 'function') { const arr = filter.asArray(); if (arr.length !== 1) continue; filter = arr[0]; }
      const f = filter ? nameOf(filter).replace(/^\//, '') : '';
      const bytes = Buffer.from(obj.contents);
      if (f === 'DCTDecode' || f === 'DCT') {
        images.push(photoPixels(bytes, 'image/jpeg'));
        continue;
      }
      if (f !== 'FlateDecode' && f !== 'Fl' && f !== '') continue;
      let raw = f ? zlib.inflateSync(bytes) : bytes;
      const mask = dict.get(key('ImageMask'));
      const isMask = mask && String(mask) === 'true';
      const bpc = isMask ? 1 : numberOf(dict.get(key('BitsPerComponent'))) || 8;
      const cs = isMask ? { comps: 1 } : colourSpace(dict.get(key('ColorSpace')), ctx, key);
      if (!cs || ![1, 2, 4, 8].includes(bpc)) continue;
      const parms = ctx.lookup(dict.get(key('DecodeParms')));
      const predictor = parms && typeof parms.get === 'function' ? numberOf(parms.get(key('Predictor'))) : 1;
      if (predictor >= 10) raw = unpredict(raw, width, cs.comps, bpc);
      const decodeArr = ctx.lookup(dict.get(key('Decode')));
      const invert = !!(decodeArr && typeof decodeArr.asArray === 'function' && numberOf(decodeArr.asArray()[0]) === 1);
      // A stencil mask paints where its bit is 0: black on the page.
      images.push(samplesToRgba(raw, width, height, cs.comps, bpc, cs.palette, invert));
    } catch (_) { /* an image this cannot read: not a code */ }
  }
  return images.filter(Boolean);
}

/** Every QR code found in a photo or a PDF, as text. */
async function qrTexts({ buffer, mimetype }) {
  if (!buffer || !buffer.length) return [];
  try {
    if (mimetype === 'application/pdf') {
      const out = [];
      for (const img of await pdfImages(buffer)) {
        const t = decode(img);
        if (t && !out.includes(t)) out.push(t);
      }
      return out;
    }
    const t = decode(photoPixels(buffer, mimetype));
    return t ? [t] : [];
  } catch (_) {
    return [];
  }
}

module.exports = { qrTexts, decode, photoPixels, pdfImages, unpredict, samplesToRgba };
