'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE PROCESS PER CORE, SUPERVISED
//
//  The API ran as a single Node process: one JavaScript thread, one
//  core, whatever the machine. It is stateless enough to run as several
//  — JWT in a cookie, no server session, no mutable module state — and
//  the two things that were not (in-memory rate-limit counters, CPU
//  work on the request thread) have been moved out. So the primary here
//  forks N identical workers that share the listening socket.
//
//  ── How many ──────────────────────────────────────────────────────
//  WEB_CONCURRENCY decides. Unset: one per core up to four in
//  production, one everywhere else. WEB_CONCURRENCY=1 is the old single
//  process exactly — no primary at all — and is the rollback.
//
//  ── A worker that dies ────────────────────────────────────────────
//  is replaced at once, and only its own in-flight requests are lost —
//  where before, one uncaught exception took the whole API down until
//  systemd restarted it. A worker that keeps dying is a configuration
//  problem, not bad luck: past `maxRestarts` in `windowMs` the primary
//  stops everything and exits non-zero, so systemd sees a failure
//  instead of a process quietly forking forever.
//
//  ── Shutdown ──────────────────────────────────────────────────────
//  SIGTERM (what systemd sends) is passed to every worker, each of which
//  already drains its in-flight requests before exiting; the primary
//  exits once they have all gone, or forces it after a timeout shorter
//  than systemd's TimeoutStopSec.
// ══════════════════════════════════════════════════════════════════

const os = require('node:os');

const cores = () =>
  typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

/** How many workers to run. Pure, so it can be tested without forking. */
function workerCount(env = process.env, available = cores()) {
  const raw = env.WEB_CONCURRENCY;
  if (raw !== undefined && String(raw).trim() !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.warn(`[cluster] WEB_CONCURRENCY="${raw}" is not a positive whole number — running one process`);
      return 1;
    }
    return Math.min(n, 32);
  }
  if (env.NODE_ENV === 'PRODUCTION') return Math.max(1, Math.min(available, 4));
  return 1;
}

/**
 * Run the supervising primary.
 *
 * @param {object} opts
 * @param {number} opts.workers
 * @param {object} [opts.cluster]  node:cluster, or a stand-in in tests
 * @param {object} [opts.proc]     process, or a stand-in in tests
 */
function runPrimary({
  workers,
  cluster = require('node:cluster'),
  proc = process,
  maxRestarts = 10,
  windowMs = 60_000,
  shutdownTimeoutMs = 15_000,
  log = console,
}) {
  let stopping = false;
  let exitCode = 0;
  const restarts = [];

  const live = () => Object.values(cluster.workers || {}).filter(Boolean);

  const stopAll = (code, why) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    log.log(`[cluster] ${why} — stopping ${live().length} worker(s)`);
    for (const w of live()) w.process.kill('SIGTERM');
    if (live().length === 0) proc.exit(exitCode);
    const t = setTimeout(() => {
      log.error(`[cluster] workers did not stop within ${shutdownTimeoutMs} ms — forcing exit`);
      proc.exit(exitCode);
    }, shutdownTimeoutMs);
    t.unref?.();
  };

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      if (live().length === 0) proc.exit(exitCode);
      return;
    }
    const now = Date.now();
    restarts.push(now);
    while (restarts.length && now - restarts[0] > windowMs) restarts.shift();
    log.error(`[cluster] worker ${worker.process.pid} exited (${signal || `code ${code}`}) — replacing it`);
    if (restarts.length > maxRestarts) {
      stopAll(1, `${restarts.length} worker restarts in ${Math.round(windowMs / 1000)} s`);
      return;
    }
    cluster.fork();
  });

  proc.on('SIGTERM', () => stopAll(0, 'SIGTERM'));
  proc.on('SIGINT', () => stopAll(0, 'SIGINT'));

  log.log(`[cluster] primary ${proc.pid} starting ${workers} workers`);
  for (let i = 0; i < workers; i++) cluster.fork();

  return { stopAll, restarts };
}

module.exports = { workerCount, runPrimary };
