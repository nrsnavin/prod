'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE LIST OF CUSTOMERS SOMEBODY IS ABOUT TO TELEPHONE
//
//  This report's output is acted on immediately and socially: it names
//  other customers, and somebody rings them. Both errors are expensive
//  and they are not symmetric, so the tests are not symmetric either.
//
//    • A job MISSED is a customer who discovers the defect themselves.
//      Most of these tests are about not missing one — lots recorded by
//      number instead of reference, batches that never said which
//      elastic they warped, programmes not yet issued.
//
//    • A job named WRONGLY sends an apology to somebody who received
//      nothing wrong. The `certain` flag exists for the one case the
//      data genuinely cannot resolve, and there is a test that it is
//      false there and true everywhere else.
//
//  The bucket split — delivered / inTransit / inHouse — is the part
//  worth the most, because the in-house half is the only half anybody
//  can still do something about.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, svc;
let Complaint, JobOrder, Order, Customer, Elastic, WarpingPlan, WarpingBatch,
    DeliveryChallan, Warping, RawMaterial, YarnLot;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  svc             = require('../../services/complaintTrace');
  Complaint       = require('../../models/Complaints');
  JobOrder        = require('../../models/JobOrder');
  Order           = require('../../models/Order');
  Customer        = require('../../models/Customer');
  Elastic         = require('../../models/Elastic');
  WarpingPlan     = require('../../models/WarpingPlan');
  WarpingBatch    = require('../../models/WarpingBatch');
  DeliveryChallan = require('../../models/DeliveryChallan');
  Warping         = require('../../models/Warping');
  RawMaterial     = require('../../models/RawMaterial');
  YarnLot         = require('../../models/YarnLot');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

let seq = 0;
const oid = () => new mongoose.Types.ObjectId();

// contactName is `required: true` with `default: ""` on the model, and an
// empty string does not satisfy required — so it has to be passed here
// however irrelevant it is to these tests.
const makeCustomer = (name) => Customer.create({
  name, contactName: name, phoneNumber: `9${String(seq++).padStart(9, '0')}`,
});

