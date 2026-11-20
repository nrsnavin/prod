'use strict';
// ─────────────────────────────────────────────────────────────────
//  WHICH DATABASE IS A DEMO SEED ABOUT TO WRITE INTO
//
//  The demo scripts write test records — and one of them deletes
//  first. The connection string comes from an environment variable
//  that whatever shell you are standing in may already have set to the
//  live database. So each says out loud which database it is about to
//  touch, and refuses one that looks live unless the name is said back
//  to it (DEMO_SEED_CONFIRM=<database>).
//
//  Shared by scripts/seedDemoCustomer.js and scripts/seed-demo-workers.js:
//  the second had no such check, and wrote its logins wherever MONGO_URL
//  pointed.
// ─────────────────────────────────────────────────────────────────

const LIVE_HINTS = [/prod/i, /live/i, /mongodb\+srv:/i, /atlas/i];

function dbNameOf(uri) {
  // Everything after the last "/" and before any "?" — good enough for
  // both mongodb:// and mongodb+srv:// forms.
  const withoutQuery = String(uri).split('?')[0];
  return withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1) || '(default)';
}

/**
 * @param {string} uri
 * @param {object}   o
 * @param {(...a) => void} o.log
 * @param {string[]} o.what     what the script does there, one line each
 * @param {string}   o.command  how it is run, for the "re-run with" line
 * @returns {string} the database's name
 */
function assertSafeTarget(uri, { log, what, command }) {
  const name = dbNameOf(uri);
  const looksLive = LIVE_HINTS.some((re) => re.test(uri));
  const confirmed = process.env.DEMO_SEED_CONFIRM === name;

  log('target database:', name);
  if (!looksLive || confirmed) return name;

  log('');
  log('REFUSING TO RUN.');
  log(`  "${String(uri).replace(/\/\/[^@]*@/, '//<credentials>@')}" looks like a live database.`);
  for (const line of what) log(`  ${line}`);
  log('');
  log('  If that is really what you want, re-run with:');
  log(`      DEMO_SEED_CONFIRM=${name} ${command}`);
  log('');
  throw new Error(`refusing to seed demo data into "${name}"`);
}

module.exports = { LIVE_HINTS, dbNameOf, assertSafeTarget };
