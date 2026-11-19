'use strict';

const express = require('express');
const router  = express.Router();
const { isAuthenticated, isAdmin } = require('../middleware/auth');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion } = require('../utils/aiPrompts');
const ledger = require('../services/aiLedger');

// Claude Haiku is plenty for a 3-sentence summary:
//   - latency ~1s for a few-token response
//   - cost is a fraction of a cent per briefing
//   - quality is well above what a briefing needs
// Override via ANTHROPIC_MODEL if you want to A/B test a larger model.
const MODEL = TEXT_MODEL;

/** A card's field as one line of text, cut to `max`; anything else is nothing. */
const line = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');

// ═════════════════════════════════════════════════════════════════
//  POST /api/v2/advisor/briefing
//
//  Body: { cards: [{ id, title, subtitle, priority }, ...] }
//
//  Returns a 2–3 sentence morning-briefing summary written by the
//  model, with the most-urgent phrase wrapped in **double
//  asterisks** so the Flutter widget can bold it.
//
//  Cost guards (in order of importance):
//    1. max_tokens = 220 caps output cost at fractions of a cent.
//    2. the cards are cut to the top 8, and each to a line of text —
//       input cost is capped regardless of client behaviour. (It was
//       the number alone: eight cards could carry megabytes.)
//    3. isAdmin gate — only authenticated admins can spend tokens. The
//       advisor aggregates across every router (shift, job, materials,
//       payroll…), which only admin can reach, so it stays admin-only.
//    4. Missing key → 503; failed call → 502. Client falls back.
//    5. (Out of band) set a monthly spend limit in the Anthropic console.
// ═════════════════════════════════════════════════════════════════
router.post(
  '/briefing',
  isAuthenticated,
  // Finance has the advisor in its menu (utils/features.js); the cards it
  // sends are the dashboard figures it can already read.
  isAdmin('admin', 'accounts'),
  async (req, res) => {
    const claude = anthropic();
    if (!claude) {
      return res.status(503).json({
        success: false,
        reason:  'ANTHROPIC_KEY_MISSING',
        message: 'ANTHROPIC_API_KEY not set on the server.',
      });
    }

    // Even if a buggy client sends 100 cards we only ever send the
    // most-actionable 8 to the LLM. Caller is expected to already
    // sort by priority, but we don't trust that.
    //
    // What is not a card is set aside here. A null in the list used to
    // throw while the prompt was being built — inside the try below, so
    // it was answered as the model's failure (502) and written to the AI
    // ledger as a failed call that was never made.
    const cards = (req.body && Array.isArray(req.body.cards) ? req.body.cards : [])
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({ priority: line(c.priority, 12) || 'med', title: line(c.title, 160), subtitle: line(c.subtitle, 240) }))
      .filter((c) => c.title || c.subtitle)
      .slice(0, 8);

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

    const startedAt = Date.now();
    try {
      const message = await claude.messages.create({
        model: MODEL,
        max_tokens: 220,
        system:
          'You are a calm, brief plant-floor supervisor giving the '
          + 'admin a morning briefing on their ERP. Use 2-3 short '
          + 'sentences. No bullet lists. Identify the single most '
          + 'urgent action. Mention numbers from the input verbatim. '
          + 'Use plain text; wrap the most-urgent phrase in '
          + '**double asterisks** so the UI can bold it.',
        messages: [
          { role: 'user', content:
              `Today's advisor signals:\n${cards.map((c) =>
                `- [${c.priority}] ${c.title} (${c.subtitle})`
              ).join('\n')}\n\nWrite the morning briefing.` },
        ],
      });

      // Claude returns an array of content blocks; concatenate the text.
      const summary = (message.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      // No settle for this surface: a briefing is read and closed, and
      // nothing the admin does afterwards is attributable to it. What
      // the ledger gives here is the operational half — latency, token
      // spend and the failure rate — which nothing recorded before.
      await ledger.record({
        surface: 'advisor-briefing',
        model:   MODEL,
        promptVersion: promptVersion('advisor-briefing'),
        proposed: { summary, cards: cards.length },
        latencyMs: Date.now() - startedAt,
        usage: message.usage,
      });

      return res.json({
        success: true,
        summary,
        model:  message.model,
        viaLlm: true,
        usage:  message.usage,
      });
    } catch (err) {
      console.error('[advisor/briefing] Claude error:', err.message);
      await ledger.record({
        surface: 'advisor-briefing',
        model:   MODEL,
        promptVersion: promptVersion('advisor-briefing'),
        latencyMs: Date.now() - startedAt,
        error: err.message,
      });
      return res.status(502).json({
        success: false,
        reason:  'ANTHROPIC_CALL_FAILED',
        message: err.message,
      });
    }
  }
);

module.exports = router;
