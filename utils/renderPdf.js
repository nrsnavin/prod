'use strict';
// ══════════════════════════════════════════════════════════════════
//  EVERY PDF IS RENDERED OFF THE REQUEST THREAD
//
//  pdfkit is synchronous JavaScript. A 200-machine shift sheet runs to
//  nineteen pages, and while it lays them out every other request in the
//  process waits — the supervisor saving production, the dashboard poll,
//  someone else's login. The renderers are already pure (plain data in,
//  bytes out), which is exactly what a worker thread can take.
//
//      const pdf = await renderPdf('mrp', data);
//
//  Arguments go through toCloneable first, so a Mongoose document or an
//  ObjectId reaches the renderer in the shape it would have had here.
//
//  ── Kill switch ───────────────────────────────────────────────────
//  PDF_IN_THREAD=1 renders on the request thread, as before, without a
//  deploy. The same happens automatically if no worker can be started.
// ══════════════════════════════════════════════════════════════════

const { runJob } = require('./workerPool');
const { toCloneable } = require('./cloneable');
const { RENDERERS, render } = require('./workers/pdfRenderers');

const TIMEOUT_MS = 60_000;

const inThread = () => /^(1|true|yes)$/i.test(String(process.env.PDF_IN_THREAD || ''));

/**
 * @param {keyof typeof RENDERERS} name
 * @param {...any} args  what the renderer takes, exactly as before
 * @returns {Promise<Buffer>}
 */
async function renderPdf(name, ...args) {
  if (!RENDERERS[name]) throw new Error(`Unknown PDF "${name}"`);
  const payload = args.map((a) => toCloneable(a));
  if (inThread()) return render(name, payload);
  try {
    return await runJob('pdf.render', [name, payload], { timeoutMs: TIMEOUT_MS });
  } catch (err) {
    if (err?.code === 'WORKER_UNAVAILABLE') return render(name, payload);
    throw err;
  }
}

module.exports = { renderPdf, PDF_NAMES: Object.keys(RENDERERS) };