const makeElastic = (name) => Elastic.create({
  name: name || `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
  pick: 12, noOfHook: 8, weight: 2.4,
});

const makeMaterial = () => RawMaterial.create({
  name: `Y-${seq++}`, unit: 'kg', category: 'yarn',
});

async function makeJob({ customer, elastics = [], status = 'weaving' }) {
  const order = await Order.create({
    customer, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
    elastics: elastics.map((e) => ({ elastic: e, quantity: 1000 })),
  });
  const job = await JobOrder.create({
    order: order._id, customer, date: new Date(), status,
    elastics: elastics.map((e) => ({ elastic: e, quantity: 1000 })),
  });
  return { job, order };
}

async function programme({ job, elastic, lotId, lotNo, shade = 'D-blue' }) {
  const warping = await Warping.create({ job: job._id, date: new Date() });
  const material = await makeMaterial();
  return WarpingPlan.create({
    warping: warping._id, job: job._id, noOfBeams: 1,
    beams: [{
      beamNo: 1, totalEnds: 400, elastic: elastic || null,
      sections: [{ warpYarn: material._id, ends: 400, yarnLot: lotId || null, lotNo: lotNo || '', shade }],
    }],
  });
}

async function issue({ job, elastics = [], lotId, lotNo, shade = 'D-blue' }) {
  const material = await makeMaterial();
  const warping = await Warping.create({ job: job._id, date: new Date() });
  return WarpingBatch.create({
    batchNo: `WB-${String(seq++).padStart(4, '0')}`,
    warping: warping._id, job: job._id, elastics,
    allocations: [{
      rawMaterial: material._id, yarnLot: lotId || oid(),
      lotNo: lotNo || '', shade, materialName: 'Nylon 70D', quantity: 12,
    }],
  });
}

async function challan({ order, customerName, elastic, status }) {
  return DeliveryChallan.create({
    dcNumber: `DC-${String(seq++).padStart(4, '0')}`,
    type: 'elastic', financialYear: '2026-27', sequence: seq,
    order: order._id, customerName, status,
    items: [{ elastic, elasticName: 'x', quantity: 100 }],
  });
}

async function fileComplaint({ customer, job, elastic, category = 'shade' }) {
  return Complaint.create({
    customer, job: job._id, elastic: elastic || undefined,
    category, reason: 'Shade band visible across the roll',
  });
}

// ══════════════════════════════════════════════════════════════════
//  Finding the lots behind the complained-of job
// ══════════════════════════════════════════════════════════════════
describe('lotsForJob', () => {
  test('reads a lot from the warping programme, before anything is issued', async () => {
    const cust = await makeCustomer('Anand Garments');
    const el = await makeElastic();
    const { job } = await makeJob({ customer: cust._id, elastics: [el._id] });
    const lot = oid();
    await programme({ job, elastic: el._id, lotId: lot });

    const lots = await svc.lotsForJob(job._id);
    expect(lots).toHaveLength(1);
    expect(lots[0].source).toBe('planned');
    expect(String(lots[0].yarnLot)).toBe(String(lot));
  });

  test('an issued lot outranks the same lot merely planned', async () => {
    const cust = await makeCustomer('Anand Garments');
    const el = await makeElastic();
    const { job } = await makeJob({ customer: cust._id, elastics: [el._id] });
    const lot = oid();
    await programme({ job, elastic: el._id, lotId: lot });
    await issue({ job, elastics: [el._id], lotId: lot });

    const lots = await svc.lotsForJob(job._id);
    // One lot, not two: the same lot seen twice is one lot.
    expect(lots).toHaveLength(1);
    // Issued is the stronger fact — the yarn is off the rack and that
    // cannot now be revised.
    expect(lots[0].source).toBe('issued');
  });

  test('a programmed lot whose lot document is gone still traces', async () => {
    // Found by this suite failing. lotsForJob used to .populate() the
    // section's yarnLot, and populate resolves a dangling reference to
    // null — so an ARCHIVED or deleted lot disappeared from the trace
    // and the report came back clean. Archived lots are old stock, which
    // is the stock most likely to be behind a complaint, so the bug hid
    // exactly the cases worth finding.
    const cust = await makeCustomer('Anand Garments');
    const el = await makeElastic();
    const { job } = await makeJob({ customer: cust._id, elastics: [el._id] });
    const orphan = oid();                       // no YarnLot document exists
    await programme({ job, elastic: el._id, lotId: orphan });

    const lots = await svc.lotsForJob(job._id);
    expect(lots).toHaveLength(1);
    expect(String(lots[0].yarnLot)).toBe(String(orphan));
  });

  test('a lot document that does exist supplies the number for display', async () => {
    const cust = await makeCustomer('Anand Garments');
    const el = await makeElastic();
    const mat = await makeMaterial();
    const { job } = await makeJob({ customer: cust._id, elastics: [el._id] });
    const lot = await YarnLot.create({
      lotNo: 'D-4471', shade: 'Indigo', rawMaterial: mat._id, quantity: 500,
    });
    // Section carries the reference but no printed snapshot.
    await programme({ job, elastic: el._id, lotId: lot._id, shade: '' });

    const lots = await svc.lotsForJob(job._id);
    expect(lots[0].lotNo).toBe('D-4471');
    expect(lots[0].shade).toBe('Indigo');
  });

  test('a lot with no elastic recorded survives an elastic filter', async () => {
    // The guardrail with the most money behind it. A batch that never
    // said which elastic it warped COULD have warped the complained-of
    // one, and dropping it here would shrink the blast radius to zero
    // while looking like a clean result.
    const cust = await makeCustomer('Anand Garments');
    const [a, b] = [await makeElastic('20mm White'), await makeElastic('25mm White')];
    const { job } = await makeJob({ customer: cust._id, elastics: [a._id, b._id] });
    const jobWide = oid();
    await issue({ job, elastics: [], lotId: jobWide });          // job-wide
    await issue({ job, elastics: [b._id], lotId: oid() });        // clearly the other product

    const lots = await svc.lotsForJob(job._id, { elasticId: a._id });
    expect(lots).toHaveLength(1);
    expect(String(lots[0].yarnLot)).toBe(String(jobWide));
    expect(lots[0].attribution).toBe('job-wide');
  });

  test('a lot attributed to a different elastic is filtered out', async () => {
    const cust = await makeCustomer('Anand Garments');
    const [a, b] = [await makeElastic('20mm White'), await makeElastic('25mm White')];
    const { job } = await makeJob({ customer: cust._id, elastics: [a._id, b._id] });
    await issue({ job, elastics: [b._id], lotId: oid() });

    expect(await svc.lotsForJob(job._id, { elasticId: a._id })).toHaveLength(0);
    expect(await svc.lotsForJob(job._id, { elasticId: b._id })).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Finding everybody else
// ══════════════════════════════════════════════════════════════════
describe('jobsCarryingLots', () => {
  test('finds another job issued the same lot', async () => {
    const c1 = await makeCustomer('Anand');
    const c2 = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job: mine } = await makeJob({ customer: c1._id, elastics: [el._id] });
    const { job: theirs } = await makeJob({ customer: c2._id, elastics: [el._id] });
    const lot = oid();
    await issue({ job: mine, elastics: [el._id], lotId: lot });
    await issue({ job: theirs, elastics: [el._id], lotId: lot });

    const lots = await svc.lotsForJob(mine._id);
    const found = await svc.jobsCarryingLots(lots, { excludeJobId: mine._id });
    expect([...found.keys()]).toEqual([String(theirs._id)]);
  });

  test('matches a lot recorded only as a number, with no reference', async () => {
    // Programmes written before yarn lots became documents carry the
    // number and nothing else — and that is the OLDEST stock, which is
    // the stock most likely to be the problem. Querying ids alone would
    // silently drop precisely those.
    const c1 = await makeCustomer('Anand');
    const c2 = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job: mine } = await makeJob({ customer: c1._id, elastics: [el._id] });
    const { job: theirs } = await makeJob({ customer: c2._id, elastics: [el._id] });
    await programme({ job: mine, elastic: el._id, lotNo: 'D-4471' });
    await programme({ job: theirs, elastic: el._id, lotNo: 'D-4471' });

    const lots = await svc.lotsForJob(mine._id);
    expect(lots[0].lotNo).toBe('D-4471');
    const found = await svc.jobsCarryingLots(lots, { excludeJobId: mine._id });
    expect([...found.keys()]).toEqual([String(theirs._id)]);
  });

  test('a job sharing a plan but not the lot is not reported', async () => {
    // The $or matches a PLAN when any section holds the lot. Recording
    // the whole plan as a hit would drag in unrelated jobs; only the
    // matching section counts.
    const c1 = await makeCustomer('Anand');
    const c2 = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job: mine } = await makeJob({ customer: c1._id, elastics: [el._id] });
    const { job: theirs } = await makeJob({ customer: c2._id, elastics: [el._id] });
    await programme({ job: mine, elastic: el._id, lotId: oid() });
    await programme({ job: theirs, elastic: el._id, lotId: oid() });

    const lots = await svc.lotsForJob(mine._id);
    const found = await svc.jobsCarryingLots(lots, { excludeJobId: mine._id });
    expect(found.size).toBe(0);
  });

  test('the complained-of job is never in its own blast radius', async () => {
    const c1 = await makeCustomer('Anand');
    const el = await makeElastic();
    const { job: mine } = await makeJob({ customer: c1._id, elastics: [el._id] });
    const lot = oid();
    await issue({ job: mine, elastics: [el._id], lotId: lot });

    const lots = await svc.lotsForJob(mine._id);
    const found = await svc.jobsCarryingLots(lots, { excludeJobId: mine._id });
    expect(found.size).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  How exposed each of them is — the split that carries the value
// ══════════════════════════════════════════════════════════════════
describe('classifyExposure', () => {
  test('a job with no challan is in-house and certainly so', async () => {
    const c = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job } = await makeJob({ customer: c._id, elastics: [el._id] });

    const [row] = await svc.classifyExposure([job._id]);
    expect(row.exposure).toBe('inHouse');
    expect(row.certain).toBe(true);
    expect(row.customerName).toBe('Bharat');
  });

  test('the job and order numbers actually arrive', async () => {
    // Written after finding that every one of them was undefined. The
    // field is auto-incremented as `jobOrderNo`; the select asked for
    // `jobNo`, which mongoose answers with nothing rather than an error.
    // Every row said "Job" with no number and no test noticed, because
    // the assertions were all about customers and buckets.
    const c = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job, order } = await makeJob({ customer: c._id, elastics: [el._id] });

    const [row] = await svc.classifyExposure([job._id]);
    expect(row.jobNo).toBe(job.jobOrderNo);
    expect(row.jobNo).toEqual(expect.any(Number));
    expect(row.orderNo).toBe(order.orderNo);
    expect(row.orderNo).toEqual(expect.any(Number));
  });

  test('the complained-of job carries its number into the report head', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const { job } = await makeJob({ customer: c._id, elastics: [el._id] });
    const comp = await fileComplaint({ customer: c._id, job, elastic: el._id });

    const out = await svc.trace(comp._id);
    expect(out.complaint.jobNo).toBe(job.jobOrderNo);
    expect(out.complaint.jobNo).toEqual(expect.any(Number));
  });

  test('a delivered challan for the job\'s product makes it delivered', async () => {
    const c = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job, order } = await makeJob({ customer: c._id, elastics: [el._id] });
    await challan({ order, customerName: 'Bharat', elastic: el._id, status: 'delivered' });

    const [row] = await svc.classifyExposure([job._id]);
    expect(row.exposure).toBe('delivered');
    expect(row.challans).toHaveLength(1);
  });

  test('dispatched but not delivered is in transit, and kept separate', async () => {
    const c = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job, order } = await makeJob({ customer: c._id, elastics: [el._id] });
    await challan({ order, customerName: 'Bharat', elastic: el._id, status: 'dispatched' });

    const [row] = await svc.classifyExposure([job._id]);
    expect(row.exposure).toBe('inTransit');
  });

  test('a draft challan has not shipped anything', async () => {
    const c = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job, order } = await makeJob({ customer: c._id, elastics: [el._id] });
    await challan({ order, customerName: 'Bharat', elastic: el._id, status: 'draft' });

    const [row] = await svc.classifyExposure([job._id]);
    expect(row.exposure).toBe('inHouse');
  });

  test('a challan for a DIFFERENT product on the same order does not count', async () => {
    // The challan links to the order, not the job. An order's challan
    // for another elastic says nothing about whether this job shipped,
    // and counting it would mark a containable job as already gone —
    // which is the version of this mistake that loses the containment.
    const c = await makeCustomer('Bharat');
    const [mine, other] = [await makeElastic('20mm'), await makeElastic('25mm')];
    const { job, order } = await makeJob({ customer: c._id, elastics: [mine._id] });
    await challan({ order, customerName: 'Bharat', elastic: other._id, status: 'delivered' });

    const [row] = await svc.classifyExposure([job._id]);
    expect(row.exposure).toBe('inHouse');
  });

  test('two jobs on one order for the same product are marked uncertain', async () => {
    // The one thing the data genuinely cannot resolve. A challan names
    // the order and the product but not the job, so when the order
    // carries two jobs for that product the challan belongs to one of
    // them unknowably. Reported, not guessed.
    const c = await makeCustomer('Bharat');
    const el = await makeElastic();
    const order = await Order.create({
      customer: c._id, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
      elastics: [{ elastic: el._id, quantity: 2000 }],
    });
    const mk = () => JobOrder.create({
      order: order._id, customer: c._id, date: new Date(), status: 'weaving',
      elastics: [{ elastic: el._id, quantity: 1000 }],
    });
    const j1 = await mk();
    const j2 = await mk();
    await challan({ order, customerName: 'Bharat', elastic: el._id, status: 'delivered' });

    const rows = await svc.classifyExposure([j1._id, j2._id]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.exposure).toBe('delivered');
      expect(r.certain).toBe(false);
    }
  });

  test('a challan naming a product unique to this job is NOT hedged', async () => {
    // The narrowing of `certain`. This job carries a product only it has
    // (mine) and one the sibling job also has (shared). The challan names
    // only `mine`, so it can only be this job's goods — hedging here
    // would be a caveat on a fact the data settles, and a flag that
    // fires when it need not is one people learn to read past.
    const c = await makeCustomer('Bharat');
    const mine = await makeElastic('20mm');
    const shared = await makeElastic('25mm');
    const order = await Order.create({
      customer: c._id, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
      elastics: [{ elastic: mine._id, quantity: 1000 }, { elastic: shared._id, quantity: 1000 }],
    });
    const j1 = await JobOrder.create({
      order: order._id, customer: c._id, date: new Date(), status: 'completed',
      elastics: [{ elastic: mine._id, quantity: 1000 }, { elastic: shared._id, quantity: 500 }],
    });
    await JobOrder.create({
      order: order._id, customer: c._id, date: new Date(), status: 'completed',
      elastics: [{ elastic: shared._id, quantity: 500 }],
    });
    await challan({ order, customerName: 'Bharat', elastic: mine._id, status: 'delivered' });

    const rows = await svc.classifyExposure([j1._id]);
    expect(rows[0].exposure).toBe('delivered');
    expect(rows[0].certain).toBe(true);
  });

  test('a challan naming the SHARED product is hedged', async () => {
    // The same setup, with the challan naming the product both jobs
    // carry. Now it genuinely could be either one's goods.
    const c = await makeCustomer('Bharat');
    const mine = await makeElastic('20mm');
    const shared = await makeElastic('25mm');
    const order = await Order.create({
      customer: c._id, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
      elastics: [{ elastic: shared._id, quantity: 2000 }],
    });
    const j1 = await JobOrder.create({
      order: order._id, customer: c._id, date: new Date(), status: 'completed',
      elastics: [{ elastic: mine._id, quantity: 1000 }, { elastic: shared._id, quantity: 500 }],
    });
    await JobOrder.create({
      order: order._id, customer: c._id, date: new Date(), status: 'completed',
      elastics: [{ elastic: shared._id, quantity: 500 }],
    });
    await challan({ order, customerName: 'Bharat', elastic: shared._id, status: 'delivered' });

    const rows = await svc.classifyExposure([j1._id]);
    expect(rows[0].certain).toBe(false);
  });

  test('a finished job that has not shipped is flagged as still pullable', async () => {
    const c = await makeCustomer('Bharat');
    const el = await makeElastic();
    const { job } = await makeJob({ customer: c._id, elastics: [el._id], status: 'completed' });

    const [row] = await svc.classifyExposure([job._id]);
    expect(row.exposure).toBe('inHouse');
    expect(row.finishedNotShipped).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
//  End to end
// ══════════════════════════════════════════════════════════════════
describe('trace', () => {
  test('one complaint reaches the other customers holding the same lot', async () => {
    const mineCust  = await makeCustomer('Anand');
    const shipped   = await makeCustomer('Bharat');
    const onFloor   = await makeCustomer('Chandra');
    const el = await makeElastic('20mm Knitted White');
    const lot = oid();

    const { job: mine } = await makeJob({ customer: mineCust._id, elastics: [el._id] });
    await issue({ job: mine, elastics: [el._id], lotId: lot });

    const { job: theirs, order: theirOrder } =
      await makeJob({ customer: shipped._id, elastics: [el._id], status: 'completed' });
    await issue({ job: theirs, elastics: [el._id], lotId: lot });
    await challan({ order: theirOrder, customerName: 'Bharat', elastic: el._id, status: 'delivered' });

    const { job: pending } = await makeJob({ customer: onFloor._id, elastics: [el._id] });
    await programme({ job: pending, elastic: el._id, lotId: lot });

    const c = await fileComplaint({ customer: mineCust._id, job: mine, elastic: el._id });
    const out = await svc.trace(c._id);

    expect(out.ok).toBe(true);
    expect(out.summary.lots).toBe(1);
    expect(out.summary.otherJobs).toBe(2);
    expect(out.summary.otherCustomers).toBe(2);
    expect(out.exposure.delivered.map((r) => r.customerName)).toEqual(['Bharat']);
    expect(out.exposure.inHouse.map((r) => r.customerName)).toEqual(['Chandra']);
    // The containable one is programmed, not issued — the yarn has not
    // come off the rack and the programme can still be changed.
    expect(out.exposure.inHouse[0].via).toContain('planned');
  });

  test('a job with no lot recorded says so, and does not imply safety', async () => {
    const cust = await makeCustomer('Anand');
    const el = await makeElastic();
    const { job } = await makeJob({ customer: cust._id, elastics: [el._id] });
    const c = await fileComplaint({ customer: cust._id, job, elastic: el._id });

    const out = await svc.trace(c._id);
    expect(out.ok).toBe(true);
    expect(out.summary.otherJobs).toBe(0);
    // "Nothing to trace" and "nobody else is affected" are different
    // claims, and only one of them is supported.
    expect(out.caveats.join(' ')).toMatch(/not evidence that no other order is affected/i);
  });

  test('an unknown complaint is reported, not thrown', async () => {
    const out = await svc.trace(oid());
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not-found');
  });

  test('the uncertainty caveat appears whenever a row is uncertain', async () => {
    const mineCust = await makeCustomer('Anand');
    const other    = await makeCustomer('Bharat');
    const el = await makeElastic();
    const lot = oid();

    const { job: mine } = await makeJob({ customer: mineCust._id, elastics: [el._id] });
    await issue({ job: mine, elastics: [el._id], lotId: lot });

    const order = await Order.create({
      customer: other._id, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
      elastics: [{ elastic: el._id, quantity: 2000 }],
    });
    const mk = () => JobOrder.create({
      order: order._id, customer: other._id, date: new Date(), status: 'completed',
      elastics: [{ elastic: el._id, quantity: 1000 }],
    });
    const j1 = await mk();
    const j2 = await mk();
    await issue({ job: j1, elastics: [el._id], lotId: lot });
    await issue({ job: j2, elastics: [el._id], lotId: lot });
    await challan({ order, customerName: 'Bharat', elastic: el._id, status: 'delivered' });

    const c = await fileComplaint({ customer: mineCust._id, job: mine, elastic: el._id });
    const out = await svc.trace(c._id);

    expect(out.summary.uncertain).toBe(2);
    expect(out.caveats.join(' ')).toMatch(/marked uncertain/i);
  });
});
