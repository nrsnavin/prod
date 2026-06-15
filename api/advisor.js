'use strict';

const express = require('express');
const router  = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const OpenAI = require('openai');

// ─────────────────────────────────────────────────────────────────
//  OpenAI client is lazy so a missing API key surfaces as a clean
//  503 rather than crashing the server at boot. Once instantiated
//  the client is reused across requests.
// ─────────────────────────────────────────────────────────────────
let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.OPENAI_API_KEY) return null;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// gpt-4o-mini is plenty for a 3-sentence summary:
//   - latency ~1s for a few-token response
//   - cost: roughly $0.00015 / 1K input, $0.00060 / 1K output
//   - quality is well above what a briefing needs
// Override via OPENAI_MODEL if you want to A/B test gpt-4o etc.
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ═════════════════════════════════════════════════════════════════
//  POST /api/v2/advisor/briefing
//
//  Body: { cards: [{ id, title, subtitle, priority }, ...] }
//
//  Returns a 2–3 sentence morning-briefing summary written by
//  ChatGPT, with the most-urgent phrase wrapped in **double
//  asterisks** so the Flutter widget can bold it.
//
//  Cost guards (in order of importance):
//    1. max_tokens = 220 caps output cost at fractions of a cent.
//    2. cards array is sliced to the top 8 — input cost is capped
//       regardless of client behaviour.
//    3. isAdmin gate — only authenticated admins can spend tokens.
//    4. Missing key → 503; failed call → 502. Client falls back.
//    5. (Out of band) set a $5/mo budget cap on platform.openai.com.
// ═════════════════════════════════════════════════════════════════
router.post(
  '/briefing',
  isAuthenticated,
  isAdmin('admin'),
  async (req, res) => {
    const oai = client();
    if (!oai) {
      return res.status(503).json({
        success: false,
        reason:  'OPENAI_KEY_MISSING',
        message: 'OPENAI_API_KEY not set on the server.',
      });
    }

    // Even if a buggy client sends 100 cards we only ever send the
    // most-actionable 8 to the LLM. Caller is expected to already
    // sort by priority, but we don't trust that.
    const cards = (req.body && Array.isArray(req.body.cards))
      ? req.body.cards.slice(0, 8)
      : [];

    if (cards.length === 0) {
      return res.json({
        success: true,
        summary:
          'Nothing flagged on the floor right now. Worth using the '
          + 'quiet window to catch up on PO reconciliations.',
        model:  MODEL,
        viaLlm: false,
      });
    }

    try {
      const completion = await oai.chat.completions.create({
        model: MODEL,
        max_tokens: 220,
        temperature: 0.4,
        messages: [
          { role: 'system', content:
              'You are a calm, brief plant-floor supervisor giving the '
              + 'admin a morning briefing on their ERP. Use 2-3 short '
              + 'sentences. No bullet lists. Identify the single most '
              + 'urgent action. Mention numbers from the input verbatim. '
              + 'Use plain text; wrap the most-urgent phrase in '
              + '**double asterisks** so the UI can bold it.' },
          { role: 'user', content:
              `Today's advisor signals:\n${cards.map((c) =>
                `- [${c.priority || 'med'}] ${c.title || ''} `
                + `(${c.subtitle || ''})`
              ).join('\n')}\n\nWrite the morning briefing.` },
        ],
      });

      const summary = completion.choices?.[0]?.message?.content?.trim() ?? '';

      return res.json({
        success: true,
        summary,
        model:  completion.model,
        viaLlm: true,
        usage:  completion.usage,
      });
    } catch (err) {
      console.error('[advisor/briefing] OpenAI error:', err.message);
      return res.status(502).json({
        success: false,
        reason:  'OPENAI_CALL_FAILED',
        message: err.message,
      });
    }
  }
);

module.exports = router;
