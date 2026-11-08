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

  'inbox-triage': {
    version: 'v1.0',
    notes: 'A customer\'s mail sorted into purchase_order, complaint, payment_advice, enquiry or other, with a one-line summary. Keywords first; the model only refines. The mail then goes to that kind\'s own reader. Lives in services/customerInbox.js.',
    system: null,
  },

  'feedback-themes': {
    version: 'v1.0',
    notes: 'Groups what workers wrote in feedback. Names are never sent; returns an assignment only — every count is computed in services/feedbackThemes.js.',
    system:
      'You are grouping complaints and suggestions written by workers at an elastic (narrow-fabric) factory ' +
      'in Tamil Nadu, so the owner can see what keeps coming up. They may be in English, Tamil or Tanglish.\n\n' +
      'Return ONLY a JSON object, no prose around it, of the form:\n' +
      '{"themes":[{"label":"short phrase in English","members":[0,3,7]}]}\n\n' +
      'Rules:\n' +
      '- `members` are the line numbers given to you. Never invent one, and never repeat a number across two themes.\n' +
      '- Do NOT return counts, percentages or totals.\n' +
      '- A label names the SPECIFIC matter a worker would recognise — "no fans on loom row 3", ' +
      '"night shift canteen closed" — not a category word already given to you.\n' +
      '- Never put a person\'s name, or anything that would identify who wrote it, in a label.\n' +
      '- Leave a note out of every theme if it does not genuinely belong to one.',
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
  'po-chase-reply': {
    version: 'v1.0',
    notes: 'A supplier\'s WhatsApp reply to a chaser about a late purchase order, read into promise (a dispatch date), dispatched, problem or other. Keywords first; the model only refines, within a few seconds. Lives in services/poChaser.js.',
    system: null,
  },

  'collection-reply': {
    version: 'v1.0',
    notes: 'A customer\'s WhatsApp reply to a payment reminder read into promise, paid, dispute, statement or other, with the date promised, the amount and any reference. Keywords first; the model only refines, within a few seconds. Lives in services/collectionReply.js.',
    system: null,
  },

  'customer-assistant': {
    version: 'v1.0',
    notes: 'A customer\'s WhatsApp message (English, Tamil or Tanglish) sorted into order_status, statement, invoice_copy, new_order, money or other, with any order or invoice number named. Keywords first; the model only refines. Answers come from the records, never from the model. Lives in services/customerAssistant.js.',
    system: null,
  },

  'whatsapp-order': {
    version: 'v1.0',
    notes: 'An order typed into a WhatsApp message, read with the inbound PO schema and matched to elastics like a document; the customer is the sender. Drafted into an order request for the office to open as an order. Lives in utils/inboundPoOcr.js (extractPurchaseOrderText) and services/inboundPoIntake.js (draftFromText).',
    system: null,
  },

  'elastic-spec-ocr': {
    version: 'v1.0',
    notes: 'A technical sheet, a customer\'s drawing or a photo of a sample with its label read into the elastic form: width, weave, colour, ends, pick, hooks, weight and each yarn as written, matched to materials of its kind (a differing count never matched). Lives in utils/elasticSpecOcr.js; route POST /elastic/read-spec.',
    system: null,
  },

  'inward-dc-ocr': {
    version: 'v1.0',
    notes: 'A supplier\'s delivery challan or invoice photo read into goods received (material, quantity, unit, rate, their DC and PO numbers) and cone or bag labels into lots (lot, count, shade, weight), matched to the open PO lines. Lives in utils/inwardOcr.js.',
    system: null,
  },

  'pod-ocr': {
    version: 'v1.0',
    notes: 'A signed delivery challan copy or a transporter\'s proof of delivery read into delivered-on date, receiver, remark and any shortage/damage. Lives in utils/podOcr.js.',
    system: null,
  },

  'notice-ocr': {
    version: 'v1.0',
    notes: 'A GST (ASMT-10, DRC-01, DRC-01A/B, REG-03…), income tax, PF or ESI notice read into authority, form, reference, period, amount, issued date and reply deadline. Lives in utils/noticeOcr.js.',
    system: null,
  },

  'material-dedupe': {
    version: 'v1.0',
    notes: 'Raw materials grouped as likely the same yarn (count, ply, denier, fibre, shade) with a standard name proposed; a person merges. Grouping and naming are by rules in services/materialDedupe.js (no model call); the ledger scores the proposed name against the name kept.',
    system: null,
  },

  'quote-enquiry': {
    version: 'v1.0',
    notes: 'A customer\'s enquiry (message, email or sample photo) read into the quote form: elastic spec, quantity, matched elastic; a cover note drafted. Prices come from the cost model and past quotes, never from the model. Lives in services/quoteEnquiry.js.',
    system: null,
  },

  'shift-handover': {
    version: 'v1.0',
    notes: 'A shift\'s handover note written over figures computed in services/shiftHandover.js (metres vs plan, looms down and why, open issues). Prose only.',
    system: null,
  },

  'month-commentary': {
    version: 'v1.0',
    notes: 'A month\'s plain-language commentary written over figures computed in services/monthCommentary.js (sales, mix, yarn cost per metre, overdue, unusual expenses). Prose only.',
    system: null,
  },

  'stores-voice': {
    version: 'v1.0',
    notes: 'A storekeeper\'s spoken or typed line read into issue / receive / return, quantity, material, job and lot. Rules first, the model only when they cannot; the material is matched by code (numbers never conflict). Lives in services/storesCommand.js.',
    system: null,
  },

  'journal-narration': {
    version: 'v1.0',
    notes: 'A one-line narration for a journal, from the narrations already used for the same ledgers, else written by the model from the lines. Lives in services/journalNarration.js.',
    system: null,
  },

  'cone-count': {
    version: 'v1.0',
    notes: 'Cones counted in a photo of a rack, pallet or bag for the stock take: rows × columns where it can, with how sure. Experimental; the count is confirmed by a person. Lives in utils/coneCount.js.',
    system: null,
  },

  'cheque-ocr': {
    version: 'v1.0',
    notes: 'A cancelled cheque, passbook page or bank letter read into account number, IFSC, bank, branch and holder; the holder compared with the party\'s name. Lives in utils/kycOcr.js.',
    system: null,
  },

  'id-card-ocr': {
    version: 'v1.0',
    notes: 'An Aadhaar, PAN card or passbook read into the employee form (name, date of birth, gender, PAN, the Aadhaar\'s last four only, bank). The full Aadhaar number is never returned. Lives in utils/kycOcr.js.',
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
    version: 'v1.1',
    notes: 'Read-only tool-calling agent over whitelisted queries; v1.1 adds run_report over the report engine.',
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
