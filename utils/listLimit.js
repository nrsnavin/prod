'use strict';

// ══════════════════════════════════════════════════════════════════
//  LISTS THAT CAN'T GROW WITHOUT END
//
//  A few lists return a whole collection that only ever grows —
//  feedback, machine issues, service bills, announcements — and two
//  reports take any date range at all. Each is small today. Each would,
//  in a few years or with one wide range, load tens of thousands of
//  documents into one process's memory to answer one request.
//
//  capped(query, res, max): runs the query for at most `max` documents
//  (newest first, as each route already sorts). When there were more,
//  it sets `X-Result-Capped: <max>` on the response, logs it, and
//  returns `capped: true` so the route can tell the client. Today's
//  lists are far below the default ceiling of 1,000, so nothing anyone
//  sees changes until one of them actually grows that large.
//
//  rangeProblem(start, end, maxDays): why a date range is too wide to
//  ask for in one go, or null when it is fine.
// ══════════════════════════════════════════════════════════════════

const LIST_CEILING = 1000;
const DAY_MS = 86_400_000;

async function capped(query, res, max = LIST_CEILING) {
  const rows = await query.limit(max + 1);
  if (rows.length <= max) return { rows, capped: false };
  res?.set?.('X-Result-Capped', String(max));
  console.warn(`[list] ${res?.req?.originalUrl ?? 'a list'} capped at ${max} rows`);
  return { rows: rows.slice(0, max), capped: true };
}

function rangeProblem(start, end, maxDays = 370) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null; // the route's own parsing answers this
  if ((b - a) / DAY_MS > maxDays) {
    return `Pick a range of at most ${maxDays} days; ask for longer periods a year at a time.`;
  }
  return null;
}

module.exports = { capped, rangeProblem, LIST_CEILING };
