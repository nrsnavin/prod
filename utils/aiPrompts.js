'use strict';
// ══════════════════════════════════════════════════════════════════
//  PROMPTS, VERSIONED
//
//  A prompt edit is a model change. It alters what the system outputs,
//  for every user, immediately — and until this file existed it left no
//  trace at all: no changelog, no version, nothing to correlate a drop
//  in accuracy against.
//
//  So prompts live here, each with a version string that is stamped on
//  every row in the AI suggestion ledger. When accuracy moves, the
//  question "what changed?" has an answer.
//
//  ── The one rule ─────────────────────────────────────────────────
//  CHANGE THE TEXT, CHANGE THE VERSION. A prompt edited in place under
//  its old version makes every historical measurement a lie — the
//  ledger will attribute yesterday's results to today's wording, and
//  the comparison that would have caught a regression instead hides it.
//
//  Bump the minor for wording; bump the major when the OUTPUT SHAPE
//  changes, because that also breaks the field-level diff the ledger
//  depends on.
// ══════════════════════════════════════════════════════════════════

/**
 * Registry of every system prompt, by surface.
 *
 * `version` is what lands in the ledger. `notes` is for the person who
 * comes back in six months wondering why it reads the way it does.
 */
const PROMPTS = Object.freeze({
  'planner-rationale': {
    version: 'v1.0',
    notes: 'Narrative only — Claude never writes a figure. See api/planner.js.',
    system:
      'You are a production planner for an elastic (narrow-fabric) plant. Given a proposed ' +
      'machine schedule, explain the plan\'s logic in 2-3 short bullet lines starting with \'- \': ' +
      'why this sequencing, which orders are at risk, and one thing the admin should watch. ' +
      'Plain text, no preamble, reference the machines/elastics in the data.',
  },

  'advisor-briefing': {
    version: 'v1.0',
    notes: 'Morning briefing over the alert cards.',
    system: null,   // lives in api/advisor.js; registered here for versioning
  },

  'qc-vision': {
    version: 'v1.0',
    notes: 'Zero-shot defect classification against the product spec. Advisory only.',
    system: null,   // lives in utils/qcVision.js
  },

  'shift-sheet-ocr': {
    version: 'v1.0',
    notes: 'Handwriting OCR of the printed shift sheet, batched by page.',
    system: null,   // lives in utils/shiftSheetOcr.js
  },

  'assistant-answer': {
    version: 'v1.0',
    notes: 'Read-only tool-calling agent over whitelisted queries.',
    system: null,   // lives in api/assistant.js
  },
});

/** The version string to stamp on a ledger row for `surface`. */
function promptVersion(surface) {
  return PROMPTS[surface]?.version ?? 'v0';
}

/** The registered system prompt, where this file owns the text. */
function systemPrompt(surface) {
  return PROMPTS[surface]?.system ?? null;
}

module.exports = { PROMPTS, promptVersion, systemPrompt };
