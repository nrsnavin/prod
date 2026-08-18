'use strict';
// ══════════════════════════════════════════════════════════════════
//  RECORDING WHAT THE MODEL SAID, AND WHAT THE HUMAN DID ABOUT IT
//
//  Two calls, used in pairs:
//
//    record(...)  when a suggestion is produced      → 'proposed'
//    settle(...)  when a human accepts / edits it    → 'accepted' | 'edited'
//
//  ── Why this never throws ────────────────────────────────────────
//  Measuring a thing must not be able to break it. If the ledger write
//  fails, the OCR still returns its reading and the inspector still
//  saves their QC record — the observation is lost and a warning is
//  logged, and that is the correct trade every time. The one thing this
//  module must never do is turn a working feature into a 500 because
//  telemetry had a bad day.
//
//  ── Why the payloads are trimmed ─────────────────────────────────
//  A shift-sheet OCR of a 200-machine plan returns hundreds of rows. A
//  QC photo prompt carries an image. None of that belongs here: this
//  collection exists to measure agreement, not to be a second copy of
//  the data. `trim()` bounds what is stored, and the domain document
//  remains the record of what actually happened.
// ══════════════════════════════════════════════════════════════════

const AiSuggestion = require('../models/AiSuggestion');

/** Values above this are summarised rather than stored whole. */
const MAX_ARRAY   = 50;
const MAX_STRING  = 2000;
// A shift sheet keyed by ShiftDetail id is an OBJECT, not an array, so
// the array cap above never sees it. 400 keys covers a 200-machine
// plan's two shifts with room to spare, and stops a pathological
// payload from being copied wholesale into the ledger.
const MAX_KEYS    = 400;

/**
 * Bound a payload before it is written.
 *
 * Deliberately lossy and deliberately shallow: long arrays keep a head
 * and a count, long strings are cut, and nothing recurses past a few
 * levels. A truncated record still answers "did the human change this
 * field"; an untruncated one would answer the same question and cost a
 * hundred times the storage.
 */
function trim(value, depth = 0) {
  if (value == null) return value;
  if (depth > 3) return '[deep]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length}]` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => trim(v, depth + 1));
    return value.length > MAX_ARRAY
      ? { _truncated: true, length: value.length, head }
      : head;
  }
  if (typeof value === 'object') {
    // Buffers and binary never belong in the ledger.
    if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;
    const out = {};
    const entries = Object.entries(value);
    for (const [k, v] of entries.slice(0, MAX_KEYS)) {
      if (/^(image|base64|data|buffer|photo)$/i.test(k)) { out[k] = '[omitted]'; continue; }
      out[k] = trim(v, depth + 1);
    }
    if (entries.length > MAX_KEYS) out._truncatedKeys = entries.length - MAX_KEYS;
    return out;
  }
  return value;
}

/**
 * Turn a concrete leaf path into the SHAPE of that path.
 *
 * A shift-sheet correction produces `rows.68f1….production`. A hundred
 * of those are a hundred distinct strings, so a naive group-by returns a
 * hundred rows of one — which reads as "no field is ever wrong twice"
 * when the truth is "the timer column is wrong on a third of rows".
 *
 * Collapsing document ids and array indices to `[]` puts them all under
 * `rows[].production`, which is the question actually being asked: not
 * WHICH row was corrected, but WHICH COLUMN keeps needing it.
 */
const OPAQUE_SEGMENT = /^([a-f\d]{24}|\d+)$/i;
function collapsePath(path) {
  return String(path)
    .split('.')
    .map((seg) => {
      const s = seg.replace(/\[\d+\]/g, '[]');
      return OPAQUE_SEGMENT.test(s) ? '[]' : s;
    })
    .join('.')
    // A map key and an array index describe the same thing, so they
    // should read the same: `rows[].timer`, not `rows.[].timer`.
    .replace(/\.\[\]/g, '[]');
}

/**
 * Which leaf paths differ between what was proposed and what was saved.
 *
 * This is the column the whole collection is for: it turns "the OCR is
 * 92% accurate" into "the OCR is 99% accurate on production and 71% on
 * the timer", which is a statement somebody can act on.
 *
 * Compared loosely (`String(a) !== String(b)`) on purpose — a figure
 * that arrives as "1200" and is saved as 1200 was NOT corrected by the
 * human, and counting it as an edit would bury the real ones.
 */
function diffFields(proposed, accepted, prefix = '', opts = {}) {
  const changed = [];
  if (proposed == null || accepted == null) return changed;
  if (typeof proposed !== 'object' || typeof accepted !== 'object') {
    return String(proposed) === String(accepted) ? [] : [prefix || 'value'];
  }

  const keys = new Set([...Object.keys(proposed), ...Object.keys(accepted)]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const a = proposed[k];
    const b = accepted[k];

    // A row the human never touched is not a row the human corrected.
    //
    // The shift sheet is the case this exists for: the OCR reads 180
    // rows, the operator verifies 140 and leaves the rest for the next
    // person. Counting those 40 as rejections would report the OCR as
    // 78% accurate when nobody has yet disagreed with it once.
    if (opts.ignoreMissing && b === undefined) continue;

    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      changed.push(...diffFields(a, b, path, opts));
    } else if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) changed.push(path);
      else for (let i = 0; i < a.length; i++) changed.push(...diffFields(a[i], b[i], `${path}[${i}]`, opts));
    } else if (String(a) !== String(b)) {
      changed.push(path);
    }
  }
  return changed;
}

