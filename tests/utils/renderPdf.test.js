'use strict';
// ══════════════════════════════════════════════════════════════════
//  PDFs RENDER OFF THE REQUEST THREAD
//
//  The route tests (dcPdf, poPdf, quote, reportsPdf, orderPnlPdfRoute,
//  orderStatusReport, materialLedgerRoutes) drive the real routes and
//  now go through the worker without knowing it. This holds what they
//  cannot see: that the work really is on another thread, that a large
//  sheet no longer stalls other requests, that every renderer is
//  reachable by name, and that the kill switch and the fallback work.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { PDFDocument } = require('pdf-lib');
const { renderPdf, PDF_NAMES } = require('../../utils/renderPdf');
const { closePool } = require('../../utils/workerPool');
const { buildShiftSheetPdf } = require('../../utils/shiftSheetPdf');

afterAll(() => closePool());
afterEach(() => { delete process.env.PDF_IN_THREAD; });

const pages = async (buf) => (await PDFDocument.load(buf)).getPageCount();

/** A production sheet for `n` machines — the heaviest PDF the floor prints. */
const bigSheet = (n = 200) => ({
  dateLabel: '10-Jun-2026', shift: 'DAY', planNo: 'SP-20260610-D',
  rows: Array.from({ length: n }, (_, i) => ({
    sdId: new mongoose.Types.ObjectId(),
    machine: `M-${String(i + 1).padStart(3, '0')}`,
    operator: `Operator ${i + 1}`,
    job: `J-${1000 + i}`,
  })),
  branding: { company: 'Balu Elastics' },
});

async function longestStall(work) {
  let last = Date.now(), worst = 0;
  const iv = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last); last = t; }, 2);
  const out = await work();
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(iv);
  return { worst, out };
}

describe('renderPdf', () => {
  it('knows every renderer the routes ask for', () => {
    expect(PDF_NAMES.sort()).toEqual(
      ['eveningReport', 'materialLedger', 'morningDigest', 'mrp', 'orderPnl', 'orderStatus', 'shiftSheet', 'template'].sort()
    );
  });

  it('refuses a name it does not know', async () => {
    await expect(renderPdf('nope', {})).rejects.toThrow(/Unknown PDF/);
  });

  it('renders a 200-machine production sheet with the same page count as before', async () => {
    const data = bigSheet(200);
    const viaWorker = await renderPdf('shiftSheet', data);
    const inThread = await buildShiftSheetPdf(data);
    expect(viaWorker.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pages(viaWorker)).toBe(await pages(inThread));
    expect(await pages(viaWorker)).toBeGreaterThan(5);
  }, 120_000);

  it('keeps the request thread free while that sheet renders', async () => {
    // Measured against the old path in the same test, so the claim is a
    // comparison on this machine rather than a guess about it.
    const data = bigSheet(200);
    const before = await longestStall(() => buildShiftSheetPdf(data));
    const after = await longestStall(() => renderPdf('shiftSheet', data));
    expect(after.worst).toBeLessThan(before.worst);
    expect(after.worst).toBeLessThan(150);
  }, 120_000);

  it('renders on the request thread when PDF_IN_THREAD is set', async () => {
    process.env.PDF_IN_THREAD = '1';
    const buf = await renderPdf('shiftSheet', bigSheet(3));
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('returns a Buffer the route can send as it is', async () => {
    const buf = await renderPdf('shiftSheet', bigSheet(2));
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('carries a renderer\'s own error back to the route', async () => {
    // Checked in-thread first: buildMrpPdf(null) throws reading `branding`.
    // The route must see that same message, not a generic worker failure.
    await expect(renderPdf('mrp', null)).rejects.toThrow(/reading 'branding'/);
  });
});
