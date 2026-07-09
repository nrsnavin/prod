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

// Cheap + fast is plenty for a 3-sentence briefing; override per env.
const TEXT_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-haiku-4-5-20251001';
// Handwriting OCR wants the stronger vision model by default.
const VISION_MODEL = process.env.SHIFT_OCR_MODEL   || 'claude-sonnet-5';

module.exports = { anthropic, TEXT_MODEL, VISION_MODEL };
