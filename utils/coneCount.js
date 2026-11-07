'use strict';
// ══════════════════════════════════════════════════════════════════
//  CONES IN A PHOTO, COUNTED — for the stock take (experimental)
//
//  readCones(pages) → { problem, cones, rows, perRow, layers, hidden,
//    confidence, note, model, usage, latencyMs }
//  The model counts what it can see, row by row where the cones are
//  stacked in a grid (rows × per row × layers), says when some are hidden
//  behind others, and how sure it is. A person checks the count before
//  it goes on the sheet; kilograms come from the cone's weight, not the
//  photo.
// ══════════════════════════════════════════════════════════════════

const { readJson, num, str } = require('./docRead');

const PROMPT = [
  'This photo is from the stores of an elastic weaving factory: yarn cones (or bobbins / spools) on a rack, a pallet, in a carton or a bag.',
  'Count the cones. Return ONLY JSON:',
  '{"problem":null,"cones":48,"rows":6,"perRow":8,"layers":1,"hidden":false,"confidence":0.8,"note":"6 rows of 8 on the top shelf"}',
  '- When they stand in a grid give rows, perRow and layers so that cones = rows × perRow × layers; else leave those null and count one by one.',
  '- hidden: true when some cones are behind others or in a closed carton and cannot all be seen; count only what can be seen and say so in note.',
  '- confidence 0 to 1: lower for a blurred, dark or partly covered photo.',
  '- No cones in the photo: {"problem":"no_cones"}. Unreadable: {"problem":"unreadable"}.',
].join('\n');

function normaliseCones(raw, meta = {}) {
  if (!raw) return { problem: 'unreadable', ...meta };
  if (raw.problem === 'no_cones' || raw.problem === 'unreadable') return { problem: raw.problem, ...meta };
  const rows = num(raw.rows); const perRow = num(raw.perRow); const layers = num(raw.layers) || 1;
  const grid = rows && perRow ? Math.round(rows * perRow * layers) : null;
  let cones = num(raw.cones);
  // A grid that disagrees with its own total: the grid is the count it showed its work for.
  if (grid && cones !== grid) cones = grid;
  if (!(cones >= 0)) return { problem: 'unreadable', ...meta };
  const confidence = Math.max(0, Math.min(1, num(raw.confidence) ?? 0.5));
  return { problem: null, cones: Math.round(cones), rows: rows || null, perRow: perRow || null, layers: grid ? layers : null, hidden: raw.hidden === true, confidence, note: str(raw.note, 200), ...meta };
}

async function readCones(pages) {
  const r = await readJson({ pages, prompt: PROMPT, maxTokens: 300, maxPages: 1 });
  return normaliseCones(r.data, { model: r.model, usage: r.usage, latencyMs: r.latencyMs });
}

module.exports = { readCones, normaliseCones, PROMPT };
