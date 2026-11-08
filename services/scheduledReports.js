'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DAILY REPORTS, ON THE SERVER'S OWN CLOCK
//
//  The morning digest (with the anomaly alerts and health checks it
//  runs) and the evening report only ever ran when something outside
//  called /notify/cron/… with the shared secret — and nothing in the
//  deployment set that up. Now the server sends them itself:
//
//    morning digest   09:00 in India  (DIGEST_AT)
//    evening report   21:00 in India  (EVENING_REPORT_AT)
//
//  Each is sent once a day: the first process to claim the day's row in
//  ScheduledRun sends, others stand down — so two server processes, a
//  restart, or an old crontab still hitting the cron route never send
//  it twice. Started late (a restart at 10:15) it still goes, up to
//  three hours after its time; later than that the day is skipped
//  rather than sending a stale morning digest at teatime.
//
//  Who receives them, and whether at all, stays with the notification
//  settings (utils/notify.js). SCHEDULED_REPORTS=off turns the timer off.
// ══════════════════════════════════════════════════════════════════

const ScheduledRun = require('../models/ScheduledRun');
const factoryDay = require('../utils/factoryDay');

const EVERY_MS = 5 * 60_000;
const GRACE_MIN = 180;

/** "HH:MM" → minutes after midnight; the default when unreadable. */
function minutesOf(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

const JOBS = {
  morningDigest: { at: () => minutesOf(process.env.DIGEST_AT, 9 * 60), run: () => require('../api/notify').runDigest(false) },
  eveningReport: { at: () => minutesOf(process.env.EVENING_REPORT_AT, 21 * 60), run: () => require('../api/notify').runEveningReport(false) },
};

/** Minutes after midnight in India at `now`. */
function indiaMinutes(now) {
  return Math.floor((new Date(now).getTime() - factoryDay.dayStart(now).getTime()) / 60_000);
}

/** Take the day's run for `job`; false when someone already has. */
async function claim(job, day, trigger) {
  try {
    await ScheduledRun.create({ key: `${job}:${day}`, job, day, trigger });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

/** Run `job` for today if it has not run; records how it went. */
async function runOnce(job, { now = new Date(), trigger = 'timer' } = {}) {
  const spec = JOBS[job];
  if (!spec) throw new Error(`No scheduled job called ${job}`);
  const day = factoryDay.ymd(now);
  if (!(await claim(job, day, trigger))) return { ran: false, why: 'already sent today', day };
  try {
    const result = await spec.run();
    await ScheduledRun.updateOne({ key: `${job}:${day}` }, { $set: { ok: true } });
    return { ran: true, day, result };
  } catch (err) {
    await ScheduledRun.updateOne({ key: `${job}:${day}` }, { $set: { ok: false, error: String(err?.message || err).slice(0, 500) } });
    throw err;
  }
}

/** One tick: whatever is due now and not yet sent today. */
async function tick(now = new Date()) {
  const mins = indiaMinutes(now);
  const out = {};
  for (const [job, spec] of Object.entries(JOBS)) {
    const at = spec.at();
    if (mins < at || mins > at + GRACE_MIN) { out[job] = { ran: false, why: 'not now' }; continue; }
    try { out[job] = await runOnce(job, { now }); } catch (err) {
      console.error(`[scheduled-reports] ${job} failed: ${err?.message}`);
      out[job] = { ran: false, why: 'failed', error: err?.message };
    }
  }
  return out;
}

/** The last run of each job, for the settings page. */
async function status() {
  const rows = await ScheduledRun.find({ job: { $in: Object.keys(JOBS) } }).sort({ at: -1 }).limit(20).lean();
  const last = {};
  for (const r of rows) if (!last[r.job]) last[r.job] = { day: r.day, at: r.at, ok: r.ok, error: r.error, trigger: r.trigger };
  return Object.fromEntries(Object.entries(JOBS).map(([job, spec]) => {
    const at = spec.at();
    return [job, { at: `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`, last: last[job] || null }];
  }));
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test' || process.env.SCHEDULED_REPORTS === 'off') return null;
  timer = setInterval(() => { tick().catch((err) => console.error('[scheduled-reports] tick failed:', err?.message)); }, EVERY_MS);
  timer.unref?.();
  return timer;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { tick, runOnce, status, start, stop, minutesOf, indiaMinutes, JOBS };
