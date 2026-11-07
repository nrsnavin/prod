'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PHOTO'S FINGERPRINT
//
//  fingerprint({ buffer, mimetype }) → { sha, dhash }
//    sha    the exact bytes (SHA-256): the same file sent again
//    dhash  a 64-bit difference hash (16 hex) of the picture itself, so
//           the same photo resized or recompressed (WhatsApp, email)
//           still matches; null for a PDF or a format not decoded here
//  distance(a, b) → how many of the 64 bits differ (0 = same picture).
//  A fresh photo of the same paper is a different picture: that is what
//  the bill-number check is for.
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const MAX_BYTES = 12 * 1024 * 1024;

function decode(buffer, mimetype) {
  if (mimetype === 'image/jpeg') {
    const jpeg = require('jpeg-js');
    return jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512, tolerantDecoding: true });
  }
  if (mimetype === 'image/png') {
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  return null;
}

/** 9×8 grey cells, each the average of its block; bit = left cell brighter than right. */
function dhashOf({ width, height, data }) {
  const W = 9; const H = 8;
  const cells = new Float64Array(W * H); const counts = new Uint32Array(W * H);
  const step = Math.max(1, Math.floor(Math.min(width, height) / 256)); // sample, not every pixel
  for (let y = 0; y < height; y += step) {
    const cy = Math.min(H - 1, Math.floor((y * H) / height));
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const cx = Math.min(W - 1, Math.floor((x * W) / width));
      cells[cy * W + cx] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      counts[cy * W + cx] += 1;
    }
  }
  let bits = 0n;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W - 1; x += 1) {
      const a = cells[y * W + x] / (counts[y * W + x] || 1);
      const b = cells[y * W + x + 1] / (counts[y * W + x + 1] || 1);
      bits = (bits << 1n) | (a > b ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function fingerprint({ buffer, mimetype }) {
  if (!buffer || !buffer.length) return null;
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  let dhash = null;
  if (buffer.length <= MAX_BYTES) {
    try { const img = decode(buffer, mimetype); if (img && img.width > 8 && img.height > 8) dhash = dhashOf(img); } catch { /* the exact hash still works */ }
  }
  return { sha, dhash };
}

function distance(a, b) {
  if (!a || !b) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`); let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

module.exports = { fingerprint, distance, dhashOf };
