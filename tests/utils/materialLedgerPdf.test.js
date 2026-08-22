'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PRINTED STOCK LEDGER
//
//  A PDF cannot be asserted about the way a DOM can, so these tests
//  hold it to what can actually go wrong without anyone noticing:
//
//    • it throws on a shape the route can really produce (a period with
//      no movements, a material with no category, an unparseable date);
//    • a long ledger paginates instead of running off the page;
//    • the period label says something true for every combination of
//      open and closed ends — the one piece of text that distinguishes
//      two prints of the same material.
//
//  What the page LOOKS like was checked by rendering it and reading it,
//  which is how three defects were found that no assertion here would
//  have caught: a label colliding with its value, a details cell
//  overflowing into the next column, and a blank continuation page.
// ══════════════════════════════════════════════════════════════════

const { buildMaterialLedgerPdf, rangeLabel } = require('../../utils/materialLedgerPdf');

const row = (over = {}) => ({
  _id: 'r1',
  date: '2025-03-10T10:00:00.000Z',
  type: 'RECEIPT',
  label: 'Goods receipt',
  quantity: 100,
  direction: 1,
  signedQuantity: 100,
  balance: 100,
  reference: 'PO-77',
  referenceId: 'p1',
  referenceKind: 'purchaseOrder',
  lotNo: '',
  unitPrice: 0,
  remarks: '',
  ...over,
});

const ledger = (over = {}) => ({
  material: { _id: 'm1', name: 'Nylon 40D', category: 'Yarn', unit: 'kg' },
  range: { from: '2025-03-01T00:00:00.000Z', to: '2025-03-31T23:59:59.999Z' },
  opening: 0,
  closing: 60,
  stockNow: 60,
  totals: { received: 100, adjustedIn: 0, issued: 40, net: 60 },
  count: 2,
  rows: [
    row(),
    row({
      _id: 'r2',
      date: '2025-03-12T10:00:00.000Z',
      type: 'ORDER_APPROVAL',
      label: 'Order approval',
      quantity: 40,
      direction: -1,
      signedQuantity: -40,
      balance: 60,
      reference: 'Order #1042',
      referenceKind: 'order',
      referenceId: 'o1',
    }),
  ],
  ...over,
});

const isPdf = (buf) => {
  expect(Buffer.isBuffer(buf)).toBe(true);
  expect(buf.length).toBeGreaterThan(1000);
  expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
};

describe('rangeLabel', () => {
  it('names both ends when both are set', () => {
    expect(rangeLabel({ from: '2025-03-01', to: '2025-03-31' })).toMatch(/Mar.*—.*Mar/);
  });

  it('says onwards for an open top end', () => {
    expect(rangeLabel({ from: '2025-03-01', to: null })).toMatch(/onwards/i);
  });

  it('says up to for an open bottom end', () => {
    expect(rangeLabel({ from: null, to: '2025-03-31' })).toMatch(/^Up to/i);
  });

  it('does not print an empty range as a dash between nothings', () => {
    // The default view has no dates set at all. "— — —" would read as a
    // rendering fault rather than as the whole history.
    expect(rangeLabel({})).toBe('All movements to date');
  });
});

describe('buildMaterialLedgerPdf', () => {
  it('renders an ordinary period', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger()));
  });

  it('renders a period in which nothing moved', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger({ rows: [], count: 0, totals: { received: 0, adjustedIn: 0, issued: 0, net: 0 } })));
  });

  it('renders with no range set at all', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger({ range: { from: null, to: null } })));
  });

  it('renders when the closing balance differs from stock today', async () => {
    // Draws the alert strip, which is a different code path.
    isPdf(await buildMaterialLedgerPdf(ledger({ stockNow: 500 })));
  });

  it('paginates a long ledger rather than running off the page', async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      row({ _id: `r${i}`, balance: 100 + i })
    );
    const buf = await buildMaterialLedgerPdf(ledger({ rows, count: rows.length }));
    isPdf(buf);
    // More than one page object. A single-page buffer for 120 rows would
    // mean the rows were drawn on top of each other.
    const pages = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || [];
    expect(pages.length).toBeGreaterThan(1);
  });

  it('does not add a blank page for a ledger that fits on one', async () => {
    // The footer writes below the bottom margin. Without zeroing the
    // margin for that write, pdfkit treats it as overflow and spawns an
    // empty continuation page on every single print.
    const buf = await buildMaterialLedgerPdf(ledger());
    const pages = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || [];
    expect(pages.length).toBe(1);
  });

  it('survives a row that carries almost nothing', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger({
      rows: [{ _id: 'x', direction: 1, quantity: 1, balance: 1 }],
      count: 1,
    })));
  });

  it('survives a material with no category or unit', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger({
      material: { _id: 'm1', name: 'Unnamed' },
    })));
  });

  it('survives a date it cannot parse', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger({
      rows: [row({ date: 'not a date' })],
      count: 1,
    })));
  });

  it('survives a remark far longer than its column', async () => {
    // `lineBreak: false` stops the wrap but not the overflow — an
    // unclipped remark printed straight through the next column's rule
    // and struck out the row beneath it.
    isPdf(await buildMaterialLedgerPdf(ledger({
      rows: [row({ remarks: 'x'.repeat(600), lotNo: 'D-'.repeat(60) })],
      count: 1,
    })));
  });

  it('renders with no branding configured', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger({ branding: undefined })));
  });

  it('renders with branding configured', async () => {
    isPdf(await buildMaterialLedgerPdf(ledger({ branding: { company: 'Balu Elastics Pvt Ltd' } })));
  });
});
