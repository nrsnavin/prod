'use strict';
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER'S PO, DRAFTED INTO AN ORDER
//
//  Read the document, match what it names against the masters, and hand
//  a person a filled-in form to check. Order entry drops from minutes
//  of typing to a glance and a confirm.
//
//  ── Stage → verify → apply, exactly as everywhere else ───────────
//  This creates NOTHING. It returns a draft with, for every line, the
//  candidates it matched and how sure it is about each. The existing
//  order-create route is what writes, driven by a person who has looked
//  at it. That is the same pattern as the shift sheet and QC vision,
//  and it is the reason those two are trusted on the floor.
//
//  ── Where this breaks, and what is done about it ─────────────────
//  Elastic name matching. "20mm Knitted Elastic" and "25mm Knitted
//  Elastic" differ by one character and by everything that matters. See
//  utils/fuzzyMatch.js: numbers are compared separately from words and
//  a numeric conflict BLOCKS a candidate outright rather than merely
//  scoring it lower.
//
//  On top of that, a match is only preselected when it is both strong
//  and clearly ahead of the runner-up. Two candidates at 0.82 is a coin
//  toss, and a preselected coin toss is how the wrong product reaches
//  an order without anybody looking at it.
// ══════════════════════════════════════════════════════════════════

const Customer = require('../models/Customer');
const Elastic  = require('../models/Elastic');

const { extractPurchaseOrder } = require('../utils/inboundPoOcr');
const { rank } = require('../utils/fuzzyMatch');
const { promptVersion } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

/**
 * Turn an uploaded document into a draft order for somebody to confirm.
 *
 * Never throws for a document it simply could not read — that is a
 * normal outcome and comes back as `ok: false` with the reason.
 */
async function draftFromDocument(buffer, mimetype, { userId } = {}) {
  const startedAt = Date.now();

  let extracted;
  try {
    extracted = await extractPurchaseOrder(buffer, mimetype);
  } catch (err) {
    // An unsupported file type is the caller's mistake, not the model's,
    // and is not recorded against the surface.
    if (err.code === 'UNSUPPORTED_TYPE') throw err;
    await ledger.record({
      surface: 'inbound-po-ocr',
      model: 'unknown',
      promptVersion: promptVersion('inbound-po-ocr'),
      latencyMs: Date.now() - startedAt,
      error: err.message,
    });
    throw err;
  }

  if (!extracted.available) return { available: false };

  if (!extracted.ok) {
    await ledger.record({
      surface: 'inbound-po-ocr',
      model: extracted.model,
      promptVersion: promptVersion('inbound-po-ocr'),
      latencyMs: Date.now() - startedAt,
      usage: extracted.usage,
      error: 'reply could not be parsed as JSON',
    });
    return {
      available: true, ok: false,
      message: "Couldn't read that document confidently — enter the order manually.",
    };
  }

  const draft = extracted.draft;

  // ── Match against the masters ──
  const [customers, elastics] = await Promise.all([
    Customer.find({}).select('name').lean(),
    // Archived products are deliberately excluded: offering one would
    // draft an order for something the plant has stopped making.
    Elastic.find({ archived: { $ne: true } }).select('name').lean(),
  ]);

  const customerMatch = draft.customerName
    ? rank(draft.customerName, customers.map((c) => ({ id: String(c._id), label: c.name })))
    : { best: null, candidates: [], confident: false, blocked: [] };

  const elasticChoices = elastics.map((e) => ({ id: String(e._id), label: e.name }));

  const lines = draft.lines.map((l) => {
    const m = rank(l.description, elasticChoices);
    return {
      ...l,
      match: {
        elasticId: m.confident ? m.best.id : null,
        elasticName: m.confident ? m.best.label : null,
        // Every candidate, always — the wrong pick has to be one click
        // to fix, and that only works if the alternatives are here.
        candidates: m.candidates.map((c) => ({ id: c.id, name: c.label, score: c.score })),
        confident: m.confident,
        // Named explicitly so a person can see WHY a near-identical
        // product was not offered, rather than wondering where it went.
        blockedByWidth: m.blocked.map((b) => ({ name: b.label, reason: b.reason })),
      },
    };
  });

  const unmatched = lines.filter((l) => !l.match.confident).length;

  const suggestionId = await ledger.record({
    surface: 'inbound-po-ocr',
    model: extracted.model,
    promptVersion: promptVersion('inbound-po-ocr'),
    proposed: {
      customerName: draft.customerName,
      poNumber: draft.poNumber,
      matchedCustomer: customerMatch.confident ? customerMatch.best.label : null,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        rate: l.rate,
        matchedElastic: l.match.elasticName,
      })),
    },
    latencyMs: Date.now() - startedAt,
    usage: extracted.usage,
  });

  return {
    available: true,
    ok: true,
    aiSuggestionId: suggestionId ? String(suggestionId) : null,
    model: extracted.model,
    draft: {
      ...draft,
      lines,
      customer: {
        customerId: customerMatch.confident ? customerMatch.best.id : null,
        customerName: customerMatch.confident ? customerMatch.best.label : null,
        candidates: customerMatch.candidates.map((c) => ({ id: c.id, name: c.label, score: c.score })),
        confident: customerMatch.confident,
      },
    },
    summary: {
      lines: lines.length,
      matched: lines.length - unmatched,
      needsAttention: unmatched,
      customerMatched: customerMatch.confident,
    },
    // Said out loud on the response, not just in the UI. Anything
    // reading this API has to know it is holding a proposal.
    disclaimer:
      'A draft read from a document. Nothing has been created. Check every line — ' +
      'particularly the widths and the rates — before saving the order.',
  };
}

/**
 * Record what the person actually saved, against what was read.
 *
 * Called by the order-create path when the order came from an intake
 * draft. This is what turns the feature from a convenience into
 * something whose accuracy is known.
 */
async function settleDraft(aiSuggestionId, opts) {
  // Destructured defensively rather than in the signature: `= {}` only
  // covers `undefined`, so an explicit null — which a caller passing
  // through an optional value will produce — would throw. Nothing about
  // recording a measurement is allowed to break the caller.
  const { order, decidedBy } = opts || {};
  if (!aiSuggestionId || !order) return null;
  return ledger.settle(aiSuggestionId, {
    expectSurface: 'inbound-po-ocr',
    accepted: {
      customerName: order.customerName ?? null,
      poNumber: order.po ?? null,
      matchedCustomer: order.customerName ?? null,
      lines: (order.lines || []).map((l) => ({
        description: l.description ?? null,
        quantity: l.quantity ?? null,
        rate: l.rate ?? null,
        matchedElastic: l.elasticName ?? null,
      })),
    },
    decidedBy,
  });
}

module.exports = { draftFromDocument, settleDraft };
