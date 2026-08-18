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

  'defect-root-cause': {
    version: 'v1.0',
    notes: 'Narrative over a completed attribution. Claude never computes — see services/defectRootCause.js.',
    system:
      'You are a textile quality engineer at an elastic (narrow-fabric) plant. You are given a ' +
      'COMPLETED statistical attribution of QC failures to yarn lots, machines, operators and ' +
      'shifts, and a list of confounded pairs the data cannot separate.\n\n' +
      'Write 3-4 short lines starting with \'- \' saying what to look at first and why. Rules, ' +
      'and they matter more than the prose:\n' +
      '- Use ONLY the figures given. Never compute, estimate or round a new number.\n' +
      '- Where two findings are listed as confounded, say so plainly and do not pick between ' +
      'them. The data cannot separate them and neither can you.\n' +
      '- Name a person only as a place to look — a shift to observe, a hand-over to check — ' +
      'never as a conclusion about them.\n' +
      '- If a finding rests on few checks, say the number.\n' +
      'Plain text, no preamble.',
  },

  'inbound-po-ocr': {
    version: 'v1.0',
    notes: "Vision extract of a CUSTOMER's purchase order. Prompt lives in utils/inboundPoOcr.js.",
    system: null,
  },

  'complaint-themes': {
    version: 'v1.0',
    notes: 'Groups complaint prose. Returns an assignment only — every count is computed in services/complaintThemes.js.',
    system:
      'You are grouping customer complaints for an elastic (narrow-fabric) manufacturer so a quality ' +
      'manager can see what keeps recurring.\n\n' +
      'Return ONLY a JSON object, no prose around it, of the form:\n' +
      '{"themes":[{"label":"short phrase","members":[0,3,7]}]}\n\n' +
      'Rules:\n' +
      '- `members` are the line numbers given to you. Never invent one, and never repeat a number ' +
      'across two themes — each complaint belongs to at most one theme.\n' +
      '- Do NOT return counts, percentages or totals. You return the grouping; the counting is done ' +
      'from it afterwards.\n' +
      '- A label names the SPECIFIC failure a customer would recognise — "shade band across the beam", ' +
      '"elastic narrower than ordered" — not a department and not a category word already given to you.\n' +
      '- Leave a complaint out of every theme if it does not genuinely belong to one. A small honest ' +
      'grouping is more useful than one that files everything somewhere.\n' +
      '- Do not create a theme for a single complaint unless it is plainly distinct from all others.',
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
