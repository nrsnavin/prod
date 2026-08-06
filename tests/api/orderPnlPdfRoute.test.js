'use strict';
// ══════════════════════════════════════════════════════════════════
//  ORDER P&L PDF — end to end, from the database to the paper.
//
//  orderPnlPdf.test.js proves the BUILDER renders a given object. It
//  says nothing about whether the ROUTE hands it the right object —
//  which is the seam a printed document actually fails at: a field the
//  service computes, the route fetches, and the sheet never shows, or
//  shows from somewhere else.
//
//  So this seeds real documents, asks the API for the PDF, reads the
//  text back out, and checks every figure against the seed. Then it
//  cross-checks the sheet against the JSON endpoint line by line:
//  whatever the screen is told, the paper must say. That is the check
//  that survives someone adding a cost element and forgetting the PDF.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { pdfText, pdfRuns, hasRow } = require('../helpers/pdfText');

let mongo, app, M = {}, admin, seeded;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');
const oid = () => new mongoose.Types.ObjectId();
const inr = (n) => Math.round(n).toLocaleString('en-IN');

// ── The seed, and the arithmetic it implies ──────────────────────
// Every expected figure below is computed HERE from the inputs, not
// read back from the service — otherwise the test would agree with the
// service's own mistakes.
const RATE_CARD = { finishing: 2, checking: 1, packing: 0.5, overhead: 3 };
const HOURLY = { ravi: 60, meena: 55 };
const SHIFT_HOURS = 12;

const EXPECT = {
  // Revenue: 12,000 × 14.50  +  4,000 × 26.00
  line1: 12000 * 14.5,          // 174000
  line2: 4000 * 26,             // 104000
  orderValue: 12000 * 14.5 + 4000 * 26,   // 278000
  invoiced: 87000,

  // Production: job1 woven 9,200 · job2 woven 1,500 · job3 vendor 2,870
  produced: 9200 + 1500 + 2870, // 13570

  // Wages: 8 closed shifts by Ravi, 6 by Meena. One unrated operator
  // and two still-open shifts contribute nothing.
  wages: 8 * SHIFT_HOURS * HOURLY.ravi + 6 * SHIFT_HOURS * HOURLY.meena, // 9720

  // Yarn: priced at issue, the reversed draw excluded, one line at ₹0
  material: 148 * 310 + 62 * 890,  // 101060

  jobWork: 2870 * 6.5,             // 18655
};
EXPECT.checking = EXPECT.produced * RATE_CARD.checking;   // 13570
EXPECT.packing = EXPECT.produced * RATE_CARD.packing;     // 6785
EXPECT.overhead = EXPECT.produced * RATE_CARD.overhead;   // 40710
// Finishing: job1 carries a typed override of 25,000; the other two
// come off the rate card.
EXPECT.finishing = 25000 + (1500 + 2870) * RATE_CARD.finishing; // 33740
EXPECT.totalCost = EXPECT.material + EXPECT.wages + EXPECT.jobWork
  + EXPECT.finishing + EXPECT.checking + EXPECT.packing + EXPECT.overhead;