/**
 * Record a suggestion the moment it is produced.
 *
 * @returns {Promise<mongoose.Types.ObjectId|null>} the row id, to hand
 *          to settle() later — or null if the write failed, which
 *          callers must tolerate.
 */
async function record({
  surface, model, promptVersion, refType, refId,
  proposed, latencyMs, usage, error,
}) {
  try {
    const doc = await AiSuggestion.create({
      surface,
      model,
      promptVersion: promptVersion || 'v0',
      refType: refType || '',
      refId,
      proposed: error ? null : trim(proposed),
      outcome: error ? 'failed' : 'proposed',
      error: error ? String(error).slice(0, 500) : '',
      latencyMs,
      inputTokens:  usage?.input_tokens,
      outputTokens: usage?.output_tokens,
    });
    return doc._id;
  } catch (err) {
    console.warn('[aiLedger] record failed:', err.message);
    return null;
  }
}

/**
 * Close a suggestion out once a human has decided.
 *
 * `accepted` is what was actually saved. The outcome is derived rather
 * than asserted by the caller — a route that believes it applied the
 * suggestion unchanged, but changed a field, should be recorded as an
 * edit regardless of what it believes.
 */
async function settle(id, { accepted, decidedBy, rejected = false, outcome, ignoreMissing = false } = {}) {
  if (!id) return null;
  try {
    const row = await AiSuggestion.findById(id);
    if (!row) return null;

    if (outcome) {
      // Explicit outcome, for surfaces where there is nothing to diff.
      // A narrative rationale is either acted on or it isn't — there are
      // no fields to compare, and running the diff anyway would report
      // "the human edited `rationale`" every single time, purely because
      // the client never sends prose back.
      row.outcome = outcome;
    } else if (rejected) {
      row.outcome = 'rejected';
    } else {
      const trimmed = trim(accepted);
      const edits = [...new Set(
        diffFields(row.proposed, trimmed, '', { ignoreMissing }).map(collapsePath)
      )];
      row.accepted     = trimmed;
      row.editedFields = edits;
      row.outcome      = edits.length > 0 ? 'edited' : 'accepted';
    }
    row.decidedBy = decidedBy;
    row.decidedAt = new Date();
    await row.save();
    return row;
  } catch (err) {
    console.warn('[aiLedger] settle failed:', err.message);
    return null;
  }
}

/**
 * Per-surface agreement over a window — the number nobody could quote
 * before this collection existed.
 *
 * `acceptRate` counts only DECIDED suggestions: rows still sitting at
 * 'proposed' are not evidence either way, and folding them in would
 * make the figure drift with how promptly people review rather than
 * with how good the model is.
 */
async function stats({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await AiSuggestion.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: {
        _id: '$surface',
        total:     { $sum: 1 },
        accepted:  { $sum: { $cond: [{ $eq: ['$outcome', 'accepted'] }, 1, 0] } },
        edited:    { $sum: { $cond: [{ $eq: ['$outcome', 'edited'  ] }, 1, 0] } },
        rejected:  { $sum: { $cond: [{ $eq: ['$outcome', 'rejected'] }, 1, 0] } },
        failed:    { $sum: { $cond: [{ $eq: ['$outcome', 'failed'  ] }, 1, 0] } },
        pending:   { $sum: { $cond: [{ $eq: ['$outcome', 'proposed'] }, 1, 0] } },
        avgLatency:{ $avg: '$latencyMs' },
        inTokens:  { $sum: '$inputTokens' },
        outTokens: { $sum: '$outputTokens' },
    } },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => {
    const decided = r.accepted + r.edited + r.rejected;
    return {
      surface:    r._id,
      total:      r.total,
      decided,
      pending:    r.pending,
      accepted:   r.accepted,
      edited:     r.edited,
      rejected:   r.rejected,
      failed:     r.failed,
      // Clean acceptance: applied with no changes at all.
      acceptRate: decided > 0 ? Math.round((r.accepted / decided) * 100) : null,
      // Usable: accepted or edited — i.e. the suggestion was worth
      // having even if it needed a touch. Both matter, for different
      // reasons, so both are reported.
      usefulRate: decided > 0 ? Math.round(((r.accepted + r.edited) / decided) * 100) : null,
      avgLatencyMs: r.avgLatency != null ? Math.round(r.avgLatency) : null,
      tokens: { input: r.inTokens || 0, output: r.outTokens || 0 },
    };
  });
}

/**
 * Which fields a surface gets wrong most often, over the window.
 * The actionable half of the ledger.
 *
 * `editedFields` is stored already collapsed and de-duplicated (see
 * collapsePath), so the count here is SUGGESTIONS that needed that field
 * touched — not individual cells. That is the deliberate choice: a
 * per-cell count would need every concrete path kept, which on a
 * 200-row shift sheet is hundreds of strings per document to answer a
 * question that "one sheet in three needs the timer column fixed"
 * already answers.
 */
async function weakFields({ surface, days = 30, limit = 10 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000);
  const match = { createdAt: { $gte: since }, outcome: 'edited' };
  if (surface) match.surface = surface;

  return AiSuggestion.aggregate([
    { $match: match },
    { $unwind: '$editedFields' },
    { $group: { _id: { surface: '$surface', field: '$editedFields' }, suggestions: { $sum: 1 } } },
    { $sort: { suggestions: -1 } },
    { $limit: limit },
    { $project: { _id: 0, surface: '$_id.surface', field: '$_id.field', suggestions: 1 } },
  ]);
}

module.exports = { record, settle, stats, weakFields, trim, diffFields, collapsePath };
