'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A WORKER SAID ABOUT A MACHINE, WRITTEN UP AS AN ISSUE
//
//  The worker speaks (the browser turns Tamil or English speech into
//  text) or photographs the fault. Back come a short title and a clear
//  English description for the maintenance person, a severity, and —
//  checked against the machine's own open issues — whether this is one
//  already reported, so the same fault is not opened twice.
//
//  The severity is a suggestion the worker can change; anything about
//  fire, smoke, sparks, a shock or an injury is never put below "high".
//  With no model configured, the same from keywords.
//
//  Nothing is saved here: the form opens filled in, and what is filed
//  settles the AI ledger row.
// ══════════════════════════════════════════════════════════════════

const MachineIssue = require('../models/MachineIssue');
const Machine = require('../models/Machine');
const { anthropic, TEXT_MODEL, VISION_MODEL } = require('../utils/anthropicClient');
const ledger = require('./aiLedger');
const { promptVersion } = require('../utils/aiPrompts');

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const OPEN = ['open', 'acknowledged', 'in_progress'];
const DANGER = /\b(fire|smoke|spark|sparking|burn(?:ing)?|shock|current|injur|hurt|blood|accident)|தீ|புகை|ஷாக்|கரண்ட்/i;
const STOPPED = /\b(stop(?:ped|s)?|not (?:running|working|starting)|won'?t start|broke(?:n)?|jam(?:med)?|dead|down)|நிக்குது|ஓடல|ஓடவில்லை|வேலை செய்யல/i;
const MINOR = /\b(noise|sound|vibrat|slow|oil|leak|loose|squeak)|சத்தம்/i;

function keywordSeverity(text) {
  const t = String(text || '');
  if (DANGER.test(t)) return 'critical';
  if (STOPPED.test(t)) return 'high';
  if (MINOR.test(t)) return 'medium';
  return 'medium';
}

/** Words in common with an open issue, as a share of the shorter. */
function overlap(a, b) {
  const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9஀-௿]+/).filter((w) => w.length >= 3));
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n += 1;
  return n / Math.min(A.size, B.size);
}

function firstSentence(text) {
  const s = String(text || '').trim().split(/(?<=[.!?।])\s+|\n/)[0] || '';
  return s.length > 70 ? `${s.slice(0, 67).trim()}…` : s;
}

function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  if (s === -1 || e === -1) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch { return null; }
}

function fallback(text, open) {
  const dup = open.map((o) => ({ o, score: overlap(text, `${o.title} ${o.description}`) })).sort((x, y) => y.score - x.score)[0];
  return {
    title: firstSentence(text) || 'Machine fault',
    description: String(text || '').trim().slice(0, 1000),
    severity: keywordSeverity(text),
    duplicateOf: dup && dup.score >= 0.5 ? String(dup.o._id) : null,
    confidence: 0.3,
  };
}

const PROMPT = [
  'You write up a fault on a loom or covering machine in an elastic weaving factory in Tiruppur, from what',
  'the operator said (spoken, turned into text: it may be Tamil, English or mixed, with speech-to-text slips)',
  'and/or a photo. The reader is the maintenance fitter.',
  '',
  'Return ONLY a JSON object, no prose:',
  '{"title":"Head 3 breaking rubber every few minutes","description":"...","severity":"high","duplicateOf":null,"confidence":0.8}',
  '',
  'Rules:',
  '- title: at most 60 characters, English, what is wrong and where (head, side, motor, take-up, needle...).',
  '- description: 1 to 3 plain English sentences of what the operator reported: what happens, since when,',
  '  how often, what they already tried. Translate Tamil. Do not invent causes or add advice.',
  `- severity: one of ${SEVERITIES.join(', ')}. critical for fire, smoke, sparks, electric shock or injury;`,
  '  high when the machine has stopped or cannot run; medium when it runs badly; low for a small thing.',
  '- duplicateOf: the number n of an open issue listed below that is clearly the same fault, else null.',
  '- confidence: 0 to 1.',
].join('\n');

/**
 * @param {{ machineId: string, text?: string, image?: {buffer: Buffer, mimetype: string} }} p
 */
async function intake({ machineId, text = '', image = null }) {
  const machine = await Machine.findById(machineId).select('ID manufacturer').lean();
  if (!machine) { const e = new Error('Machine not found'); e.status = 404; throw e; }
  const open = await MachineIssue.find({ machine: machine._id, status: { $in: OPEN } })
    .select('title description severity status createdAt').sort({ createdAt: -1 }).limit(10).lean();
  const openOut = open.map((o) => ({ _id: String(o._id), title: o.title, severity: o.severity, status: o.status, createdAt: o.createdAt }));

  const claude = anthropic();
  if (!claude) return { ...fallback(text, open), openIssues: openOut, aiGenerated: false, aiSuggestion: null };

  const model = image ? VISION_MODEL : TEXT_MODEL;
  const listing = open.map((o, i) => `${i}. ${o.title} — ${String(o.description || '').slice(0, 160)} (${o.severity}, ${o.status})`).join('\n');
  const startedAt = Date.now();
  try {
    const content = [
      ...(image ? [{ type: 'image', source: { type: 'base64', media_type: image.mimetype, data: image.buffer.toString('base64') } }] : []),
      { type: 'text', text: `Machine: ${machine.ID}${machine.manufacturer ? ` (${machine.manufacturer})` : ''}\n\nWhat the operator said:\n"""\n${String(text || '(photo only)').slice(0, 3000)}\n"""\n\nOpen issues on this machine:\n${listing || '(none)'}\n\n${PROMPT}` },
    ];
    const msg = await claude.messages.create({ model, max_tokens: 600, messages: [{ role: 'user', content }] });
    const raw = parseJson((msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
    if (!raw || !String(raw.title || '').trim()) throw new Error('model returned unparseable JSON');
    let severity = SEVERITIES.includes(raw.severity) ? raw.severity : keywordSeverity(text);
    // Danger words are never written down as a small thing, whatever the model said.
    if (DANGER.test(text) && !['high', 'critical'].includes(severity)) severity = 'critical';
    const d = raw.duplicateOf == null ? null : Number(raw.duplicateOf);
    const out = {
      title: String(raw.title).trim().slice(0, 80),
      description: String(raw.description || text || '').trim().slice(0, 1000),
      severity,
      duplicateOf: Number.isInteger(d) && d >= 0 && d < open.length ? String(open[d]._id) : null,
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0.5)),
    };
    const aiSuggestion = await ledger.record({
      surface: 'machine-issue-intake', model, promptVersion: promptVersion('machine-issue-intake'), refType: 'machine', refId: machine._id,
      proposed: { title: out.title, description: out.description, severity: out.severity },
      latencyMs: Date.now() - startedAt, usage: msg.usage,
    });
    return { ...out, openIssues: openOut, aiGenerated: true, aiSuggestion: aiSuggestion ? String(aiSuggestion) : null };
  } catch (err) {
    await ledger.record({ surface: 'machine-issue-intake', model, promptVersion: promptVersion('machine-issue-intake'), latencyMs: Date.now() - startedAt, error: err?.message || String(err) });
    return { ...fallback(text, open), openIssues: openOut, aiGenerated: false, aiSuggestion: null };
  }
}

module.exports = { intake, keywordSeverity, overlap, PROMPT };
