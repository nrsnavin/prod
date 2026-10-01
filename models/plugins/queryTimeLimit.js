'use strict';

// ══════════════════════════════════════════════════════════════════
//  NO READ RUNS FOREVER
//
//  Nothing stopped a query that ran away — a report over years of
//  shifts, an aggregation missing its index — from running on the
//  database long after the person who asked had given up (the web app
//  stops waiting at 20 s), holding a connection and competing with
//  every other request the whole time.
//
//  This plugin gives every READ a server-side time limit: find, findOne,
//  countDocuments, distinct and aggregate. MongoDB stops the operation
//  at the limit and the request answers 503 (middleware/error.js).
//
//  Reads only, on purpose. A write stopped halfway — an updateMany that
//  changed some documents and not others — is worse than a slow one.
//
//  A query that sets its own maxTimeMS keeps it, so a known-heavy report
//  can ask for longer. Registered in app.js, so it applies to the server
//  and not to migrations or one-off scripts, which run without it.
//
//  Env: DB_QUERY_MAX_MS (default 30000; 0 turns the limit off).
// ══════════════════════════════════════════════════════════════════

const READS = ['find', 'findOne', 'countDocuments', 'distinct'];

function limitMs() {
  const raw = process.env.DB_QUERY_MAX_MS;
  if (raw === undefined || raw === '') return 30_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

module.exports = function queryTimeLimit(schema) {
  schema.pre(READS, function () {
    const ms = limitMs();
    if (ms > 0 && this.getOptions().maxTimeMS == null) this.maxTimeMS(ms);
  });

  schema.pre('aggregate', function () {
    const ms = limitMs();
    if (ms > 0 && this.options.maxTimeMS == null) this.options.maxTimeMS = ms;
  });
};

module.exports.limitMs = limitMs;
