'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NAME TOO LONG FOR ITS CELL DOES NOT PRINT OVER THE ROW BELOW
//
//  Found reading utils/orderStatusPdf.js and utils/mrpPdf.js line by
//  line. A text given a width wraps when it is wider than it, whatever
//  `lineBreak` says. These two sheets have rows of a fixed height, and
//  placed each cell as "one line": an elastic called "40mm Jacquard
//  Waistband Elastic, logo woven" ran onto a second line, on top of the
//  row beneath. (The order P&L and the stock ledger already measure and
//  cut; these did not.)
//
//  Held here: every row of these tables is one line of text, the cut is
//  marked with "…", and a name that fits is printed whole.
// ══════════════════════════════════════════════════════════════════

const { buildOrderStatusPdf } = require('../../utils/orderStatusPdf');
const { buildMrpPdf } = require('../../utils/mrpPdf');
const { pdfLines } = require('../helpers/pdfText');

const LONG = '40mm Jacquard Waistband Elastic, logo woven, plush back, navy';

/** The text lines of the row that starts with `first`, up to the next row's first cell. */
const rowsOf = (lines, starts) => lines.filter((l) => starts.some((s) => l.text.startsWith(s)));

describe('the order status sheet', () => {
  const data = (name) => ({
    orderNo: 91, status: 'InProgress', orderDate: '01 May 2026', supplyDate: '15 Jul 2026', customerName: 'Anand Garments',
    daysToSupply: 20, overdue: false, dueSoon: false,
    lines: [
      { name, ordered: 12000, produced: 4000, packed: 2000, notAssigned: 0, pendingDelivery: 10000, packedPct: 17 },
      { name: '20mm Knitted White', ordered: 4000, produced: 0, packed: 0, notAssigned: 4000, pendingDelivery: 4000, packedPct: 0 },
    ],
    totals: { ordered: 16000, produced: 4000, packed: 2000, notAssigned: 4000, pendingDelivery: 14000, packedPct: 13 },
    jobs: [{ jobNo: 'J-42', date: '02 May 2026', status: 'weaving', machine: 'L-7', warping: 'completed', covering: 'completed', planned: 12000, produced: 4000, packed: 2000,
      elastics: `${name}, 20mm Knitted White`, productionMode: 'outsource', outsourceVendor: 'Sri Lakshmi Narrow Fabrics Private Limited', shiftCount: 4, shiftMeters: 4100 }],
    jobTotals: { planned: 12000, produced: 4000, packed: 2000, shiftMeters: 4100 },
    unplanned: 4000,
  });

  it('a long elastic name is one line in its row, cut with "…"', async () => {
    const lines = pdfLines(await buildOrderStatusPdf(data(LONG)));
    const first = lines.find((l) => l.text.startsWith('40mm Jacquard'));
    const second = lines.find((l) => l.text.startsWith('20mm Knitted White'));
    expect(first.text.endsWith('…')).toBe(true);
    // The rows are 18 points apart, and nothing is printed between them in the name column.
    expect(Math.round(second.y - first.y)).toBe(18);
    const between = lines.filter((l) => Math.abs(l.x - first.x) < 1 && l.y > first.y + 1 && l.y < second.y - 1);
    expect(between).toEqual([]);
  });

  it('the job tables too: the elastics and the vendor each on one line', async () => {
    const lines = pdfLines(await buildOrderStatusPdf(data(LONG)));
    const elastics = lines.filter((l) => l.text.startsWith('40mm Jacquard'));
    expect(elastics.length).toBe(2);                                   // the order line and the production row, nothing wrapped
    expect(lines.filter((l) => /^(plush back|navy|logo woven)/.test(l.text))).toEqual([]);
    const vendor = lines.find((l) => l.text.startsWith('Outsourced'));
    expect(vendor.text.endsWith('…')).toBe(true);
  });

  it('a name that fits is printed whole', async () => {
    const lines = pdfLines(await buildOrderStatusPdf(data('25mm Woven Elastic')));
    expect(lines.find((l) => l.text === '25mm Woven Elastic')).toBeTruthy();
  });

  it('a long customer name and address stay inside the customer box, a line each', async () => {
    const lines = pdfLines(await buildOrderStatusPdf({
      ...data('25mm Woven Elastic'),
      customerName: 'Sri Lakshmi Venkateswara Garments and Hosiery Exports Private Limited, Unit II',
      customerGstin: '33AAEPS1111F1Z2',
      customerAddress: 'Plot 14-B, SIDCO Industrial Estate, Mudalipalayam, Nallur Post, Kangeyam Road, Tiruppur, Tamil Nadu - 641606, India',
    }));
    const name = lines.filter((l) => l.text.startsWith('Sri Lakshmi'));
    const sub = lines.filter((l) => l.text.startsWith('GSTIN 33AAEPS1111F1Z2'));
    expect(name.length).toBe(1);
    expect(name[0].text.endsWith('…')).toBe(true);
    expect(sub.length).toBe(1);
    expect(sub[0].text.endsWith('…')).toBe(true);
    // Nothing of either was carried onto a line of its own below.
    expect(lines.filter((l) => /^(Unit II|Exports|Private Limited|Tamil Nadu|India|Kangeyam)/.test(l.text))).toEqual([]);
  });
});

describe('the MRP sheet', () => {
  const sheet = (name, supplierName) => buildMrpPdf({
    jobOrderNo: 12, orderNo: 91, customerName: 'Anand Garments', dateLabel: '20 Nov 2026', status: 'weaving', productionMode: 'in_house',
    elastics: [{ name: LONG, quantity: 12000 }],
    materials: [
      { name, category: 'covering', supplierName, requiredWeight: 148.5, inStock: 20, onOrder: 0, shortfall: 128.5 },
      { name: 'Nylon 70D', category: 'warp', supplierName: 'KPR', requiredWeight: 60, inStock: 100, onOrder: 0, shortfall: 0 },
    ],
  });

  it('a long material and supplier are one line each, the rows 20 points apart', async () => {
    const lines = pdfLines(await sheet('Polyester Textured Yarn 150D/48F Semi-Dull Raw White', 'Sri Venkateswara Synthetic Yarn Traders'));
    const first = lines.find((l) => l.text.startsWith('Polyester Textured'));
    const second = lines.find((l) => l.text.startsWith('Nylon 70D'));
    expect(first.text.endsWith('…')).toBe(true);
    expect(Math.round(second.y - first.y)).toBe(20);
    expect(lines.filter((l) => l.y > first.y + 1 && l.y < second.y - 1)).toEqual([]);
    expect(lines.find((l) => l.text.startsWith('Sri Venkateswara')).text.endsWith('…')).toBe(true);
  });

  it('a short one is printed whole, with its group', async () => {
    const lines = pdfLines(await sheet('Spandex 40D', 'KPR'));
    expect(lines.find((l) => l.text === 'Spandex 40D  (covering)')).toBeTruthy();
  });
});
