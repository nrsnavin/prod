'use strict';
// The jobs a worker thread may run. Every one is PURE: plain data in,
// plain data out, no database, no request, no module-level state that
// the main thread would expect to see change.

module.exports = {
  /**
   * Verify a password against a LEGACY bcrypt hash.
   *
   * bcryptjs is pure JavaScript, and its "async" API chains its work
   * through process.nextTick — which runs before the event loop can
   * service anything else, so twenty concurrent compares measured as one
   * continuous 1.6 s stall of the request thread. The synchronous
   * version on a worker thread stalls nothing.
   */
  'password.bcryptCompare': (plain, hash) => require('bcryptjs').compareSync(plain, hash),

  /**
   * Render a PDF by name (utils/workers/pdfRenderers.js). The arguments
   * arrive already normalised by utils/cloneable.js.
   */
  'pdf.render': (name, args) => require('./pdfRenderers').render(name, args),

  /** Test-only: proves a job ran off the main thread, and how failures travel. */
  'pool.selfTest': (mode, value) => {
    const { isMainThread, threadId } = require('node:worker_threads');
    if (mode === 'throw') throw Object.assign(new Error(value || 'job failed'), { code: 'SELF_TEST' });
    if (mode === 'spin') { const end = Date.now() + Number(value || 0); while (Date.now() < end) { /* busy */ } }
    if (mode === 'crash') process.exit(3);
    if (mode === 'bytes') return Buffer.from(String(value || ''));
    return { isMainThread, threadId, value };
  },
};
