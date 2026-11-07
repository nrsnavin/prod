'use strict';
// ══════════════════════════════════════════════════════════════════
//  A GOVERNMENT NOTICE'S REPLY DEADLINE, COMING UP
//
//  7, 3 and 1 day before the date to reply, on the day, and once when it
//  has passed: a WhatsApp message to the notification recipients for
//  `statutoryNotice`. Each is claimed on the notice before it is sent
//  (`reminded`), so two server processes never both send it. A notice
//  replied or closed is never reminded.
// ══════════════════════════════════════════════════════════════════

const StatutoryNotice = require('../models/StatutoryNotice');

const EVERY_MS = 60 * 60_000;
const STEPS = [7, 3, 1, 0];
const DAY = 86_400_000;
const istDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const left = (replyBy, now) => Math.round((Date.parse(istDay(replyBy)) - Date.parse(istDay(now))) / DAY);
const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const when = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Which reminder is due for `n` now, if any: "7", "3", "1", "0", "overdue". */
function dueKey(n, now = new Date()) {
  if (n.status !== 'open' || !n.replyBy) return null;
  const d = left(n.replyBy, now);
  if (d < 0) return 'overdue';
  // The step whose window holds today: 7 for 4–7 days left, 3 for 2–3,
  // then 1 and 0. A notice entered 2 days out starts at "3", not "7".
  const step = STEPS.find((s) => d <= s && (STEPS[STEPS.indexOf(s) + 1] ?? -1) < d);
  return step == null ? null : String(step);
}

function message(n, key) {
  const what = [n.form, n.subject].filter(Boolean).join(' — ') || 'Government notice';
  const head = key === 'overdue' ? `⚠️ *Reply date passed* (${when(n.replyBy)})`
    : key === '0' ? `⏰ *Reply due today*`
      : `📌 *Reply due in ${key} day${key === '1' ? '' : 's'}* (${when(n.replyBy)})`;
  return [
    `${head}: ${what}`,
    [n.reference && `Ref ${n.reference}`, n.periodText && `period ${n.periodText}`, n.amount ? `amount ${money(n.amount)}` : ''].filter(Boolean).join(' · '),
    n.replyByAssumed ? 'The notice printed no date; this one is the legal limit — confirm it on the portal.' : '',
    n.documents?.length ? `Needs: ${n.documents.slice(0, 3).join('; ')}` : '',
    n.owner ? `With ${n.owner}.` : '',
  ].filter(Boolean).join('\n');
}

async function run({ now = new Date() } = {}) {
  const open = await StatutoryNotice.find({ status: 'open', replyBy: { $ne: null } }).lean();
  const { notify } = require('../utils/notify');
  const sent = [];
  for (const n of open) {
    const key = dueKey(n, now);
    if (!key || (n.reminded || []).includes(key)) continue;
    const claimed = await StatutoryNotice.updateOne({ _id: n._id, status: 'open', reminded: { $ne: key } }, { $push: { reminded: key } });
    if (!claimed.modifiedCount) continue;
    const body = message(n, key);
    await notify('statutoryNotice', { body, _entity: { type: 'StatutoryNotice', id: n._id } }).catch(() => null);
    sent.push({ id: String(n._id), key, body });
  }
  return { sent };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.NOTICE_REMINDERS === 'off') return null;
  timer = setInterval(() => { run().catch((err) => console.error('[notice-reminders] failed:', err?.message)); }, EVERY_MS);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { run, start, stop, dueKey, message };
