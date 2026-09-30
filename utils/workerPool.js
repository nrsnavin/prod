'use strict';
// ══════════════════════════════════════════════════════════════════
//  CPU WORK OFF THE REQUEST THREAD
//
//  Node serves every request on one JavaScript thread. That is ideal for
//  this API's usual work — waiting on MongoDB — and poor for the few
//  things that are pure computation: rendering a 19-page shift sheet,
//  verifying a legacy bcrypt hash. While one of those runs, every other
//  request in the process waits behind it, whoever it belongs to.
//
//  This is a small fixed pool of worker threads that run named jobs
//  from utils/workers/jobs.js. Only plain data crosses the boundary
//  (structured clone), which is why the jobs are the PURE parts — the
//  PDF builders take a plain object and return bytes; nothing in a job
//  touches the database or the request.
//
//  ── Why not a queue service ───────────────────────────────────────
//  The work is milliseconds to a couple of seconds, it belongs to a
//  request that is waiting for it, and losing it on a restart costs a
//  retry, not data. A thread pool is the right size of answer; a broker
//  would add a network hop and an operational dependency for nothing.
//
//  ── Failure ───────────────────────────────────────────────────────
//  A job that throws rejects its promise with the job's own message. A
//  worker that dies or exceeds the timeout is terminated and replaced,
//  and only the job it was running fails. If a worker cannot be started
//  at all, runJob rejects with code WORKER_UNAVAILABLE so a caller that
//  has an in-thread fallback can use it rather than fail the request.
// ══════════════════════════════════════════════════════════════════

const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');

const RUNNER = path.join(__dirname, 'workers', 'jobRunner.js');
const DEFAULT_TIMEOUT_MS = 60_000;

const cores = typeof os.availableParallelism === 'function'
  ? os.availableParallelism()
  : os.cpus().length;

/**
 * Small on purpose. The pool is for bursts of CPU work alongside an
 * I/O-bound server, and under cluster mode every process has its own.
 */
const POOL_SIZE = Math.max(
  1,
  Number(process.env.WORKER_POOL_SIZE) || Math.min(2, Math.max(1, cores - 1))
);

class WorkerUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'WORKER_UNAVAILABLE';
  }
}

let seq = 0;
const idle = [];
const all = new Set();
const queue = [];

function spawn() {
  const w = new Worker(RUNNER);
  w.current = null;
  w.unref();
  w.on('message', (msg) => {
    const job = w.current;
    if (!job || msg.id !== job.id) return;
    clearTimeout(job.timer);
    w.current = null;
    w.unref();
    if (msg.ok) job.resolve(revive(msg.result));
    else {
      const err = new Error(msg.error?.message || 'Worker job failed');
      if (msg.error?.code) err.code = msg.error.code;
      job.reject(err);
    }
    release(w);
  });
  w.on('error', (err) => retire(w, err));
  w.on('exit', (code) => {
    if (all.has(w)) retire(w, new Error(`Worker exited with code ${code}`));
  });
  all.add(w);
  return w;
}

function retire(w, err) {
  if (!all.has(w)) return;
  all.delete(w);
  const i = idle.indexOf(w);
  if (i !== -1) idle.splice(i, 1);
  const job = w.current;
  w.current = null;
  if (job) {
    clearTimeout(job.timer);
    job.reject(err);
  }
  w.terminate().catch(() => {});
  pump();
}

function release(w) {
  if (!all.has(w)) return;
  idle.push(w);
  pump();
}

/** A Buffer comes back from a worker as a plain Uint8Array. */
function revive(result) {
  if (result instanceof Uint8Array && !Buffer.isBuffer(result)) {
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  }
  return result;
}

function pump() {
  while (queue.length) {
    let w = idle.pop();
    if (!w && all.size < POOL_SIZE) {
      try {
        w = spawn();
      } catch (err) {
        const job = queue.shift();
        job.reject(new WorkerUnavailableError(err.message));
        continue;
      }
    }
    if (!w) return;
    const job = queue.shift();
    w.current = job;
    w.ref();
    job.timer = setTimeout(() => {
      retire(w, Object.assign(new Error(`Worker job "${job.name}" timed out after ${job.timeoutMs} ms`), { code: 'WORKER_TIMEOUT' }));
    }, job.timeoutMs);
    job.timer.unref?.();
    try {
      w.postMessage({ id: job.id, name: job.name, args: job.args });
    } catch (err) {
      // An argument that cannot be cloned. The job is at fault, not the
      // worker, so the worker goes back to the pool.
      clearTimeout(job.timer);
      w.current = null;
      w.unref();
      job.reject(err);
      idle.push(w);
    }
  }
}

/**
 * Run a named job from utils/workers/jobs.js on a worker thread.
 *
 * @param {string} name
 * @param {any[]} [args]   plain data only — it is structured-cloned
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<any>}
 */
function runJob(name, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ id: ++seq, name, args, timeoutMs, resolve, reject, timer: null });
    pump();
  });
}

/** Stop every worker. For tests and shutdown. */
async function closePool() {
  const workers = [...all];
  all.clear();
  idle.length = 0;
  for (const job of queue.splice(0)) job.reject(new WorkerUnavailableError('Pool closed'));
  await Promise.all(workers.map((w) => {
    if (w.current) {
      clearTimeout(w.current.timer);
      w.current.reject(new WorkerUnavailableError('Pool closed'));
    }
    return w.terminate().catch(() => {});
  }));
}

function poolStats() {
  return { size: POOL_SIZE, live: all.size, idle: idle.length, queued: queue.length };
}

module.exports = { runJob, closePool, poolStats, WorkerUnavailableError, POOL_SIZE };
