'use strict';
// The worker side of utils/workerPool.js. Receives { id, name, args },
// runs the named job, posts back { id, ok, result } or { id, ok, error }.
// A worker runs one job at a time; the pool never sends a second until
// the first has answered.

const { parentPort } = require('node:worker_threads');
const jobs = require('./jobs');

parentPort.on('message', async ({ id, name, args }) => {
  try {
    const fn = jobs[name];
    if (typeof fn !== 'function') {
      throw Object.assign(new Error(`Unknown worker job "${name}"`), { code: 'UNKNOWN_JOB' });
    }
    const result = await fn(...(Array.isArray(args) ? args : []));
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      error: { message: err?.message || String(err), code: err?.code },
    });
  }
});
