'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE COMPLAINTS KEEP SAYING
//
//  Two layers, and keeping them apart is the whole design.
//
//  ── Layer one: counts. Works on day one. ─────────────────────────
//  `category` is an enum on the model, so "shade complaints doubled
//  this quarter" is a group-by. No model, no prose, no judgement. Nine
//  complaints in three categories is a thin fact but it is a FACT, and
//  it is available the day the feature ships.
//
//  ── Layer two: themes. Refuses to run on thin data. ──────────────
//  Clustering free text is where this earns its keep and also where it
//  would do the most damage. Hand Claude nine complaints and it will
//  return four confident themes, because that is what it was asked for
//  — and every one of them will be an artefact of nine sentences. The
//  themes will be quoted in a meeting. Somebody will change a process
//  because of them.
//
//  The audit that specified this feature said it plainly: themes need
//  a year of data to mean anything. So MIN_FOR_THEMES is enforced, and
//  below it this service returns the counts and a sentence saying why
//  there are no themes — NOT an empty list, which reads as "no themes
//  found" and is a different and false claim.
//
//  ── The model does not get to invent a number ────────────────────
//  Same rule as the planner and the root-cause report: Claude groups
//  the prose and names the group. Every COUNT in the output is computed
//  here from the grouping it returned, by len(). A model asked for both
//  a theme and its frequency will produce a plausible frequency, and a
//  plausible frequency is indistinguishable from a real one on a page.
// ══════════════════════════════════════════════════════════════════

const Complaint = require('../models/Complaints');
const { CATEGORIES } = require('../models/Complaints');

const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion, systemPrompt } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

/**
 * Below this many complaints in the window, no themes are produced.
 *
 * Not a statistical threshold — there is no test here to be powered.
 * It is the point below which a reader would over-read the output. A
 * theme covering three of twelve complaints looks like a pattern and is
 * a coincidence; the same theme over thirty of a hundred and twenty is
 * worth a morning. Raise it rather than lower it if it is ever argued
 * about.
 */
const MIN_FOR_THEMES = 25;

/** Free text longer than this is truncated before it reaches the model. */
const MAX_TEXT = 400;

/** How many complaints are sent in one pass. */
const MAX_SAMPLE = 120;

/** The text of a complaint, as one string. */
function textOf(c) {
  const parts = [c.reason, c.feedback].filter((s) => s && s.trim());
  const joined = parts.join(' — ').replace(/\s+/g, ' ').trim();
  return joined.length > MAX_TEXT ? `${joined.slice(0, MAX_TEXT)}…` : joined;
}

/**
 * Counts per category and per status. Deterministic, always returned.
 *
 * Categories with zero complaints are included rather than dropped: a
 * reader scanning for "width" needs to see that it is zero, not have to
 * work out whether zero means none or means the row was omitted.
 */
function countBy(complaints) {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const byStatus = {};
  for (const c of complaints) {
    const cat = CATEGORIES.includes(c.category) ? c.category : 'other';
    byCategory[cat] += 1;
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  }
  return { byCategory, byStatus };
}

/**
 * Group the free text into themes.
 *
 * The model returns an assignment — theme label, and which complaint
 * indices belong to it. Counts are derived from that assignment here.
 * Anything it returns that does not parse, or that references an index
 * outside the sample, is dropped rather than repaired: a theme built
 * from a hallucinated index is a theme about a complaint nobody made.
 */
