'use strict';

// ═════════════════════════════════════════════════════════════════
//  Production slip OCR  (Claude vision)
//
//  Reads PHOTOS of a production record sent over WhatsApp (or uploaded
//  on the web). Two kinds are understood:
//
//    sheet  the app's printed Shift Production Sheet, filled in by hand
//           (utils/shiftSheetPdf.js). Every row carries a printed code
//           (SD-8F3A2C) that names its shift entry exactly, and the
//           header carries the plan number (SP-20261006-D).
//
//    slip   the factory's own hand-written slip: one line per loom with
//           a machine number, the metres and the run time, and the date
//           and Day/Night written somewhere on it.
//
//  This only READS. What the values belong to — which plan, which shift
//  entry — is worked out by services/slipIngest.js against the database,
//  never by the model.
//
//  readSlip(pages) -> {
//    format: 'sheet' | 'slip' | null,
//    planNo, date: 'YYYY-MM-DD' | null, shift: 'DAY' | 'NIGHT' | null,
//    rows: [{ code, machine, operator, production, timer, remarks, confidence }],
//    problem: null | 'not_a_slip' | 'unreadable',
//    model, usage, latencyMs
//  }
// ═════════════════════════════════════════════════════════════════
const { anthropic, VISION_MODEL } = require('./anthropicClient');

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SUPPORTED = new Set([...IMAGE_TYPES, 'application/pdf']);
const PAGES_PER_CALL = 4;
const MAX_PAGES = 10;

const PROMPT = [
  'These photos are production records from an elastic (narrow-fabric) weaving factory.',
  'They are one of two kinds:',
  '',
  'A) "sheet": the factory\'s PRINTED "Shift Production Sheet". A table with printed columns',
  '   QR, Code (like "SD-8F3A2C"), Machine ID, Operator, Job No, Shift, Date, and three',
  '   HAND-WRITTEN columns: "Production (m)", "Timer (H:M:S)" and "Remarks". The header shows',
  '   a plan number like "SP-20261006-D" (date, then D for day or N for night shift).',
  '',
  'B) "slip": a HAND-WRITTEN slip in the factory\'s own format: one line per loom with a',
  '   machine number (e.g. "M-07", "7", "L12"), perhaps the operator, the metres produced and',
  '   the run time; the date and Day/Night shift are written somewhere on it.',
  '',
  'Read every data row on every photo. For each row:',
  '- code: the printed Code exactly (sheet only), else null.',
  '- machine: the machine number as written or printed, else null.',
  '- operator: the operator name if present, else null.',
  '- production: the metres written, as an integer. Copy the number; never add, multiply or',
  '  correct it. Blank or illegible: null.',
  '- timer: the run time as "H:MM:SS" (or "H:MM" if no seconds are written). Blank: null.',
  '- remarks: any note on that row, or "".',
  '- confidence: 0 to 1 for THIS row\'s hand-written values. Lower it whenever a digit could be',
  '  read two ways (1/7, 3/8, 0/6, 5/6).',
  '',
  'Also give, if visible: planNo (sheet header), date as "YYYY-MM-DD" (dates are written',
  'day first: 06/10/26 is 6 October 2026), and shift "DAY" or "NIGHT". Null when not visible;',
  'never guess them.',
  '',
  'Do not invent rows. Do not include header rows or totals.',
  'If the photos are not a production record, return rows [] and problem "not_a_slip".',
  'If they are one but cannot be read (blurred, cut off, too dark), rows [] and problem "unreadable".',
  '',
  'Return ONLY a JSON object, no prose, no markdown fences:',
  '{"format":"sheet","planNo":"SP-20261006-D","date":"2026-10-06","shift":"DAY","problem":null,',
  ' "rows":[{"code":"SD-8F3A2C","machine":"M-07","operator":"Ravi","production":1240,"timer":"7:45:00","remarks":"","confidence":0.9}]}',
].join('\n');

function parseJsonReply(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch (_) { return null; }
}

const text = (v) => (v == null ? null : String(v).trim() || null);

/** "7:45" / "07:45:12" → "H:MM:SS"; anything else null. */
function asTimer(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (!m) return null;
  return `${Number(m[1])}:${m[2].padStart(2, '0')}:${(m[3] ?? '00').padStart(2, '0')}`;
}

