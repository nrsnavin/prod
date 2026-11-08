'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE WORKERS KEEP RAISING
//
//  Worker feedback (models/EmployeeFeedback.js) is read one note at a
//  time in the inbox. This says what keeps coming up, the same way the
//  customer complaint themes do (services/complaintThemes.js):
//
//    • counts by category and type — exact, always;
//    • themes — only with enough notes to mean something (MIN_FOR_THEMES),
//      the model grouping the prose and every count worked out here.
//
//  Anonymity is kept. The model sees what was written and its category,
//  never a name or an employee id. Examples are quoted only from themes
//  of three or more notes, and never with who wrote them — a theme of
//  one or two would point at the person.
// ══════════════════════════════════════════════════════════════════

const Feedback = require('../models/EmployeeFeedback');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');
const { promptVersion, systemPrompt } = require('../utils/aiPrompts');
const ledger = require('./aiLedger');

const SURFACE = 'feedback-themes';
const MIN_FOR_THEMES = 12;
const MIN_FOR_EXAMPLES = 3;
const MAX_SAMPLE = 150;
const MAX_TEXT = 300;
const CATEGORIES = ['machine', 'safety', 'management', 'facilities', 'payroll', 'other'];

function textOf(f) {
  const t = [f.subject, f.body].filter((s) => s && String(s).trim()).join(' — ').replace(/\s+/g, ' ').trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
}

function countBy(list) {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const byType = { complaint: 0, suggestion: 0 };
  const byStatus = {};
  for (const f of list) {
    byCategory[CATEGORIES.includes(f.category) ? f.category : 'other'] += 1;
    if (byType[f.type] != null) byType[f.type] += 1;
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
  }
  const answered = list.filter((f) => f.respondedAt);
  const daysToAnswer = answered.length ? Math.round(answered.reduce((t, f) => t + (new Date(f.respondedAt) - new Date(f.createdAt)) / 86_400_000, 0) / answered.length * 10) / 10 : null;
  return { byCategory, byType, byStatus, unanswered: list.length - answered.length, daysToAnswer };
}

async function cluster(sample) {
  const claude = anthropic();
  if (!claude) return { themes: null, reason: 'no-client' };
  // Line number, type, category and the words — nothing about who.
  const listing = sample.map((f, i) => `${i}. [${f.type}/${f.category}] ${textOf(f)}`).join('\n');
  const startedAt = Date.now();
  try {
    const msg = await claude.messages.create({
      model: TEXT_MODEL, max_tokens: 1200, system: systemPrompt(SURFACE),
      messages: [{ role: 'user', content: `${sample.length} notes from workers, one per line, numbered from 0:\n\n${listing}\n\nGroup them into themes and return the JSON described in your instructions.` }],
    });
    const raw = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    let parsed = null;
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()); } catch { parsed = null; }
    if (!Array.isArray(parsed?.themes)) {
      await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: 'model returned unparseable themes' });
      return { themes: null, reason: 'unparseable' };
    }
    const seen = new Set();
    const themes = [];
    for (const t of parsed.themes) {
      const label = String(t?.label || '').trim().slice(0, 120);
      if (!label) continue;
      const members = [...new Set((Array.isArray(t?.members) ? t.members : []).map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < sample.length && !seen.has(n)))];
      if (!members.length) continue;
      members.forEach((n) => seen.add(n));
      const notes = members.map((n) => sample[n]);
      themes.push({
        label,
        count: members.length,
        sharePct: Math.round((members.length / sample.length) * 1000) / 10,
        complaints: notes.filter((f) => f.type === 'complaint').length,
        open: notes.filter((f) => f.status === 'open' || f.status === 'in_review').length,
        // Quoted only where the group is big enough not to point at anyone.
        examples: members.length >= MIN_FOR_EXAMPLES ? notes.slice(0, 2).map(textOf) : [],
      });
    }
    themes.sort((a, b) => b.count - a.count);
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), refType: 'feedback-window', proposed: { themes: themes.map((t) => ({ label: t.label, count: t.count })), ungrouped: sample.length - seen.size }, latencyMs: Date.now() - startedAt, usage: msg.usage });
    return { themes, ungrouped: sample.length - seen.size };
  } catch (err) {
    await ledger.record({ surface: SURFACE, model: TEXT_MODEL, promptVersion: promptVersion(SURFACE), latencyMs: Date.now() - startedAt, error: err?.message || String(err) });
    return { themes: null, reason: 'error' };
  }
}

/** Counts, and themes where there is enough to group. */
async function analyse({ days = 90, minForThemes = MIN_FOR_THEMES } = {}) {
  const windowDays = Number(days) > 0 ? Math.min(Math.floor(Number(days)), 730) : 90;
  const since = new Date(Date.now() - windowDays * 86_400_000);
  // No employee field is read at all.
  const list = await Feedback.find({ createdAt: { $gte: since } }).select('type category subject body status createdAt respondedAt').sort({ createdAt: -1 }).lean();
  const base = { windowDays, total: list.length, ...countBy(list), themes: null, ungrouped: null, aiGenerated: false };
  if (!list.length) return { ...base, note: 'No feedback in this window.' };
  const sample = list.slice(0, MAX_SAMPLE).filter((f) => textOf(f));
  if (sample.length < minForThemes) {
    return { ...base, belowThreshold: true, note: `${list.length} note(s) in the last ${windowDays} days. Themes start at ${minForThemes}: grouping fewer would show patterns that are not there. The counts are exact.` };
  }
  const r = await cluster(sample);
  if (!r.themes) {
    return { ...base, note: r.reason === 'no-client' ? 'Theme grouping is not set up (no API key). The counts are unaffected.' : 'Theme grouping did not return a usable answer this time. The counts are unaffected.' };
  }
  return { ...base, sampled: sample.length, themes: r.themes, ungrouped: r.ungrouped, aiGenerated: true };
}

module.exports = { analyse, countBy, textOf, MIN_FOR_THEMES, MIN_FOR_EXAMPLES };
