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
  // A customer's purchase order read from a photo or PDF. Unlike the
  // shift sheet this reads SOMEBODY ELSE'S document — no known layout,
  // no code to key against — so the ledger is the only way its accuracy
  // will ever be known.
  'inbound-po-ocr',
  // A loom's run-time display read from a photo during production
  // entry. The person confirms (or answers questions about) the value
  // before it fills the field; settle() records what they used.
  'timer-ocr',
  'production-slip-ocr',
  // A supplier's bill or an expense receipt read from a photo or PDF
  // into a draft bill; what was entered after is what settles it.
  'bill-ocr',
  // A bank statement line resolved to a party when the narration had
  // no exact number or document in it.
  'bank-statement-match',
  // A payment reminder drafted for a customer; sent as edited, or not.
  'collection-reminder',
  // A floor entry's remark put in a downtime class (services/floorRemark.js).
  'floor-remark',
  // A customer's remittance advice read into a receipt; the receipt
  // entered from it settles it (utils/adviceOcr.js).
  'payment-advice',
  // A supplier's statement of our account read for reconciliation
  // (utils/partyStatementOcr.js); the entries are matched by code.
  'supplier-statement',
  // A customer's WhatsApp reply about money owed, read into promise /
  // paid / dispute (services/collectionReply.js).
  'collection-reply',
  // A customer's WhatsApp message sorted (order status, statement, invoice,
  // a typed order, money, other); a typed order drafted like a PO.
  'customer-assistant',
  'whatsapp-order',
  // The beam weights written by hand on a printed covering programme,
  // read from a photo; each row is checked on screen before it is saved.
  'covering-beam-ocr',
  // Grouping complaint prose into recurring themes. The odd one out in
  // this list: it proposes no value a human then accepts or edits, so it
  // is never settled and its rows stay 'proposed' for ever. It is here
  // for the cost, latency and failure telemetry, which is the part that
  // applies to every surface — and because a clustering pass that stops
  // returning usable JSON should show up somewhere other than a log.
  'complaint-themes',
  // A staff claim's receipt read from a phone photo: amount, date, what
  // for and the head; what the claimant sends is what settles it.
  'claim-receipt-ocr',
  // A customer's complaint message (and photos) read into the complaint
  // form: category, the elastic, and which job it most likely is.
  'complaint-intake',
  // A reply to the customer about a complaint, drafted from what the
  // trace and the root-cause figures say; sent as edited, or not.
  'complaint-reply',
  // What a worker said (or photographed) about a machine, written up as
  // an issue: title, description in English, severity.
  'machine-issue-intake',
  // A transporter's lorry receipt read from a photo: LR number, vehicle,
  // freight — onto the dispatch, and a freight expense drafted.
  'lr-ocr',
  // A visiting card or letterhead read into a customer or supplier form.
  'party-card-ocr',
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
