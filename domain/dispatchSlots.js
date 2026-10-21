'use strict';
// ══════════════════════════════════════════════════════════════════
//  DELIVERY URGENCY — WHEN SOMETHING HAS TO LEAVE
//
//  Marketing (or admin) answers "when does the customer need it?" with
//  one of four slots. Each becomes an absolute deadline the moment it is
//  set, so the queue can be sorted on one number and "tomorrow" said on
//  Monday is still Tuesday when it is read on Tuesday.
//
//    today_morning  by 1 PM today
//    today_evening  by 7 PM today
//    today          by the end of today
//    tomorrow       by the end of tomorrow
//
//  Times are the plant's (India, UTC+5:30, no daylight saving), not the
//  server's: a server in another zone must not move the cut-offs.
// ══════════════════════════════════════════════════════════════════

const URGENCIES = ['today_morning', 'today_evening', 'today', 'tomorrow'];

const URGENCY_LABELS = Object.freeze({
  today_morning: 'Today morning',
  today_evening: 'Today evening',
  today:         'Today',
  tomorrow:      'Tomorrow',
});

/** Minutes east of UTC. Overridable for a plant elsewhere. */
const offsetMinutes = () => {
  const n = Number(process.env.DISPATCH_TZ_OFFSET_MIN);
  return Number.isFinite(n) ? n : 330;
};

// [days from today, hour, minute, second, ms] in plant time.
const SLOT_DEADLINE = Object.freeze({
  today_morning: [0, 13, 0, 0, 0],
  today_evening: [0, 19, 0, 0, 0],
  today:         [0, 23, 59, 59, 999],
  tomorrow:      [1, 23, 59, 59, 999],
});

/**
 * The deadline for a slot chosen at `from`, as a Date.
 * @param {string} urgency one of URGENCIES
 * @param {Date} [from] when it was chosen (now by default)
 */
function dueAtFor(urgency, from = new Date()) {
  const slot = SLOT_DEADLINE[urgency];
  if (!slot) return null;
  const off = offsetMinutes() * 60_000;
  const local = new Date(from.getTime() + off); // plant wall-clock, read through UTC getters
  const [days, h, m, sec, ms] = slot;
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, h, m, sec, ms);
  return new Date(wall - off);
}

/** Lower is more urgent — the tie-break between equal deadlines. */
const urgencyRank = (u) => {
  const i = URGENCIES.indexOf(u);
  return i === -1 ? URGENCIES.length : i;
};

module.exports = { URGENCIES, URGENCY_LABELS, dueAtFor, urgencyRank, offsetMinutes };
