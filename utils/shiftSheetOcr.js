'use strict';

// ═════════════════════════════════════════════════════════════════
//  Shift-sheet OCR  (Claude vision)
//
//  Reads a filled-in production sheet (the PDF produced by
//  utils/shiftSheetPdf.js, scanned/photographed back to PDF) and
//  returns the hand-written Production / Timer / Remarks per row,
//  keyed by the printed Code so the route can map each value back to
//  its ShiftDetail.
//
//  Scale: a 200-machine plan is ~19 pages. We split the upload into
//  small page-batches (pdf-lib) and OCR them with bounded concurrency
//  so no single vision call has to read the whole book at once — that
//  keeps latency, output size and per-row accuracy in check.
//
//  extractShiftRows(pdfBuffer) -> {
//    ok, rows: [{ code, production, timer, remarks, confidence }],
//    model, pages, batches
//  }
// ═════════════════════════════════════════════════════════════════
const { PDFDocument } = require('pdf-lib');
const { anthropic, VISION_MODEL } = require('./anthropicClient');

const BATCH_PAGES = 4;   // pages per vision call
const CONCURRENCY  = 3;  // parallel vision calls

const PROMPT = [
  'This PDF is a factory "Shift Production Sheet". Each row has PRINTED',
  'columns (QR, Code, Machine ID, Operator, Job No, Shift, Date) and three',
  'HAND-WRITTEN columns: "Production (m)", "Timer (H:M:S)" and "Remarks".',
  '',
  'For EVERY data row on EVERY page, read the printed Code exactly (format',
  'like "SD-8F3A2C") and transcribe the three hand-written cells.',
  '',
  'Rules:',
  '- production: the number of metres written, as an integer. If the cell is',
  '  blank or illegible, use null.',
  '- timer: the written time as "H:MM:SS" (or "HH:MM:SS"). If blank, null.',
  '- remarks: the written text, or "" if blank.',
  '- confidence: your confidence for THIS row\'s hand-written values, 0 to 1.',
  '  Lower it when the handwriting is unclear.',
  '- Do NOT invent rows. Do NOT include the header row.',
  '',
  'Return ONLY a JSON object, no prose, no markdown fences:',
  '{"rows":[{"code":"SD-8F3A2C","production":1240,"timer":"7:45:00","remarks":"warp break 20m","confidence":0.9}]}',
].join('\n');

/** Split a PDF buffer into page-batch PDF buffers. */
async function splitIntoBatches(pdfBuffer, batchPages) {
  const src = await PDFDocument.load(pdfBuffer);
  const total = src.getPageCount();
  const batches = [];
  for (let start = 0; start < total; start += batchPages) {
    const sub = await PDFDocument.create();
    const idxs = [];
    for (let p = start; p < Math.min(start + batchPages, total); p++) idxs.push(p);
    const copied = await sub.copyPages(src, idxs);
    copied.forEach((pg) => sub.addPage(pg));
    const bytes = await sub.save();
    batches.push(Buffer.from(bytes));
  }
  return { batches, total };
}

/** Pull the first JSON object out of a model reply (handles ``` fences). */
function parseJsonReply(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch (_) { return null; }
}

/** Normalise one raw OCR row into a clean, guard-railed record. */
function normaliseRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = String(raw.code || '').trim().toUpperCase();
  if (!code) return null;

  // Production → non-negative integer or null.
  let production = null;
  if (raw.production != null && raw.production !== '') {
    const n = Math.round(Number(String(raw.production).replace(/[, ]/g, '')));
    production = Number.isFinite(n) && n >= 0 ? n : null;
  }

  // Timer → H:MM:SS-ish or null.
  let timer = null;
  if (raw.timer != null && String(raw.timer).trim()) {
    const t = String(raw.timer).trim();
    timer = /^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(t) ? t : null;
  }

  const remarks = raw.remarks == null ? '' : String(raw.remarks).trim();
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  return { code, production, timer, remarks, confidence };
}

async function ocrBatch(claude, buf) {
  const message = await claude.messages.create({
    model: VISION_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      },
    ],
  });
  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = parseJsonReply(text);
  const rows = parsed && Array.isArray(parsed.rows) ? parsed.rows : [];
  return rows.map(normaliseRow).filter(Boolean);
}

/** Run tasks with a small concurrency pool, preserving order. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function extractShiftRows(pdfBuffer) {
  const claude = anthropic();
  if (!claude) {
    const err = new Error('ANTHROPIC_API_KEY not set on the server.');
    err.code = 'ANTHROPIC_KEY_MISSING';
    throw err;
  }

  const { batches, total } = await splitIntoBatches(pdfBuffer, BATCH_PAGES);
  const perBatch = await mapPool(batches, CONCURRENCY, (buf) => ocrBatch(claude, buf));

  // Flatten; de-dupe by code (last non-null wins) in case a row appears
  // on a batch boundary twice.
  const byCode = new Map();
  for (const rows of perBatch) {
    for (const r of rows) {
      const prev = byCode.get(r.code);
      if (!prev) byCode.set(r.code, r);
      else if (prev.production == null && r.production != null) byCode.set(r.code, r);
    }
  }

  return {
    ok: true,
    rows: [...byCode.values()],
    model: VISION_MODEL,
    pages: total,
    batches: batches.length,
  };
}

module.exports = { extractShiftRows, splitIntoBatches, parseJsonReply, normaliseRow };
