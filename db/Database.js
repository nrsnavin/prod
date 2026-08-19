const mongoose = require("mongoose");

// BUG FIX: The original code did:
//   db = await mongoose.connect(...).then(data => { console.log(...) })
// .then() returns undefined (the callback has no return value), so `db`
// was always undefined. Also there was no error handling, so a failed
// connection would surface only as mysterious downstream query errors.

// A replica-set failover (Atlas elects a new primary in ~10–30s) makes
// connections fail for the duration. The previous version called
// process.exit(1) on the FIRST failure, which turned a transient election
// into a real outage: systemd restarts the process, it fails again, and
// after StartLimitBurst attempts systemd gives up entirely — leaving the
// service dead until someone runs `systemctl reset-failed` by hand.
//
// So: retry with backoff for long enough to outlast an election, and only
// give up — loudly, with a non-zero exit so the supervisor notices — if
// the database is still unreachable after that. Once mongoose has
// connected once its own driver handles reconnection; this loop only
// covers the cold-start window.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Does this URI name a database in its path?
 *
 * `mongodb+srv://host/mydb?opts` does. `mongodb+srv://host/?opts` and
 * `mongodb+srv://host` do not, and both connect to `test` without
 * comment. Exported so a test can hold the distinction.
 */
function databaseNamedIn(uri) {
  const s = String(uri || '');
  const afterScheme = s.slice(s.indexOf('://') + 3);
  const slash = afterScheme.indexOf('/');
  if (slash === -1) return false;                     // no path at all
  const path = afterScheme.slice(slash + 1).split('?')[0];
  return path.length > 0;
}

/**
 * @param {object} [opts]
 * @param {number[]} [opts.retryDelays] override the backoff schedule (tests)
 * @param {() => any} [opts.onGiveUp]   what to do when out of attempts;
 *   defaults to exiting non-zero so the process supervisor restarts us.
 */
const connectDatabase = async ({
  retryDelays = RETRY_DELAYS_MS,
  onGiveUp = () => process.exit(1),
} = {}) => {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await mongoose.connect(process.env.MONGO_URL, {});
      // ── Say the DATABASE, not only the host ──────────────────────
      //  A MongoDB URI carries its database in the PATH, so a URI that
      //  ends `…/?appName=X` names none and silently connects to one
      //  called `test`. That is not an error and nothing reports it —
      //  the boot line said "connected" either way, and the first
      //  symptom was records that were plainly on screen coming back
      //  as "does not exist" weeks later.
      console.log(
        `mongod connected with server: ${data.connection.host}` +
        ` — database: ${data.connection.name}`
      );
      if (!databaseNamedIn(process.env.MONGO_URL)) {
        console.warn(
          `[db] MONGO_URL names no database, so this process is using ` +
          `"${data.connection.name}" — MongoDB's default. If that is not ` +
          `deliberate, put the name in the PATH: mongodb+srv://host/<database>?options`
        );
      }
      return data;
    } catch (err) {
      if (attempt >= retryDelays.length) {
        console.error(
          `MongoDB unreachable after ${attempt + 1} attempts: ${err.message}`
        );
        return onGiveUp();
      }
      const wait = retryDelays[attempt];
      console.warn(
        `MongoDB connection failed (attempt ${attempt + 1}): ${err.message} — retrying in ${wait}ms`
      );
      await sleep(wait);
    }
  }
};

// mongoose.connection.readyState → 0 disconnected, 1 connected,
// 2 connecting, 3 disconnecting.
const READY_STATES = ["disconnected", "connected", "connecting", "disconnecting"];

/**
 * Whether the app can currently talk to MongoDB. Lets a monitor tell
 * "the process is up" apart from "the process is up but every request
 * that touches data will fail" — which look identical from outside.
 */
function databaseHealth() {
  const state = mongoose.connection.readyState;
  return {
    ok: state === 1,
    state: READY_STATES[state] ?? String(state),
  };
}

module.exports = { connectDatabase, databaseHealth, databaseNamedIn, RETRY_DELAYS_MS };
