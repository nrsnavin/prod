'use strict';
// ══════════════════════════════════════════════════════════════════
//  READING THE BEAM WEIGHTS OFF A FILLED COVERING PROGRAMME
//
//  The covering programme (utils/programmePdf.js) goes to the machine
//  with a grid of 20 rows — S.No, Beam #, Weight (kg), Remarks — and the
//  operator writes each beam's weight in by hand. A photo (or a scan as
//  PDF) of that sheet comes back here; this reads the rows so the screen
//  can fill them in for checking.
//
//  Advisory, like every vision reader here: nothing is recorded until a
//  person has looked at the rows and saved them (POST /covering/:id/
//  beam-entries). Rows already printed on the sheet — weights recorded
//  before it was printed — are read too, and the route marks them.
// ══════════════════════════════════════════════════════════════════

const { anthropic, VISION_MODEL } = require('./anthropicClient');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SUPPORTED = new Set([...IMAGE_TYPES, 'application/pdf']);
const MAX_PAGES = 4;
const PROBLEMS = new Set(['not_a_covering_sheet', 'unreadable', 'blurry', 'cut_off']);

const PROMPT = [
  'These photos (or PDF pages) show a COVERING PROGRAMME from an elastic weaving plant: a',
  'printed A4 form titled "COVERING PROGRAMME", with the job order printed in the top-right',
  'box (like "J-48") and a sheet reference (like "CV-8F3A2C").',
  '',
  'Under the heading "BEAM WEIGHTS" is a grid printed as two tables side by side, each with',
  'columns S.No | Beam # | Weight (kg) | Remarks. S.No is printed (1 to 20 or more, the left',
  'table first, then the right). The operator writes the BEAM NUMBER, its WEIGHT in kg and',
  'sometimes a REMARK by hand. Some rows may already be printed (weights recorded earlier).',
  '',
  'Read every row that has a beam number or a weight written or printed in it. Skip rows',
  'where both are blank. For each row give:',
  '- sNo: the printed serial number of the row.',
  '- beamNo: the beam number written in the row (a whole number), or null if blank.',
  '- weight: the weight in kg as a number (e.g. 12.5), or null if blank or unreadable.',
  '  Handwritten digits: read carefully; a decimal point may be a dot or a comma.',
  '- remarks: any remark written in the row, or "".',
  '- printed: true if the beam number and weight are PRINTED (typed), false if handwritten.',
  '- confidence: 0 to 1, how sure you are of the beam number and weight.',
  '',
  'Also give:',
  '- jobOrderNo: the job order number printed at the top (just the number, e.g. 48), or null.',
  '- sheetRef: the sheet reference printed at the top (e.g. "CV-8F3A2C"), or null.',
  '- totalWeight: the TOTAL RECORDED WEIGHT if a figure is written or printed, or null.',
  '- problem: null, or "not_a_covering_sheet", "unreadable", "blurry", "cut_off".',
  '',
  'Never invent a row or a digit. Return ONLY JSON, no prose, no markdown fences:',
  '{"jobOrderNo":48,"sheetRef":"CV-8F3A2C","totalWeight":null,"problem":null,',
  ' "rows":[{"sNo":1,"beamNo":1,"weight":12.5,"remarks":"","printed":false,"confidence":0.9}]}',
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

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** Whatever the model said, a bounded, well-typed reading. */
function sanitise(raw) {
  const rows = (Array.isArray(raw?.rows) ? raw.rows : [])
    .slice(0, 200)
    .map((r) => {
      const beam = num(r?.beamNo);
      const weight = num(r?.weight);
      const conf = Number(r?.confidence);
      return {
        sNo: Number.isInteger(num(r?.sNo)) ? num(r.sNo) : null,
        beamNo: beam != null && Number.isInteger(beam) && beam > 0 ? beam : null,
        weight: weight != null && weight > 0 ? Math.round(weight * 1000) / 1000 : null,
        remarks: r?.remarks == null ? '' : String(r.remarks).trim().slice(0, 200),
        printed: r?.printed === true,
        confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
      };
    })
    .filter((r) => r.beamNo != null || r.weight != null);
  const job = num(raw?.jobOrderNo);
  const ref = raw?.sheetRef ? String(raw.sheetRef).toUpperCase().match(/CV-?\s?([0-9A-F]{6})/) : null;
  return {
    jobOrderNo: job != null && Number.isInteger(job) ? job : null,
    sheetRef: ref ? `CV-${ref[1]}` : null,
    totalWeight: num(raw?.totalWeight),
    rows,
    problem: PROBLEMS.has(raw?.problem) ? raw.problem : (rows.length ? null : 'unreadable'),
  };
}

function contentFor(page) {
  const data = page.buffer.toString('base64');
  return page.mimetype === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: page.mimetype, data } };
}

/**
 * @param {Array<{buffer: Buffer, mimetype: string}>} pages
 * @returns {Promise<{available:false} | {available:true, reading, model, usage, latencyMs}>}
 */
async function readCoveringBeams(pages) {
  const list = (pages || []).filter((p) => p && p.buffer && p.buffer.length);
  if (!list.length) {
    const err = new Error('Attach a photo of the covering programme.');
    err.statusCode = 400;
    throw err;
  }
  if (list.length > MAX_PAGES) {
    const err = new Error(`At most ${MAX_PAGES} photos at a time.`);
    err.statusCode = 400;
    throw err;
  }
  const bad = list.find((p) => !SUPPORTED.has(p.mimetype));
  if (bad) {
    const err = new Error('Use a photo (JPEG, PNG or WEBP) or a PDF.');
    err.statusCode = 400;
    throw err;
  }
  const claude = anthropic();
  if (!claude) return { available: false };
  const startedAt = Date.now();
  const message = await claude.messages.create({
    model: VISION_MODEL,
    max_tokens: 3000,
    messages: [{ role: 'user', content: [...list.map(contentFor), { type: 'text', text: PROMPT }] }],
  });
  const reply = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {
    available: true,
    reading: sanitise(parseJsonReply(reply) || {}),
    model: VISION_MODEL,
    usage: message.usage,
    latencyMs: Date.now() - startedAt,
  };
}

/** The reference printed on a covering's programme: "CV-" and the last six of its id. */
const sheetRefOf = (coveringId) => `CV-${String(coveringId).slice(-6).toUpperCase()}`;

module.exports = { readCoveringBeams, sanitise, sheetRefOf, PROMPT, SUPPORTED, MAX_PAGES };
