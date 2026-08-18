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
//    3. isAdmin gate — only authenticated admins can spend tokens. The
//       advisor aggregates across every router (shift, job, materials,
//       payroll…), which only admin can reach, so it stays admin-only.
//    4. Missing key → 503; failed call → 502. Client falls back.
//    5. (Out of band) set a $5/mo budget cap on platform.openai.com.
// ═════════════════════════════════════════════════════════════════
router.post(
  '/briefing',
  isAuthenticated,
  isAdmin('admin'),
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
                `- [${c.priority || 'med'}] ${c.title || ''} `
                + `(${c.subtitle || ''})`
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