async function clusterText(sample) {
  const claude = anthropic();
  if (!claude) return { themes: null, aiGenerated: false, reason: 'no-client' };

  const listing = sample
    .map((c, i) => `${i}. [${c.category}] ${textOf(c)}`)
    .join('\n');

  const startedAt = Date.now();
  try {
    const msg = await claude.messages.create({
      model: TEXT_MODEL,
      max_tokens: 1200,
      system: systemPrompt('complaint-themes'),
      messages: [{
        role: 'user',
        content:
          `${sample.length} customer complaints, one per line, numbered from 0:\n\n${listing}\n\n` +
          'Group them into themes and return the JSON described in your instructions.',
      }],
    });

    const raw = (msg.content || [])
      .filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

    let parsed = null;
    try {
      // Tolerate a fenced block; refuse anything else rather than guess.
      const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }

    const proposedThemes = Array.isArray(parsed?.themes) ? parsed.themes : null;
    if (!proposedThemes) {
      await ledger.record({
        surface: 'complaint-themes',
        model: TEXT_MODEL,
        promptVersion: promptVersion('complaint-themes'),
        latencyMs: Date.now() - startedAt,
        error: 'model returned unparseable themes',
      });
      return { themes: null, aiGenerated: false, reason: 'unparseable' };
    }

    const seen = new Set();
    const themes = [];
    for (const t of proposedThemes) {
      const label = String(t?.label || '').trim();
      if (!label) continue;
      // Indices are the model's only factual claim, and every one is
      // checked. Out of range, duplicated across themes, or not a
      // number — dropped.
      const members = [...new Set((Array.isArray(t?.members) ? t.members : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < sample.length)
        .filter((n) => !seen.has(n)))];
      if (members.length === 0) continue;
      for (const n of members) seen.add(n);
      themes.push({
        label,
        // Counted here, never taken from the model.
        count: members.length,
        sharePct: Math.round((members.length / sample.length) * 1000) / 10,
        complaintIds: members.map((n) => String(sample[n]._id)),
        examples: members.slice(0, 3).map((n) => textOf(sample[n])),
      });
    }

    themes.sort((a, b) => b.count - a.count);

    // Complaints the model put in no theme. Reported rather than hidden:
    // a themes list covering 40% of the complaints is a different object
    // from one covering 95%, and the reader cannot tell without this.
    const ungrouped = sample.length - seen.size;

    const ledgerId = await ledger.record({
      surface: 'complaint-themes',
      model: TEXT_MODEL,
      promptVersion: promptVersion('complaint-themes'),
      refType: 'complaint-window',
      proposed: { themes: themes.map((t) => ({ label: t.label, count: t.count })), ungrouped },
      latencyMs: Date.now() - startedAt,
      usage: msg.usage,
    });

    return { themes, ungrouped, aiGenerated: true, ledgerId: ledgerId ? String(ledgerId) : null };
  } catch (err) {
    console.warn('[complaintThemes] clustering failed:', err?.message);
    await ledger.record({
      surface: 'complaint-themes',
      model: TEXT_MODEL,
      promptVersion: promptVersion('complaint-themes'),
      latencyMs: Date.now() - startedAt,
      error: err?.message || String(err),
    });
    return { themes: null, aiGenerated: false, reason: 'error' };
  }
}

/**
 * Categories and, where there is enough of it, themes.
 *
 * @param {{days?: number, minForThemes?: number}} opts
 */
async function analyse({ days = 365, minForThemes = MIN_FOR_THEMES } = {}) {
  const windowDays = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : 365;
  const since = new Date(Date.now() - windowDays * 86400_000);

  const complaints = await Complaint.find({ date: { $gte: since } })
    .select('reason feedback category status date customer')
    .sort({ date: -1 })
    .lean();

  const counts = countBy(complaints);
  const base = {
    windowDays,
    total: complaints.length,
    ...counts,
    themes: null,
    ungrouped: null,
    aiGenerated: false,
  };

  if (complaints.length === 0) {
    return { ...base, note: 'No complaints recorded in this window.' };
  }

  if (complaints.length < minForThemes) {
    return {
      ...base,
      // Deliberately not an empty themes array. "None found" and "not
      // enough data to look" are different claims and only one is true.
      note:
        `${complaints.length} complaint(s) in the last ${windowDays} days. Themes are not produced below ` +
        `${minForThemes}: grouping this few would return categories that look like patterns and are not. ` +
        'The counts above are exact, and the lot trace on each individual complaint works regardless.',
      belowThreshold: true,
    };
  }

  // Newest first, so a sample cap keeps the most recent rather than an
  // arbitrary slice of history.
  const sample = complaints.slice(0, MAX_SAMPLE).filter((c) => textOf(c));
  if (sample.length < minForThemes) {
    return {
      ...base,
      note:
        `${complaints.length} complaint(s), but only ${sample.length} carry any text to group. ` +
        `Themes are not produced below ${minForThemes}.`,
      belowThreshold: true,
    };
  }

  const result = await clusterText(sample);
  if (!result.themes) {
    return {
      ...base,
      note:
        result.reason === 'no-client'
          ? 'Theme grouping is not configured (no API key). The counts above are unaffected.'
          : 'Theme grouping did not return a usable answer this time. The counts above are unaffected.',
    };
  }

  return {
    ...base,
    sampled: sample.length,
    themes: result.themes,
    ungrouped: result.ungrouped,
    aiGenerated: true,
    ledgerId: result.ledgerId,
  };
}

module.exports = { analyse, countBy, clusterText, textOf, MIN_FOR_THEMES };
