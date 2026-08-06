'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDER P&L — the printed statement.
//
//  The builder is pure over the object services/orderPnl.js returns, so
//  these need no database. They assert on the TEXT the sheet carries,
//  because the failure that matters with a printed document is a figure
//  that exists in the data and never reaches the paper — and a byte
//  length tells you nothing about that.
//
//  The other failure this guards is subtler and worse: the sheet
//  reading as authoritative while the numbers on it rest on cost nobody
//  recorded. Paper outlives the screen that could have warned you.
// ══════════════════════════════════════════════════════════════════

const { buildOrderPnlPdf } = require('../../utils/orderPnlPdf');
const { pdfText, pdfPageCount } = require('../helpers/pdfText');

const job = (over = {}) => ({
  id: 'j1', jobOrderNo: 42, jobNo: 'J-42', status: 'weaving',
  productionMode: 'in_house', outsourceVendor: '',
  producedMeters: 1000,
  labour: { amount: 1200, shifts: 2, hours: 24, openShifts: 0 },
  jobWork: 0,
  finishing: { amount: 2000, basis: 'rate' },
  checking: { amount: 1000, basis: 'rate' },
  packing: { amount: 500, basis: 'rate' },
  overhead: { amount: 3000, basis: 'rate' },
  total: 7700, costPerMeter: 7.7,
  ...over,
});

const pnl = (over = {}) => ({
  order: {
    id: 'o1', orderNo: 91, po: 'PO-8891', status: 'InProgress',
    date: '2026-05-01T00:00:00.000Z', supplyDate: '2026-07-15T00:00:00.000Z',
    customerName: 'Anand Garments',
  },
  revenue: {
    lines: [
      { elasticId: 'e1', name: 'Woven Elastic 25mm', quantity: 12000, rate: 14.5, amount: 174000 },
      { elasticId: 'e2', name: 'Woven Elastic 50mm', quantity: 4000, rate: 26, amount: 104000 },
    ],
    orderValue: 278000,
    invoiced: { amount: 87000, quantity: 6000, challans: 1 },
  },
  costs: {
    material: 101060, labour: 12540, jobWork: 18655,
    finishing: 27140, checking: 13570, packing: 6785, overhead: 40710,
    total: 220460,
  },
  jobs: [job()],
  totals: {
    producedMeters: 13570, orderedQuantity: 16000,
    profit: 57540, marginPct: 20.7, costPerMeter: 16.25, revenuePerMeter: 20.49,
  },
  rateCard: {
    finishingRatePerMeter: 2, checkingRatePerMeter: 1,
    packingRatePerMeter: 0.5, overheadRatePerMeter: 3, configured: true,
  },
  materialLines: [
    { name: 'Nylon 70D', quantity: 148, unitPrice: 310, amount: 45880, type: 'ORDER_APPROVAL' },
    { name: 'Spandex 40D', quantity: 62, unitPrice: 890, amount: 55180, type: 'ORDER_APPROVAL' },
  ],
  warnings: [],
  branding: { company: 'Balu Elastics' },
  ...over,
});

const build = async (over) => pdfText(await buildOrderPnlPdf(pnl(over)));

