'use strict';
// ══════════════════════════════════════════════════════════════════
//  BEFORE THE SHIFT ENDS: THE LOOMS STILL TO ENTER
//
//  `minutesBefore` the shift ends (day 08:00–20:00, night 20:00–08:00,
//  factory time), a WhatsApp message names the running looms whose
//  production is not entered yet, so the supervisor enters them while
//  the operators are still there to ask. Once a shift: the shift is
//  claimed on the settings row before anything is sent, so two server
//  processes never both send it. Nothing is sent when every loom is in.
//
//  To the numbers in the production settings; with none there, to the
//  recipients the notification settings give this event. Through the
//  notification log either way, dry-run until WhatsApp is set up.
//  Off until an admin turns it on (ProductionSettings.shiftEndNudge).
// ══════════════════════════════════════════════════════════════════

const ProductionSettings = require('../models/ProductionSettings');
const { settingsDoc } = require('../utils/settingsDoc');
const { currentShift } = require('./machineLoading');

const EVERY_MS = 5 * 60_000;
const FACTORY_TZ = process.env.FACTORY_TZ || 'Asia/Kolkata';
const ENDS_AT = { DAY: 20, NIGHT: 8 };

/** Minutes from `now` to the end of the shift running at `now`, factory time. */
function minutesLeft(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: FACTORY_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, Number(p.value)])
  );
  const cur = currentShift(now);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  const end = ENDS_AT[cur.shift] * 60;
  return { ...cur, left: (end - minuteOfDay + 24 * 60) % (24 * 60) || 24 * 60 };
}

const endsWords = (shift) => (shift === 'DAY' ? '8:00 PM' : '8:00 AM');

/** The message, or null when every loom is entered. */
async function message({ dateKey, shift }) {
  const { shiftState } = require('./floorEntry');
  const state = await shiftState({ dateKey, shift });
  const toEnter = state.machines.filter((m) => m.entry === 'ready' || m.entry === 'unplanned');
  if (!toEnter.length) return null;
  const names = toEnter.map((m) => m.ID);
  const shown = names.length > 25 ? `${names.slice(0, 25).join(', ')} and ${names.length - 25} more` : names.join(', ');
  return {
    text: [
      `⏰ *${shift === 'DAY' ? 'Day' : 'Night'} shift ends at ${endsWords(shift)}* — ${toEnter.length} loom${toEnter.length === 1 ? '' : 's'} not entered yet:`,
      shown,
      `${state.counts.entered} of ${state.counts.entered + state.counts.toEnter} entered so far. Enter them on the floor tablet while the operators are here.`,
    ].join('\n'),
    looms: names,
  };
}

/** Send `body` to the setting's numbers, or through the event's recipients. */
async function deliver(phones, body, tag) {
  if (phones.length) {
    const { sendWhatsApp } = require('../utils/whatsapp');
    const Notification = require('../models/Notification');
    const out = [];
    for (const to of phones) {
      const r = await sendWhatsApp(to, body);
      out.push(r);
      await Notification.create({
        event: 'shiftEndNudge', recipient: to, channel: 'whatsapp', body,
        status: r.sent ? 'sent' : r.dryRun ? 'dry_run' : 'error',
        reason: r.error || (r.dryRun ? 'provider not configured' : `shift ${tag}`), providerId: r.providerId,
      }).catch(() => null);
    }
    return { to: phones, sent: out.filter((r) => r.sent).length, dryRun: out.some((r) => r.dryRun) };
  }
  const { notify } = require('../utils/notify');
  // Once a shift is the claim's doing (run below), not the notifier's throttle.
  return notify('shiftEndNudge', { body });
}

/**
 * Once a tick: is the running shift within `minutesBefore` of its end,
 * not nudged yet, with looms to enter? Then claim it and send. `force`
 * (the settings' "Send now") sends for the running shift whatever the
 * time and whether it was sent, and claims nothing.
 */
async function run({ now = new Date(), force = false } = {}) {
  const s = await settingsDoc(ProductionSettings, 'production');
  const n = s.shiftEndNudge || {};
  const due = minutesLeft(now);
  if (!force) {
    if (!n.enabled) return { sent: false, why: 'off' };
    if (due.left > (n.minutesBefore || 30)) return { sent: false, why: 'not yet', ...due };
  }
  const tag = `${due.dateKey}:${due.shift}`;
  if (!force) {
    // Claimed first: whoever loses this is a second process, and stops.
    const claimed = await ProductionSettings.findOneAndUpdate(
      { key: 'production', 'shiftEndNudge.lastSent': { $ne: tag } },
      { $set: { 'shiftEndNudge.lastSent': tag } },
    ).lean();
    if (!claimed) return { sent: false, why: 'already sent', tag };
  }
  const msg = await message(due);
  if (!msg) return { sent: false, why: 'every loom is entered', tag };
  const delivery = await deliver(n.phones || [], msg.text, tag);
  return { sent: true, tag, looms: msg.looms, text: msg.text, delivery };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.SHIFT_END_NUDGE === 'off') return null;
  timer = setInterval(() => { run().catch((err) => console.error('[shift-end-nudge] failed:', err?.message)); }, EVERY_MS);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { run, start, stop, minutesLeft, message };
