'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SHIFT HANDOVER — what the next supervisor and the owner should know
//
//  Built from what the app already holds for the shift just ended:
//    • metres entered against what the running looms should have made
//      (each loom's learned metres a head-hour × heads × 12 hours)
//    • looms not entered, looms down (maintenance, and what the operators
//      wrote), and machine issues still open — the serious ones first
//  Then two or three lines on what the next shift should watch, written
//  by the model over those facts only (no number of its own); without a
//  model, the lines are put together from the same facts.
//
//  run() — within the first `withinMinutes` of a new shift, once per
//  shift (claimed on the settings row before sending), the note for the
//  shift that just ended goes to the handover numbers, or to the
//  recipients set for `shiftHandover`. Off until an admin turns it on.
// ══════════════════════════════════════════════════════════════════

const ProductionSettings = require('../models/ProductionSettings');
const MachineIssue = require('../models/MachineIssue');
const { currentShift } = require('./machineLoading');
const { anthropic, TEXT_MODEL } = require('../utils/anthropicClient');

const EVERY_MS = 10 * 60_000;
const SHIFT_HOURS = 12;
const SEVERITY = { critical: 0, high: 1, medium: 2, low: 3 };
const fmt = (n) => Math.round(n).toLocaleString('en-IN');

/** The shift before { dateKey, shift }: night before day is the previous day's night. */
function previousShift({ dateKey, shift }) {
  if (shift === 'NIGHT') return { dateKey, shift: 'DAY' };
  const d = new Date(`${dateKey}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return { dateKey: d.toISOString().slice(0, 10), shift: 'NIGHT' };
}

async function figures({ dateKey, shift }) {
  const { shiftState } = require('./floorEntry');
  const state = await shiftState({ dateKey, shift });
  const running = state.machines.filter((m) => m.status === 'running' && m.job);
  let made = 0; let expected = 0; let expectedLooms = 0;
  const remarks = [];
  for (const m of running) {
    const p = Number(m.detail?.submitted?.production);
    if (Number.isFinite(p)) made += p;
    if (m.rate?.metresPerHeadHour && m.headsRunning) { expected += m.rate.metresPerHeadHour * m.headsRunning * SHIFT_HOURS; expectedLooms += 1; }
    const fb = String(m.detail?.submitted?.feedback || '').trim();
    if (fb) remarks.push({ loom: m.ID, text: fb.slice(0, 120) });
  }
  const notEntered = state.machines.filter((m) => m.entry === 'ready' || m.entry === 'unplanned').map((m) => m.ID);
  const down = state.machines.filter((m) => m.status === 'maintenance').map((m) => m.ID);
  const issues = await MachineIssue.find({ status: { $in: ['open', 'acknowledged', 'in_progress'] } })
    .select('title severity status machine createdAt').populate({ path: 'machine', select: 'ID' }).sort({ createdAt: -1 }).limit(50).lean();
  issues.sort((a, b) => (SEVERITY[a.severity] ?? 9) - (SEVERITY[b.severity] ?? 9));
  return {
    dateKey, shift, label: state.label,
    looms: { running: running.length, total: state.machines.length },
    metres: { made: Math.round(made), expected: expectedLooms ? Math.round(expected) : null, expectedLooms },
    notEntered, down, remarks: remarks.slice(0, 10),
    issues: issues.slice(0, 8).map((i) => ({ loom: i.machine?.ID || '', title: i.title, severity: i.severity, status: i.status })),
    openIssues: issues.length,
  };
}

/** What to watch, from the facts alone, when there is no model. */
function watchByRule(f) {
  const out = [];
  const serious = f.issues.filter((i) => i.severity === 'critical' || i.severity === 'high');
  if (serious.length) out.push(`Check ${serious.map((i) => `${i.loom} (${i.title})`).slice(0, 3).join(', ')} before starting.`);
  if (f.notEntered.length) out.push(`Get last shift's metres for ${f.notEntered.slice(0, 6).join(', ')} from the operators.`);
  if (f.metres.expected && f.metres.made < f.metres.expected * 0.85) out.push('Output was well under what the looms usually make — look at the remarks.');
  if (f.down.length) out.push(`${f.down.join(', ')} under maintenance.`);
  return out.slice(0, 3);
}

async function watchByModel(f) {
  const claude = anthropic();
  if (!claude) return null;
  const facts = JSON.stringify({ remarks: f.remarks, issues: f.issues, notEntered: f.notEntered, down: f.down, metres: f.metres });
  const startedAt = Date.now();
  const msg = await claude.messages.create({
    model: TEXT_MODEL, max_tokens: 300,
    messages: [{ role: 'user', content: `You write the handover from one shift supervisor to the next in an elastic weaving factory. From these facts only, give 2 or 3 short lines, each starting "- ", on what the next shift should watch or do first. Name looms. No greeting. Do not state any number that is not in the facts.\n\n${facts}` }],
  });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const lines = text.split('\n').map((l) => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean).slice(0, 3);
  return lines.length ? { lines, usage: msg.usage, latencyMs: Date.now() - startedAt } : null;
}

async function note({ dateKey, shift }) {
  const f = await figures({ dateKey, shift });
  let watch = null; let by = 'rules';
  try {
    const m = await watchByModel(f);
    if (m) {
      watch = m.lines; by = 'model';
      const aiLedger = require('./aiLedger');
      const { promptVersion } = require('../utils/aiPrompts');
      await aiLedger.record({ surface: 'shift-handover', model: TEXT_MODEL, promptVersion: promptVersion('shift-handover'), refType: 'ShiftPlan', proposed: { watch }, latencyMs: m.latencyMs, usage: m.usage }).catch(() => null);
    }
  } catch { /* the rules below say the same from the facts */ }
  if (!watch) watch = watchByRule(f);
  const pct = f.metres.expected ? Math.round((f.metres.made / f.metres.expected) * 100) : null;
  const text = [
    `🔁 *Handover — ${f.label}*`,
    `Metres: ${fmt(f.metres.made)}${f.metres.expected ? ` of about ${fmt(f.metres.expected)} expected (${pct}%)` : ''} · ${f.looms.running} looms running`,
    f.notEntered.length ? `Not entered: ${f.notEntered.slice(0, 12).join(', ')}${f.notEntered.length > 12 ? ` and ${f.notEntered.length - 12} more` : ''}` : 'Every running loom entered.',
    f.down.length ? `Down: ${f.down.join(', ')}` : '',
    f.remarks.length ? `Remarks: ${f.remarks.slice(0, 5).map((r) => `${r.loom} — ${r.text}`).join('; ')}` : '',
    f.openIssues ? `Open issues (${f.openIssues}): ${f.issues.slice(0, 4).map((i) => `${i.loom} ${i.title} [${i.severity}]`).join('; ')}` : 'No open machine issues.',
    watch.length ? `\n*Watch:*\n${watch.map((w) => `• ${w}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  return { figures: f, watch, by, text };
}

async function deliver(phones, body, tag) {
  if (phones.length) {
    const { sendWhatsApp } = require('../utils/whatsapp');
    const Notification = require('../models/Notification');
    let sent = 0; let dryRun = false;
    for (const to of phones) {
      const r = await sendWhatsApp(to, body);
      if (r.sent) sent += 1; if (r.dryRun) dryRun = true;
      await Notification.create({ event: 'shiftHandover', recipient: to, channel: 'whatsapp', body, status: r.sent ? 'sent' : r.dryRun ? 'dry_run' : 'error', reason: r.error || (r.dryRun ? 'provider not configured' : `shift ${tag}`), providerId: r.providerId }).catch(() => null);
    }
    return { to: phones, sent, dryRun };
  }
  const { notify } = require('../utils/notify');
  return notify('shiftHandover', { body });
}

/**
 * Once a tick: early in a new shift, the handover for the one just ended,
 * once. `force` sends it now for the shift just ended, claiming nothing.
 */
async function run({ now = new Date(), force = false } = {}) {
  const s = await ProductionSettings.findOneAndUpdate({ key: 'production' }, { $setOnInsert: { key: 'production' } }, { upsert: true, new: true }).lean();
  const h = s.shiftHandover || {};
  const { minutesLeft } = require('./shiftEndNudge');
  const cur = minutesLeft(now);
  const into = SHIFT_HOURS * 60 - cur.left; // minutes since the running shift began
  const ended = previousShift(cur);
  const tag = `${ended.dateKey}:${ended.shift}`;
  if (!force) {
    if (!h.enabled) return { sent: false, why: 'off' };
    if (into > (h.withinMinutes || 60)) return { sent: false, why: 'not now', tag };
    const claimed = await ProductionSettings.findOneAndUpdate({ key: 'production', 'shiftHandover.lastSent': { $ne: tag } }, { $set: { 'shiftHandover.lastSent': tag } }).lean();
    if (!claimed) return { sent: false, why: 'already sent', tag };
  }
  const n = await note(ended);
  const delivery = await deliver(h.phones || [], n.text, tag);
  return { sent: true, tag, text: n.text, by: n.by, delivery };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.SHIFT_HANDOVER === 'off') return null;
  timer = setInterval(() => { run().catch((err) => console.error('[shift-handover] failed:', err?.message)); }, EVERY_MS);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { run, start, stop, note, figures, previousShift, watchByRule, currentShift };
