'use strict';

// ─────────────────────────────────────────────────────────────────
//  Shared Anthropic (Claude) client.
//
//  Lazy so a missing API key surfaces as a clean 503 at the route
//  rather than crashing the server at boot; the client is reused
//  across requests once created.
//
//  Env:
//    ANTHROPIC_API_KEY   (required for any Claude-backed feature)
//    ANTHROPIC_MODEL     text default  (advisor briefing)
//    SHIFT_OCR_MODEL     vision default (shift-sheet OCR)
// ─────────────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function anthropic() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// ── Model identifiers, and why one of these is riskier ────────────
//
// TEXT_MODEL is pinned to a dated snapshot. VISION_MODEL is an ALIAS:
// it resolves to whatever the current Sonnet 5 snapshot is, and can
// therefore move under you with no deploy on your side.
//
// That is the one kind of change that is hard to correlate with
// anything — OCR accuracy shifts on a Tuesday, nothing in the repo
// changed, and both sides of the break look identical from here.
//
// Two mitigations, in order of preference:
//   1. Set SHIFT_OCR_MODEL to a dated snapshot in config/.env once one
//      is published for the vision model you want. That makes a model
//      change a deliberate act.
//   2. Failing that, the AI ledger records the model string on every
//      suggestion, and GET /api/v2/health/ai reports which strings are
//      aliases — so a silent swap is at least VISIBLE, and an accuracy
//      drop can be checked against it.
//
// The alias is left as the default rather than guessed at: a wrong
// snapshot id is a hard failure on every vision call, which is worse
// than a drifting one.
const TEXT_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-haiku-4-5-20251001';
// Handwriting OCR wants the stronger vision model by default.
const VISION_MODEL = process.env.SHIFT_OCR_MODEL   || 'claude-sonnet-5';

/** A model string with no -YYYYMMDD suffix can be re-pointed upstream. */
const isPinned = (m) => /-\d{8}$/.test(String(m || ''));

module.exports = { anthropic, TEXT_MODEL, VISION_MODEL, isPinned };
