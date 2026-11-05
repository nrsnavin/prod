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

  'timer-ocr': {
    version: 'v1.2',
    notes: 'Every display on a loom panel, with kind, label, confidence and alternative readings; the client asks about anything unclear. Advisory only. v1.1: written for the SELEC LTC9A on these looms — H:MM:SS read from the right, blank leading hours, faint colons always written, seven-segment look-alikes as alternatives, the printed model name never a reading. v1.2: the loom\'s QR label may be in the same photo (one photo for the loom and its timer); its numbers are never a reading. A counter\'s printed unit (MTR, PICK) is its label, so a metre counter can fill the metres.',
    system: null,   // lives in utils/timerOcr.js
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

  'production-slip-ocr': {
    version: 'v1.2',
    notes: 'Photos of a production record sent over WhatsApp or uploaded: the printed shift sheet, the printed floor sheet (no plan; v1.1) or the factory\'s own slip. v1.2: both printed sheets carry a Sign box and Remarks. Reads only; matching is done against the database. Prompt lives in utils/slipOcr.js.',
    system: null,
  },

  'covering-beam-ocr': {
    version: 'v1.0',
    notes: 'Handwritten beam numbers and weights off a printed covering programme (S.No | Beam # | Weight (kg) | Remarks, two tables side by side), with the job order and the CV- sheet reference. Advisory: every row is checked before it is saved. Prompt lives in utils/coveringBeamOcr.js.',
    system: null,
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

  'bill-ocr': {
    version: 'v1.0',
    notes: 'Reads a supplier bill / expense receipt into a draft. Lives in utils/billOcr.js. Amounts are copied, never computed.',
    system: null,
  },
  'bank-statement-match': {
    version: 'v2.0',
    notes: 'Places statement lines the rules could not: a customer or supplier and the invoices or bills named, a transfer between our own accounts, an expense head, or interest received — each answer checked against what is on file. Lives in services/statementAi.js.',
    system: null,
  },
  'collection-reminder': {
    version: 'v1.0',
    notes: 'Drafts a short payment reminder from the overdue invoices given to it. Lives in services/collections.js.',
    system: null,
  },

  'claim-receipt-ocr': {
    version: 'v1.0',
    notes: 'The bill reader (utils/billOcr.js) on a staff claim receipt; amount, date and description are taken from its read, the head from past expenses to that payee.',
    system: null,
  },
  'complaint-intake': {
    version: 'v1.0',
    notes: 'Reads a customer complaint message into category, elastic hints and the job it most likely is, from candidates given. Lives in services/complaintIntake.js.',
    system: null,
  },
  'complaint-reply': {
    version: 'v1.0',
    notes: 'Drafts a reply to the customer from the complaint, the trace and the root-cause figures; never promises credit or dates not given. Lives in services/complaintIntake.js.',
    system: null,
  },
  'collection-reply': {
    version: 'v1.0',
    notes: 'A customer\'s WhatsApp reply to a payment reminder read into promise, paid, dispute, statement or other, with the date promised, the amount and any reference. Keywords first; the model only refines, within a few seconds. Lives in services/collectionReply.js.',
    system: null,
  },

  'supplier-statement': {
    version: 'v1.0',
    notes: 'A supplier\'s statement of our account (PDF, photo, Excel or CSV) read into its entries as they booked them, with opening and closing balances. Matching to our ledger is services/supplierRecon.js. Lives in utils/partyStatementOcr.js.',
    system: null,
  },

  'payment-advice': {
    version: 'v1.0',
    notes: 'A customer\'s remittance advice (PDF, photo or pasted mail) read into the money, the reference and, per invoice, what it settles and what was deducted. Which invoices on file those are is services/adviceMatch.js. Lives in utils/adviceOcr.js.',
    system: null,
  },

  'floor-remark': {
    version: 'v1.0',
    notes: 'The remark left with a floor entry, put in a downtime class (beam change, yarn break, mechanical, electrical, power cut, no operator, waiting for material, quality, other) with the minutes lost and whether the fitter should look. Keywords first; the model only refines, within a few seconds. Lives in services/floorRemark.js.',
    system: null,
  },

  'machine-issue-intake': {
    version: 'v1.0',
    notes: 'A worker\'s words (often Tamil, from speech) or a photo, written up as a machine issue. Lives in services/machineIssueIntake.js.',
    system: null,
  },
  'lr-ocr': {
    version: 'v1.0',
    notes: 'A lorry receipt / transporter slip: LR number, date, vehicle, transporter, GSTIN, packages, freight. Lives in utils/lrOcr.js.',
    system: null,
  },
  'party-card-ocr': {
    version: 'v1.0',
    notes: 'A visiting card or letterhead read into name, contact, phone, email, address, GSTIN. Lives in utils/partyCardOcr.js.',
    system: null,
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