// ══════════════════════════════════════════════════════════════════
describe('the statement identifies itself', () => {
  let text;
  beforeAll(async () => { text = await build(); });

  test('carries the title, company, order and customer', () => {
    expect(text).toMatch(/ORDER P&L/);
    expect(text).toMatch(/Balu Elastics/);
    expect(text).toMatch(/#91/);
    expect(text).toMatch(/PO-8891/);
    expect(text).toMatch(/Anand Garments/);
  });

  test('dates the order and its supply commitment', () => {
    expect(text).toMatch(/01 May 2026/);
    expect(text).toMatch(/15 Jul 2026/);
  });

  test('has every section a costing meeting asks for', () => {
    for (const s of [
      'REVENUE', 'COST SUMMARY', 'COST BY JOB', 'YARN ISSUED',
      'BASIS OF COSTING', 'QUALIFICATIONS',
    ]) {
      expect(text).toContain(s);
    }
  });

  test('is signed off like the other forms', () => {
    expect(text).toMatch(/Prepared by/);
    expect(text).toMatch(/Accounts/);
    expect(text).toMatch(/Approved by/);
  });

  test('numbers its pages and stamps when it was generated', () => {
    expect(text).toMatch(/Page 1 of \d+/);
    expect(text).toMatch(/Generated /);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the figures reach the paper', () => {
  let text;
  beforeAll(async () => { text = await build(); });

  test('the result band carries value, cost, profit and margin', () => {
    expect(text).toMatch(/2,78,000/);
    expect(text).toMatch(/2,20,460/);
    expect(text).toMatch(/57,540/);
    expect(text).toMatch(/20\.7%/);
  });

  test('every one of the seven cost elements is printed with its amount', () => {
    const rows = [
      ['Yarn issued', '1,01,060'],
      ['Wages', '12,540'],
      ['Outsourced job-work', '18,655'],
      ['Finishing', '27,140'],
      ['Checking', '13,570'],
      ['Packing', '6,785'],
      ['Overhead', '40,710'],
    ];
    for (const [label, amount] of rows) {
      expect(text).toContain(label);
      expect(text).toContain(amount);
    }
  });

  test('states the basis each element was costed on', () => {
    expect(text).toMatch(/price captured at issue/i);
    expect(text).toMatch(/Scheduled shift hours/i);
    expect(text).toMatch(/meters returned/i);
  });

  test('prints the rate card, so the sheet still explains itself later', () => {
    expect(text).toMatch(/Finishing rate/i);
    expect(text).toMatch(/INR 2\.00 \/ m/);
    expect(text).toMatch(/INR 3\.00 \/ m/);
  });

  test('itemises the yarn at the price it was issued at', () => {
    expect(text).toContain('Nylon 70D');
    expect(text).toContain('310.00');
    expect(text).toContain('45,880');
  });

  test('says the verdict in words, not only in figures', () => {
    expect(text).toMatch(/Profit of INR 57,540 at 20\.7% margin/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  pdfkit's built-in Helvetica is WinAnsi and has NO glyph at U+20B9:
//  it substitutes the byte for "¹", so "₹1,01,060" prints as
//  "¹1,01,060". Amounts are bare numbers under an "(INR)" heading.
describe('currency', () => {
  let text;
  beforeAll(async () => { text = await build(); });

  test('never emits a rupee sign, which would print as a superscript one', () => {
    expect(text).not.toContain('¹');
    expect(text).not.toContain('₹');
  });

  test('no column heading wraps out of its grey band', async () => {
    // A wrapped heading drops its tail onto the first data row. The
    // extractor emits one line per drawn run, so a heading that wrapped
    // shows up as a bare fragment on its own line.
    const lines = (await build()).split('\n');
    for (const h of ['Produced (m)', 'Job cost (INR)', 'Amount (INR)', 'Rate (INR/m)']) {
      expect(lines.some((l) => l.includes(h))).toBe(true);
    }
    expect(lines).not.toContain('(m)');
    expect(lines).not.toContain('(INR)');
  });

  test('names the currency in the column headings instead', () => {
    expect(text).toMatch(/Amount \(INR\)/);
    expect(text).toMatch(/Rate \(INR\/m\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('revenue', () => {
  test('reports the invoiced value BESIDE the order value, not instead of it', async () => {
    const text = await build();
    expect(text).toMatch(/ORDER VALUE/);
    expect(text).toMatch(/Invoiced so far: INR 87,000 across 1 delivery challan/);
    expect(text).toMatch(/what the order is worth in full/);
  });

  test('says so plainly when nothing has shipped', async () => {
    const text = await build({
      revenue: {
        lines: pnl().revenue.lines, orderValue: 278000,
        invoiced: { amount: 0, quantity: 0, challans: 0 },
      },
    });
    expect(text).toMatch(/Nothing dispatched yet/);
  });

  test('marks an unpriced line rather than printing a silent zero', async () => {
    const text = await build({
      revenue: {
        lines: [
          { elasticId: 'e1', name: 'Woven Elastic 25mm', quantity: 12000, rate: 14.5, amount: 174000 },
          { elasticId: 'e2', name: 'Woven Elastic 50mm', quantity: 4000, rate: 0, amount: 0 },
        ],
        orderValue: 174000,
        invoiced: { amount: 0, quantity: 0, challans: 0 },
      },
    });
    expect(text).toMatch(/Woven Elastic 50mm\s+\(not priced\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('cost by job', () => {
  // pdfkit CLIPS at the column width rather than wrapping, so a long
  // vendor name silently loses its tail on the sheet.
  test('prints an ordinary long vendor name in full', async () => {
    const text = await build({
      jobs: [job({
        productionMode: 'outsource',
        outsourceVendor: 'Sunrise Weaving Mills Pvt Ltd',
      })],
    });
    expect(text).toMatch(/Sunrise Weaving Mills Pvt Ltd/);
  });

  // If a name really is too long for its column, the sheet must SHOW
  // that it was cut. Losing the tail silently is how "Sunrise Weaving
  // Mills, Erode" and "Sunrise Weaving Mills, Tirupur" become the same
  // supplier in a costing meeting.
  test('marks a name it had to cut, rather than dropping the tail silently', async () => {
    const text = await build({
      jobs: [job({
        productionMode: 'outsource',
        outsourceVendor: 'Sunrise Weaving And Elastic Manufacturing Company Private Limited, Erode',
      })],
    });
    expect(text).toMatch(/Sunrise Weaving And Elastic/);
    expect(text).toMatch(/…|\.\.\./);
  });

  test('names the vendor on an outsourced job and the shift count on an in-house one', async () => {
    const text = await build({
      jobs: [
        job(),
        job({
          id: 'j2', jobNo: 'J-43', productionMode: 'outsource',
          outsourceVendor: 'Sunrise Weaving', jobWork: 18655,
          labour: { amount: 0, shifts: 0, hours: 0, openShifts: 0 },
        }),
      ],
    });
    expect(text).toMatch(/Sunrise Weaving/);
    expect(text).toMatch(/In-house/);
    expect(text).toMatch(/2 shift\(s\)/);
  });

  // Yarn is drawn against the ORDER, so there is no honest per-job
  // split of it. Silently omitting it would make the job totals look
  // like they add up to the order's cost when they cannot.
  test('says outright that yarn is not split across jobs', async () => {
    const text = await build();
    expect(text).toMatch(/Yarn is drawn against the ORDER at approval, not against a job/);
  });

  test('marks a job costed from a typed figure rather than the rate card', async () => {
    const text = await build({
      jobs: [job({ finishing: { amount: 25000, basis: 'override' } })],
    });
    expect(text).toMatch(/costed from a figure entered/);
    expect(text).toMatch(/26,500 \*/); // 25000 + 1000 + 500, flagged
  });

  test('a rupee sign in a vendor name does not print as a superscript one', async () => {
    const text = await build({
      jobs: [job({ productionMode: 'outsource', outsourceVendor: 'Sunrise ₹ Weaving' })],
    });
    expect(text).not.toContain('¹');
    expect(text).toMatch(/Sunrise INR Weaving/);
  });

  test('an order with no jobs says so instead of printing an empty grid', async () => {
    const text = await build({ jobs: [] });
    expect(text).toMatch(/No jobs have been raised against this order/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  The most important section. Paper outlives the screen that could
//  have warned you, so a statement resting on unrecorded cost has to
//  carry that on its face.
describe('qualifications', () => {
  test('prints every missing input, verbatim', async () => {
    const text = await build({
      warnings: [
        '1 shift(s) were run by employees with no hourly rate set.',
        '1 material issue(s) had no price recorded (Filler Yarn).',
      ],
    });
    expect(text).toMatch(/no hourly rate set/);
    expect(text).toMatch(/Filler Yarn/);
  });

  // The service writes its warnings with a rupee sign, and Helvetica has
  // no glyph for it — "costed at ₹0" printed as "costed at ¹0" on the
  // sheet. The builder's own text was already ASCII; this is about text
  // that arrives from elsewhere.
  test('rewrites a rupee sign that arrives inside a warning', async () => {
    const text = await build({
      warnings: ['1 shift(s) were run by employees with no hourly rate set — their labour is costed at ₹0.'],
    });
    expect(text).not.toContain('¹');
    expect(text).toMatch(/costed at INR 0\./);
  });

  test('says so explicitly when nothing is missing, rather than staying silent', async () => {
    const text = await build();
    expect(text).toMatch(/None\. Every input behind these figures was recorded\./);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('an order that lost money, or was never priced', () => {
  test('a loss is stated in words, not left to a minus sign', async () => {
    const text = await build({
      totals: {
        producedMeters: 13570, orderedQuantity: 16000,
        profit: -8010, marginPct: -12.4, costPerMeter: 16.25, revenuePerMeter: 4.8,
      },
    });
    expect(text).toMatch(/LOSS of INR 8,010/);
    expect(text).toMatch(/-12\.4% margin|\(-12\.4% margin\)/);
  });

  // A margin of null is UNKNOWN, not -100%. Printing a number there
  // puts a fake disaster on paper and buries the real ones.
  test('an unpriced order reads NOT PRICED, never a computed margin', async () => {
    const text = await build({
      revenue: {
        lines: [{ elasticId: 'e1', name: 'Woven Elastic 50mm', quantity: 2500, rate: 0, amount: 0 }],
        orderValue: 0,
        invoiced: { amount: 0, quantity: 0, challans: 0 },
      },
      totals: {
        producedMeters: 900, orderedQuantity: 2500,
        profit: -8010, marginPct: null, costPerMeter: 8.9, revenuePerMeter: 0,
      },
    });
    expect(text).toMatch(/NOT PRICED/);
    expect(text).toMatch(/no selling rate has been entered/i);
    expect(text).not.toMatch(/-100%/);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the sheet holds together', () => {
  // Seven sections do not fit one page, and squeezing them onto one
  // would make the grid cramped and the pagination fragile. What must
  // hold is that an ordinary order stays short: the tables on page one,
  // the basis, qualifications and sign-off on page two.
  test('an ordinary order is two pages, with the sign-off on the last', async () => {
    const buf = await buildOrderPnlPdf(pnl());
    expect(pdfPageCount(buf)).toBe(2);
    expect(pdfText(buf)).toMatch(/Page 2 of 2/);
  });

  test('every section is present exactly once on a normal order', async () => {
    const text = await build();
    for (const s of ['REVENUE', 'COST SUMMARY', 'COST BY JOB', 'YARN ISSUED',
      'BASIS OF COSTING', 'QUALIFICATIONS']) {
      expect(text.split(s).length - 1).toBe(1);
    }
  });

  // The footer is written inside the bottom margin with that margin
  // zeroed; getting that wrong spawns a trailing blank page.
  test('a long order paginates without a trailing blank page', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      job({ id: `j${i}`, jobNo: `J-${100 + i}` }));
    const buf = await buildOrderPnlPdf(pnl({ jobs: many }));
    const pages = pdfPageCount(buf);
    const text = pdfText(buf);
    expect(pages).toBeGreaterThan(1);
    expect(text).toMatch(new RegExp(`Page ${pages} of ${pages}`));
    // The last page carries real content, not just a footer.
    expect(text).toMatch(/QUALIFICATIONS/);
    expect(text).toMatch(/Approved by/);
  });

  test('survives an empty P&L without throwing', async () => {
    const buf = await buildOrderPnlPdf({
      order: {}, revenue: { lines: [], orderValue: 0, invoiced: {} },
      costs: {}, jobs: [], totals: {}, rateCard: {}, materialLines: [], warnings: [],
    });
    expect(buf.length).toBeGreaterThan(500);
    expect(pdfText(buf)).toMatch(/ORDER P&L/);
  });
});