function asDate(v) {
  const m = String(v ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function asShift(v) {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'DAY' || s === 'D') return 'DAY';
  if (s === 'NIGHT' || s === 'N') return 'NIGHT';
  return null;
}

/** One raw row → a clean record, or null if it carries nothing. */
function normaliseRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = text(raw.code)?.toUpperCase() ?? null;
  const machine = text(raw.machine);
  if (!code && !machine) return null;

  let production = null;
  if (raw.production != null && raw.production !== '') {
    const n = Math.round(Number(String(raw.production).replace(/[, ]/g, '')));
    production = Number.isFinite(n) && n >= 0 ? n : null;
  }
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;

  return {
    code,
    machine,
    operator: text(raw.operator),
    production,
    timer: asTimer(raw.timer),
    remarks: raw.remarks == null ? '' : String(raw.remarks).trim().slice(0, 300),
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

function contentFor(page) {
  const data = page.buffer.toString('base64');
  return page.mimetype === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: page.mimetype, data } };
}

async function readBatch(claude, pages) {
  const message = await claude.messages.create({
    model: VISION_MODEL,
    max_tokens: 4096,
    messages: [{ role: 'user', content: [...pages.map(contentFor), { type: 'text', text: PROMPT }] }],
  });
  const reply = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { parsed: parseJsonReply(reply) || {}, usage: message.usage };
}

/**
 * Read a set of photos (or PDF pages) of one slip.
 *
 * @param {Array<{buffer: Buffer, mimetype: string}>} pages
 */
async function readSlip(pages) {
  const list = (pages || []).filter((p) => p && p.buffer && p.buffer.length);
  if (list.length === 0) {
    const err = new Error('No photo to read.');
    err.code = 'NO_PAGES';
    throw err;
  }
  const bad = list.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) {
    const err = new Error(`Cannot read a ${bad.mimetype} file. Send a photo (JPEG or PNG) or a PDF.`);
    err.code = 'UNSUPPORTED_TYPE';
    throw err;
  }
  if (list.length > MAX_PAGES) {
    const err = new Error(`At most ${MAX_PAGES} photos per slip.`);
    err.code = 'TOO_MANY_PAGES';
    throw err;
  }
  const claude = anthropic();
  if (!claude) {
    const err = new Error('ANTHROPIC_API_KEY not set on the server.');
    err.code = 'ANTHROPIC_KEY_MISSING';
    throw err;
  }

  const startedAt = Date.now();
  const batches = [];
  for (let i = 0; i < list.length; i += PAGES_PER_CALL) batches.push(list.slice(i, i + PAGES_PER_CALL));
  // One at a time: a slip is a page or two, and the gateway caps
  // concurrency across the whole server anyway.
  const results = [];
  for (const b of batches) results.push(await readBatch(claude, b));

  const first = (key, fn) => {
    for (const r of results) {
      const v = fn(r.parsed[key]);
      if (v) return v;
    }
    return null;
  };
  const formats = results.map((r) => r.parsed.format).filter((f) => f === 'sheet' || f === 'slip');
  const format = formats.includes('sheet') ? 'sheet' : formats[0] || null;
  const rows = results.flatMap((r) => (Array.isArray(r.parsed.rows) ? r.parsed.rows : []))
    .map(normaliseRow).filter(Boolean);
  const problems = results.map((r) => r.parsed.problem).filter(Boolean);
  const usage = results.reduce((acc, r) => ({
    input_tokens: (acc.input_tokens || 0) + (r.usage?.input_tokens || 0),
    output_tokens: (acc.output_tokens || 0) + (r.usage?.output_tokens || 0),
  }), {});

  return {
    format,
    planNo: first('planNo', (v) => {
      const m = String(v ?? '').toUpperCase().match(/SP-?(\d{8})-?([DN])/);
      return m ? `SP-${m[1]}-${m[2]}` : null;
    }),
    date: first('date', asDate),
    shift: first('shift', asShift),
    rows,
    problem: rows.length ? null : (problems.includes('unreadable') ? 'unreadable' : problems[0] || 'unreadable'),
    model: VISION_MODEL,
    usage,
    latencyMs: Date.now() - startedAt,
  };
}

module.exports = {
  readSlip,
  SUPPORTED_TYPES: [...SUPPORTED],
  _internals: { normaliseRow, asTimer, asDate, asShift, parseJsonReply, PROMPT },
};
