'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CORRECTION LEDGER
//
//  Every AI surface in this system proposes, and a human decides. The
//  OCR reads a production figure and an operator fixes it. Vision QC
//  calls a defect and an inspector overrides it. The planner suggests a
//  schedule and an admin moves two lines.
//
//  Until this collection existed, all of that was thrown away. The
//  system kept the CORRECTED value and discarded the fact that a
//  correction had happened — which meant none of these could be
//  answered:
//
//    • is the OCR getting better or worse?
//    • which defect classes does vision QC miss?
//    • did last month's prompt edit help or hurt?
//    • is the planner's advice being followed, or quietly ignored?
//
//  Each of those corrections is a labelled example, produced for free,
//  by somebody who knows the answer. This is where they are kept.
//
//  ── What this is NOT ─────────────────────────────────────────────
//  Not an audit trail. `fingerprints` on the domain documents already
//  records who changed what, and is the legal record. This records
//  something different and narrower: what the MODEL said, next to what
//  the human settled on, so the gap between them can be measured.
//
//  ── Retention ────────────────────────────────────────────────────
//  Suggestion payloads are bounded and coarse on purpose (see
//  services/aiLedger.js, which trims before writing). A TTL index
//  expires rows after two years — long enough for a fine-tuning corpus,
//  short enough that this never becomes the biggest collection in the
//  database.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

/** Every surface that may write here. Adding one is a deliberate act. */
const AI_SURFACES = Object.freeze([
  'shift-sheet-ocr',
  'qc-vision',
  'planner-rationale',
  'advisor-briefing',
  'assistant-answer',
  // Narrative over the defect attribution. Like the planner rationale,
  // the model writes prose and never a figure — every number it is
  // given was computed by services/defectRootCause.js and can be
  // reproduced by hand from four collections.
  'defect-root-cause',
]);

/** How a suggestion ended up. */
const OUTCOMES = Object.freeze([
  'proposed',   // written, awaiting a human
  'accepted',   // applied unchanged
  'edited',     // applied with changes — the valuable one
  'rejected',   // discarded outright
  'failed',     // the model call itself errored
]);

const AiSuggestionSchema = new mongoose.Schema(
  {
    surface: { type: String, enum: AI_SURFACES, required: true, index: true },

    // What produced it. Both are stamped so a change in either can be
    // correlated with a change in accuracy — a prompt edit is a model
    // change with no changelog unless it is versioned here.
    model:         { type: String, required: true },
    promptVersion: { type: String, default: 'v0' },

    // What it was asked about. `refType`/`refId` point at the domain
    // document (a ShiftPlan, a JobOrder) so a suggestion can be read
    // back alongside what actually happened to it.
    refType: { type: String, default: '' },
    refId:   { type: mongoose.Types.ObjectId },

    // The model's answer and the human's. Kept as Mixed because every
    // surface has its own shape; kept SMALL by the service that writes
    // them — this is a measurement, not a backup.
    proposed: { type: mongoose.Schema.Types.Mixed, default: null },
    accepted: { type: mongoose.Schema.Types.Mixed, default: null },

    // The field paths the human changed. This is the single most useful
    // column in the collection: it turns "the OCR is 92% accurate" into
    // "the OCR is 99% accurate on production but 71% on the timer",
    // which is something you can actually act on.
    editedFields: { type: [String], default: [] },

    outcome: { type: String, enum: OUTCOMES, default: 'proposed', index: true },

    // Who decided. Null while still 'proposed'.
    decidedBy: { type: mongoose.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },

    // Operational telemetry. Nothing recorded these before, so a
    // runaway prompt was invisible until it reached a bill.
    latencyMs:    { type: Number },
    inputTokens:  { type: Number },
    outputTokens: { type: Number },

    // Set when outcome is 'failed'.
    error: { type: String, default: '' },
  },
  { timestamps: true }
);

// The two questions this collection is asked: "how is surface X doing
// lately" and "what happened to the suggestion for this document".
AiSuggestionSchema.index({ surface: 1, createdAt: -1 });
AiSuggestionSchema.index({ refType: 1, refId: 1 });

// Two years. Long enough to build a fine-tuning corpus and to compare
// this Diwali against the last; short enough to stay bounded.
AiSuggestionSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 2 * 365 * 24 * 60 * 60 }
);

module.exports = mongoose.model('AiSuggestion', AiSuggestionSchema);
module.exports.AI_SURFACES = AI_SURFACES;
module.exports.OUTCOMES = OUTCOMES;