EXPECT.profit = EXPECT.orderValue - EXPECT.totalCost;
EXPECT.marginPct = Math.round((EXPECT.profit / EXPECT.orderValue) * 100 * 100) / 100;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of [
    'User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'Employee', 'ShiftDetail',
    'RawMaterial', 'DeliveryChallan', 'CostSettings', 'DocumentSettings',
  ]) M[n] = require(`../../models/${n}.js`);
  M.MaterialOutward = require('../../models/MaterialOut.cjs');

  admin = await M.User.create({
    name: 'Owner', email: 'pdfroute@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });

  // Branding, so the letterhead is proven to come from the database
  // rather than from the builder's fallback.
  await M.DocumentSettings.findOneAndUpdate(
    { key: 'document' },
    { $set: { companyName: 'Anand Elastics Pvt Ltd' }, $setOnInsert: { key: 'document' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  require('../../services/documentSettings.js').invalidate();

  await M.CostSettings.create({
    key: 'cost',
    finishingRatePerMeter: RATE_CARD.finishing,
    checkingRatePerMeter: RATE_CARD.checking,
    packingRatePerMeter: RATE_CARD.packing,
    overheadRatePerMeter: RATE_CARD.overhead,
  });

  const customer = await M.Customer.create({
    name: 'Sri Balaji Garments', contactName: 'Mr Anand', phoneNumber: '9840000001',
  });
  const mkElastic = (name, ends) => M.Elastic.create({
    name, weaveType: '8', spandexEnds: ends, pick: 30, noOfHook: 12, weight: 5,
  });
  const e25 = await mkElastic('Woven Elastic 25mm', 40);
  const e50 = await mkElastic('Woven Elastic 50mm', 80);

  const order = await M.Order.create({
    date: new Date('2026-05-01'), po: 'PO-8891', customer: customer._id,
    supplyDate: new Date('2026-07-15'), status: 'InProgress',
    elasticOrdered: [
      { elastic: e25._id, quantity: 12000, rate: 14.5 },
      { elastic: e50._id, quantity: 4000, rate: 26 },
    ],
  });

  const mkJob = (over) => M.JobOrder.create({
    date: new Date('2026-05-03'), order: order._id, customer: customer._id,
    status: 'weaving', ...over,
  });
  const job1 = await mkJob({
    producedElastic: [{ elastic: e25._id, quantity: 9200 }],
    costOverrides: { finishing: 25000 },
  });
  const job2 = await mkJob({ producedElastic: [{ elastic: e50._id, quantity: 1500 }] });
  const job3 = await mkJob({
    productionMode: 'outsource', outsourceVendor: 'Sunrise Weaving',
    outsourcing: {
      qtySentMeters: 3000, qtyReceivedMeters: 2870, efficiencyPct: 96,
      ratePerMeter: 6.5, actualReturnDate: new Date('2026-06-24'),
      notes: 'Returned in three bundles.',
    },
  });

  const mkEmp = (name, hourlyRate) =>
    M.Employee.create({ name, department: 'weaving', skill: 1, hourlyRate });
  const ravi = await mkEmp('Ravi Kumar', HOURLY.ravi);
  const meena = await mkEmp('Meena S', HOURLY.meena);
  const trainee = await mkEmp('New Trainee', 0);

  let d = 0;
  const mkShift = (job, employee, status = 'closed') => M.ShiftDetail.create({
    date: new Date(2026, 4, 5 + d++), shift: d % 2 ? 'DAY' : 'NIGHT',
    job: job._id, employee: employee._id, shiftPlan: oid(), machine: oid(),
    status, productionMeters: status === 'closed' ? 650 : 0,
  });
  for (let i = 0; i < 8; i++) await mkShift(job1, ravi);
  for (let i = 0; i < 6; i++) await mkShift(job2, meena);
  await mkShift(job2, trainee);          // no hourly rate  → warning, ₹0
  await mkShift(job2, ravi, 'open');     // rostered, not worked
  await mkShift(job2, meena, 'open');

  const nylon = await M.RawMaterial.create({ name: 'Nylon 70D', category: 'yarn', price: 310 });
  const spandex = await M.RawMaterial.create({ name: 'Spandex 40D', category: 'spandex', price: 890 });
  const filler = await M.RawMaterial.create({ name: 'Filler Yarn', category: 'yarn', price: 0 });
  await M.MaterialOutward.create([
    { rawMaterial: nylon._id, quantity: 148, order: order._id, type: 'ORDER_APPROVAL', unitPrice: 310 },
    { rawMaterial: spandex._id, quantity: 62, order: order._id, type: 'ORDER_APPROVAL', unitPrice: 890 },
    { rawMaterial: filler._id, quantity: 18, order: order._id, type: 'ORDER_APPROVAL', unitPrice: 0 },
    // Handed back — must not reach the sheet.
    { rawMaterial: nylon._id, quantity: 40, order: order._id, type: 'ORDER_APPROVAL', unitPrice: 310, reversed: true },
  ]);

  await M.DeliveryChallan.create({
    dcNumber: 'DC/2026-27/0042', type: 'elastic', financialYear: '2026-27', sequence: 42,
    order: order._id, orderNo: order.orderNo, customerName: customer.name,
    status: 'dispatched',
    items: [{ elastic: e25._id, elasticName: e25.name, quantity: 6000, rate: 14.5, amount: 87000 }],
    totalQuantity: 6000, totalAmount: 87000,
  });

  seeded = { order, customer, job1, job2, job3, e25, e50 };
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

const getPdf = (id) =>
  request(app).get(`/api/v2/pnl/order/${id}.pdf`)
    .set('Cookie', adminCookie()).buffer().parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

const getJson = (id) =>
  request(app).get(`/api/v2/pnl/order/${id}`).set('Cookie', adminCookie());

let text, runs, res;
beforeAll(async () => {
  res = await getPdf(seeded.order._id);
  text = pdfText(res.body);
  runs = pdfRuns(res.body);
}, 60_000);

// ══════════════════════════════════════════════════════════════════
describe('the route serves a PDF', () => {
  test('200, application/pdf, named after the real order number', () => {
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition'])
      .toBe(`inline; filename="order-pnl-${seeded.order.orderNo}.pdf"`);
  });

  test('the body really is a PDF, not an error page', () => {
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('an unknown order is a 404, not an empty sheet', async () => {
    const r = await request(app).get(`/api/v2/pnl/order/${oid()}.pdf`)
      .set('Cookie', adminCookie());
    expect(r.status).toBe(404);
  });

  // The ".pdf" suffix is a different express path from "/order/:id".
  // A gate that covered one and missed the other would leak margin.
  test('the PDF is behind the same /order-pnl feature as the screen', async () => {
    const u = await request(app).post('/api/v2/user/manage/create')
      .set('Cookie', adminCookie())
      .send({ name: 'NoPnl', email: 'nopnl-pdf@t.co', password: 'pass1234',
        department: 'finance', features: ['/orders'] });
    const r = await request(app)
      .get(`/api/v2/pnl/order/${seeded.order._id}.pdf`)
      .set('Cookie', cookie(u.body.user.id, 'accounts'));
    expect(r.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the header comes from the database', () => {
  test('the letterhead uses the configured company, not the fallback', () => {
    expect(text).toContain('Anand Elastics Pvt Ltd');
    expect(text).not.toContain('Balu Elastics');
  });

  test('the order number, PO, status and customer are the seeded ones', () => {
    expect(text).toContain(`#${seeded.order.orderNo}`);
    expect(text).toContain('PO-8891');
    expect(text).toContain('InProgress');
    expect(text).toContain('Sri Balaji Garments');
  });

  test('the dates are the order and supply dates on the document', () => {
    expect(text).toContain('01 May 2026');
    expect(text).toContain('15 Jul 2026');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('revenue is the rate on the order lines', () => {
  test('each elastic is named with its ordered quantity, rate and amount', () => {
    expect(text).toContain('Woven Elastic 25mm');
    expect(text).toContain('Woven Elastic 50mm');
    expect(text).toContain('12,000');
    expect(text).toContain('14.50');
    expect(text).toContain(inr(EXPECT.line1));   // 1,74,000
    expect(text).toContain('26.00');
    expect(text).toContain(inr(EXPECT.line2));   // 1,04,000
  });

  test('the order value is the sum of the lines', () => {
    expect(text).toContain(inr(EXPECT.orderValue)); // 2,78,000
  });

  test('the dispatched challan is reported as invoiced, beside it', () => {
    expect(text).toMatch(
      new RegExp(`Invoiced so far: INR ${inr(EXPECT.invoiced)} across 1 delivery challan`)
    );
  });
});

// ══════════════════════════════════════════════════════════════════
describe('every cost element traces to its documents', () => {
  test('yarn is valued at the price captured at issue, refunds excluded', () => {
    // 148 × 310 + 62 × 890. The reversed 40 kg draw is NOT in it.
    expect(text).toContain(inr(EXPECT.material));           // 1,01,060
    expect(text).not.toContain(inr(EXPECT.material + 40 * 310));
  });

  test('wages come from the shifts, at the operators\' own rates', () => {
    // 8 × 12h × 60 + 6 × 12h × 55. The unrated operator and the two
    // open shifts add nothing.
    expect(text).toContain(inr(EXPECT.wages));              // 9,720
  });

  test('job-work is the vendor rate on the meters that came back', () => {
    expect(text).toContain(inr(EXPECT.jobWork));            // 18,655
  });

  test('the rate-card elements are the rate times produced meters', () => {
    expect(text).toContain(inr(EXPECT.checking));           // 13,570
    expect(text).toContain(inr(EXPECT.packing));            // 6,785
    expect(text).toContain(inr(EXPECT.overhead));           // 40,710
  });

  test("finishing honours the job's typed override over the rate card", () => {
    // 25,000 on job1 instead of 9,200 × 2, plus the other two at rate.
    expect(text).toContain(inr(EXPECT.finishing));          // 33,740
  });

  test('the rate card printed on the sheet is the one in the database', () => {
    expect(text).toContain('INR 2.00 / m');
    expect(text).toContain('INR 1.00 / m');
    expect(text).toContain('INR 0.50 / m');
    expect(text).toContain('INR 3.00 / m');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the bottom line', () => {
  test('total cost is the seven elements added up', () => {
    expect(text).toContain(inr(EXPECT.totalCost));
  });

  test('profit is order value less total cost', () => {
    expect(text).toContain(inr(EXPECT.profit));
  });

  test('margin and produced meters are stated in the verdict', () => {
    expect(text).toMatch(
      new RegExp(`Profit of INR ${inr(EXPECT.profit)} at ${EXPECT.marginPct}% margin `
        + `on ${inr(EXPECT.produced)} m produced`)
    );
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the jobs on the sheet are the jobs in the database', () => {
  test('all three appear, by their real job numbers', async () => {
    const fresh = await M.JobOrder.find({ order: seeded.order._id })
      .select('jobOrderNo').lean();
    expect(fresh).toHaveLength(3);
    for (const j of fresh) expect(text).toContain(`J-${j.jobOrderNo}`);
  });

  test('the outsourced one names its vendor, the in-house ones their shifts', () => {
    expect(text).toContain('Sunrise Weaving');
    expect(text).toMatch(/In-house · 8 shift\(s\)/);
    // job2 has 6 costed shifts; the two open ones are not charged.
    expect(text).toMatch(/In-house · 7 shift\(s\)/);
  });

  test("each job's produced meters are its own", () => {
    expect(text).toContain('9,200');
    expect(text).toContain('1,500');
    expect(text).toContain('2,870');
  });
});

// ══════════════════════════════════════════════════════════════════
describe('yarn issued, line by line', () => {
  test('names every material with its quantity and price at issue', () => {
    expect(text).toContain('Nylon 70D');
    expect(text).toContain('310.00');
    expect(text).toContain(inr(148 * 310));   // 45,880
    expect(text).toContain('Spandex 40D');
    expect(text).toContain('890.00');
    expect(text).toContain(inr(62 * 890));    // 55,180
  });

  test('an issue with no price is marked, not shown as free', () => {
    expect(text).toContain('Filler Yarn');
    expect(text).toContain('NO PRICE');
  });

  test('the reversed draw is absent from the itemised list', () => {
    // Only one Nylon row: the 148 kg issue, not the 40 kg refund.
    expect(text.split('Nylon 70D').length - 1).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the qualifications are the service\'s own warnings', () => {
  test('the sheet carries every warning the JSON endpoint reports', async () => {
    const json = await getJson(seeded.order._id);
    const warnings = json.body.pnl.warnings;
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) {
      // The builder rewrites ₹ to INR on the way to a WinAnsi page, so
      // compare on the part either side of it.
      for (const fragment of w.split('₹')[0].trim().split(' — ')) {
        expect(text).toContain(fragment.trim().replace(/\.$/, ''));
      }
    }
  });

  test('the three the seed deliberately causes are all named', () => {
    expect(text).toMatch(/no hourly rate set/);
    expect(text).toMatch(/2 shift\(s\) are still open/);
    expect(text).toMatch(/Filler Yarn/);
  });

  test('no rupee sign survived onto the page as a superscript one', () => {
    expect(text).not.toContain('¹');
  });
});

// ══════════════════════════════════════════════════════════════════
//  The check that outlives this test file: whatever the screen is
//  told, the paper says. Adding a cost element and forgetting the PDF
//  fails here without anyone remembering to add an assertion.
//  These assert whole ROWS, not bare presence. "Is 40,710 anywhere on
//  the sheet?" passes even after the cost summary loses its overhead
//  line, because the job table's total carries the same figure — which
//  is exactly the hollow check this file is here to avoid.
describe('the sheet agrees with the JSON the screen reads', () => {
  let pnl;
  const LABELS = {
    material: 'Yarn issued', labour: 'Wages', jobWork: 'Outsourced job-work',
    finishing: 'Finishing', checking: 'Checking', packing: 'Packing',
    overhead: 'Overhead',
  };

  beforeAll(async () => { pnl = (await getJson(seeded.order._id)).body.pnl; });

  test('every cost element in the payload has its own row, with its amount', () => {
    for (const [key, label] of Object.entries(LABELS)) {
      expect({ key, row: hasRow(runs, [label, '', inr(pnl.costs[key])]) })
        .toEqual({ key, row: true });
    }
  });

  test('the payload carries no cost element the sheet has no row for', () => {
    const printed = new Set(Object.keys(LABELS));
    const inPayload = Object.keys(pnl.costs).filter((k) => k !== 'total');
    expect(inPayload.filter((k) => !printed.has(k))).toEqual([]);
  });

  test('the total cost row is the payload total', () => {
    expect(hasRow(runs, ['TOTAL COST', '', inr(pnl.costs.total)])).toBe(true);
  });

  test('order value, profit and margin match the payload exactly', () => {
    expect(text).toContain(inr(pnl.revenue.orderValue));
    expect(text).toContain(inr(pnl.totals.profit));
    expect(text).toContain(`${pnl.totals.marginPct}%`);
  });

  test('every revenue line is a row: name, quantity, rate, amount', () => {
    for (const l of pnl.revenue.lines) {
      expect({
        line: l.name,
        row: hasRow(runs, [
          l.name,
          l.quantity.toLocaleString('en-IN'),
          l.rate.toFixed(2),
          inr(l.amount),
        ]),
      }).toEqual({ line: l.name, row: true });
    }
  });

  test('every material line is a row: material, quantity, price, amount', () => {
    for (const m of pnl.materialLines) {
      expect({
        material: m.name,
        row: hasRow(runs, [
          m.name,
          m.quantity.toLocaleString('en-IN'),
          m.unitPrice > 0 ? m.unitPrice.toFixed(2) : 'NO PRICE',
          inr(m.amount),
        ]),
      }).toEqual({ material: m.name, row: true });
    }
  });

  test('every job is a row: job, produced, wages, job-work, and its total', () => {
    for (const j of pnl.jobs) {
      const conversion = j.finishing.amount + j.checking.amount + j.packing.amount;
      expect({
        job: j.jobNo,
        row: hasRow(runs, [
          j.jobNo, '',
          inr(j.producedMeters),
          inr(j.labour.amount),
          inr(j.jobWork),
          inr(conversion),
          inr(j.overhead.amount),
          inr(j.total),
        ]),
      }).toEqual({ job: j.jobNo, row: true });
    }
  });

  test('the rate card in the payload is printed', () => {
    for (const k of ['finishingRatePerMeter', 'checkingRatePerMeter',
      'packingRatePerMeter', 'overheadRatePerMeter']) {
      expect(text).toContain(`INR ${pnl.rateCard[k].toFixed(2)} / m`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
//  A second order, priced at nothing, fetched the same way — the
//  worst thing this document could do is print a confident margin for
//  one of these.
describe('an unpriced order, end to end', () => {
  let unpricedText;

  beforeAll(async () => {
    const order = await M.Order.create({
      date: new Date('2026-06-05'), po: 'PO-9004', customer: seeded.customer._id,
      supplyDate: new Date('2026-08-20'), status: 'Approved',
      elasticOrdered: [{ elastic: seeded.e50._id, quantity: 2500, rate: 0 }],
    });
    await M.JobOrder.create({
      date: new Date('2026-06-06'), order: order._id, customer: seeded.customer._id,
      status: 'weaving', producedElastic: [{ elastic: seeded.e50._id, quantity: 900 }],
    });
    const r = await getPdf(order._id);
    unpricedText = pdfText(r.body);
  }, 60_000);

  test('reads NOT PRICED rather than a computed margin', () => {
    expect(unpricedText).toContain('NOT PRICED');
    expect(unpricedText).not.toMatch(/-100%/);
    expect(unpricedText).toMatch(/no selling rate has been entered/i);
  });

  test('still states the cost that has been incurred', () => {
    // 900 m × (2 + 1 + 0.5 + 3) = 5,850, and it says so.
    expect(unpricedText).toContain(inr(900 * 6.5));
  });

  test('marks the unpriced line in the revenue table', () => {
    expect(unpricedText).toMatch(/\(not priced\)/);
  });
});
