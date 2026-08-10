'use strict';
// ══════════════════════════════════════════════════════════════════
//  EXCESS PLANNING ON A JOB ORDER
//
//  A job used to be refused the moment it planned past what the order
//  had left. A line may now go to 120% of what was ORDERED freely, and
//  past that with a reason.
//
//  The part worth testing hardest is not the percentage. It is the
//  yarn: approval drew material for the ORDERED quantity and no more,
//  so every excess meter is material nobody deducted. If the draw is
//  wrong, stock on the screen stops matching stock on the rack — and
//  nothing on the floor tells you until a job runs out mid-beam.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { computeMaterialRequirement } = require('../../utils/materialRequirement');

let mongo, app, M = {}, admin;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];
const adminCookie = () => cookie(admin._id, 'admin');

let seq = 0;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Order', 'JobOrder', 'Customer', 'Elastic', 'RawMaterial']) {
    M[n] = require(`../../models/${n}.js`);
  }
  M.MaterialOutward = require('../../models/MaterialOut.cjs');

  admin = await M.User.create({
    name: 'Owner', email: 'excess-owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// ── Fixtures ─────────────────────────────────────────────────────
// An elastic with a real recipe, so the material requirement for the
// excess is a real number rather than an empty array.
async function makeElastic(stockKg = 1000) {
  const nylon = await M.RawMaterial.create({
    name: `Nylon ${++seq}`, category: 'yarn', price: 300, stock: stockKg,
  });
  const spandex = await M.RawMaterial.create({
    name: `Spandex ${seq}`, category: 'spandex', price: 900, stock: stockKg,
  });
  const elastic = await M.Elastic.create({
    name: `Elastic ${seq}`, weaveType: '8', spandexEnds: 40,
    pick: 30, noOfHook: 12, weight: 5,
    warpYarn: [{ id: nylon._id, ends: 40, weight: 4 }],
    warpSpandex: { id: spandex._id, ends: 40, weight: 1 },
  });
  return { elastic, nylon, spandex };
}

async function makeOrder(elastic, quantity = 1000) {
  const customer = await M.Customer.create({
    name: `C${++seq}`, contactName: 'X', phoneNumber: '9000000001',
  });
  const order = await M.Order.create({
    date: new Date('2026-05-01'), po: `PO-${seq}`, customer: customer._id,
    supplyDate: new Date('2026-07-15'), status: 'Approved',
    elasticOrdered: [{ elastic: elastic._id, quantity, rate: 10 }],
    pendingElastic: [{ elastic: elastic._id, quantity }],
    producedElastic: [{ elastic: elastic._id, quantity: 0 }],
    packedElastic: [{ elastic: elastic._id, quantity: 0 }],
  });
  return order;
}

const createJob = (order, elastic, quantity, extra = {}) =>
  request(app).post('/api/v2/job/create').set('Cookie', adminCookie()).send({
    orderId: String(order._id), date: '2026-05-03',
    elastics: [{ elastic: String(elastic._id), quantity }],
    ...extra,
  });

const stockOf = async (id) => (await M.RawMaterial.findById(id).lean()).stock;

// ══════════════════════════════════════════════════════════════════
describe('the 20% allowance', () => {
  test('planning exactly the ordered quantity is unchanged', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    const res = await createJob(order, elastic, 1000);
    expect(res.status).toBe(201);
  });

  test('planning 20% over needs no reason', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    const res = await createJob(order, elastic, 1200);
    expect(res.status).toBe(201);
  });

  test('planning 20.1% over is refused without a reason, and names the line', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    const res = await createJob(order, elastic, 1201);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXCESS_PLANNING_REASON_REQUIRED');
    expect(res.body.message).toMatch(/needs a reason/i);
    expect(res.body.message).toMatch(elastic.name);
    expect(res.body.message).toMatch(/201 m over/);
    // And nothing was created.
    expect(await M.JobOrder.countDocuments({ order: order._id })).toBe(0);
  });

  test('the same request with a reason goes through', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    const res = await createJob(order, elastic, 1500, {
      excessReason: 'Loom set for a full beam; customer accepts the overrun.',
    });
    expect(res.status).toBe(201);
  });

  test('a token reason is not a reason', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    const res = await createJob(order, elastic, 1500, { excessReason: 'ok' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXCESS_PLANNING_REASON_REQUIRED');
  });

  // The allowance is against the ORDER, not against what is left, so
  // two jobs inside it must not add up to 40% over.
  test('two jobs cannot each spend the allowance', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);

    const first = await createJob(order, elastic, 1100);
    expect(first.status).toBe(201);

    const second = await createJob(order, elastic, 200);   // 1300 total = 30%
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('EXCESS_PLANNING_REASON_REQUIRED');
  });

  test('an elastic that is not on the order is still refused', async () => {
    const { elastic } = await makeElastic();
    const other = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    const res = await createJob(order, other.elastic, 100);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not part of this order/i);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('the yarn the excess needs', () => {
  test('is deducted from stock, and only for the EXCESS meters', async () => {
    const { elastic, nylon, spandex } = await makeElastic(1000);
    const order = await makeOrder(elastic, 1000);

    const before = { nylon: await stockOf(nylon._id), spandex: await stockOf(spandex._id) };
    // What 200 excess meters need — computed independently of the route.
    const expected = await computeMaterialRequirement([{ elastic: elastic._id, quantity: 200 }]);
    expect(expected.length).toBeGreaterThan(0);

    const res = await createJob(order, elastic, 1200);
    expect(res.status).toBe(201);

    for (const r of expected) {
      const after = await stockOf(r.rawMaterial);
      const wasBefore = String(r.rawMaterial) === String(nylon._id) ? before.nylon : before.spandex;
      expect(after).toBeCloseTo(wasBefore - r.requiredWeight, 3);
    }
  });

  test('no excess draws no yarn at all', async () => {
    const { elastic, nylon } = await makeElastic(1000);
    const order = await makeOrder(elastic, 1000);
    const before = await stockOf(nylon._id);

    const res = await createJob(order, elastic, 800);
    expect(res.status).toBe(201);
    expect(await stockOf(nylon._id)).toBe(before);
  });

  test('the draw is booked against the job, at the price it left at', async () => {
    const { elastic, nylon } = await makeElastic(1000);
    const order = await makeOrder(elastic, 1000);
    const res = await createJob(order, elastic, 1200);

    // The create response nests the job under `data`; an undefined id
    // here would make the query match every row in the database.
    const jobId = res.body.data.job._id;
    expect(jobId).toBeTruthy();
    const rows = await M.MaterialOutward.find({ job: jobId }).lean();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.type).toBe('JOB_CONSUMPTION');
      expect(row.unitPrice).toBeGreaterThan(0);
      expect(row.remarks).toMatch(/Excess planning/);
    }
    const nylonRow = rows.find((r) => String(r.rawMaterial) === String(nylon._id));
    expect(nylonRow.unitPrice).toBe(300);
  });

  // The whole point of the stock guard: a job must never reach the
  // floor on yarn that was not there.
  test('refuses the job when the excess yarn is short, and names the shortfall', async () => {
    const { elastic, nylon } = await makeElastic(0.5);   // almost nothing
    const order = await makeOrder(elastic, 1000);

    const res = await createJob(order, elastic, 1200);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK_FOR_EXCESS');
    expect(res.body.message).toMatch(/short by/i);
    expect(await M.JobOrder.countDocuments({ order: order._id })).toBe(0);
  });

  test('a refused job leaves stock exactly as it was', async () => {
    const { elastic, nylon, spandex } = await makeElastic(0.5);
    const order = await makeOrder(elastic, 1000);
    const before = { n: await stockOf(nylon._id), s: await stockOf(spandex._id) };

    await createJob(order, elastic, 1200);

    expect(await stockOf(nylon._id)).toBe(before.n);
    expect(await stockOf(spandex._id)).toBe(before.s);
  });

  test("the order's material requirement is restated for what is now planned", async () => {
    const { elastic } = await makeElastic(5000);
    const order = await makeOrder(elastic, 1000);
    const before = await M.Order.findById(order._id).lean();

    await createJob(order, elastic, 1200);

    const after = await M.Order.findById(order._id).lean();
    const expected = await computeMaterialRequirement([{ elastic: elastic._id, quantity: 1200 }]);
    for (const r of expected) {
      const line = after.rawMaterialRequired.find(
        (x) => String(x.rawMaterial) === String(r.rawMaterial));
      expect(line.requiredWeight).toBeCloseTo(r.requiredWeight, 3);
    }
    expect(after.rawMaterialRequired).not.toEqual(before.rawMaterialRequired);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('what the order detail page is told', () => {
  const detail = (id) =>
    request(app).get(`/api/v2/order/get-orderDetail?id=${id}`).set('Cookie', adminCookie());

  test('an order with no excess carries an empty list, not a missing field', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    await createJob(order, elastic, 900);

    const res = await detail(order._id);
    expect(res.status).toBe(200);
    expect(res.body.data.excessPlanning).toEqual([]);
  });

  test('an excess inside the allowance is listed, with no reason', async () => {
    const { elastic } = await makeElastic();
    const order = await makeOrder(elastic, 1000);
    await createJob(order, elastic, 1150);

    const [row] = (await detail(order._id)).body.data.excessPlanning;
    expect(row).toMatchObject({
      name: elastic.name,
      orderedQuantity: 1000,
      plannedQuantity: 1150,
      excessQuantity: 150,
      excessPct: 15,
      // Never asked for, so empty — which is different from withheld.
      reason: '',
    });
    expect(row.jobNo).toMatch(/^J-\d+$/);
  });

  test('an excess past the allowance carries the reason that was given', async () => {
    const { elastic } = await makeElastic(5000);
    const order = await makeOrder(elastic, 1000);
    const reason = 'Loom set for a full beam; the customer takes the overrun.';
    await createJob(order, elastic, 1500, { excessReason: reason });

    const [row] = (await detail(order._id)).body.data.excessPlanning;
    expect(row.reason).toBe(reason);
    expect(row.excessQuantity).toBe(500);
    expect(row.excessPct).toBe(50);
  });

  test('the yarn the excess drew is listed against it', async () => {
    const { elastic } = await makeElastic(5000);
    const order = await makeOrder(elastic, 1000);
    await createJob(order, elastic, 1200);

    const [row] = (await detail(order._id)).body.data.excessPlanning;
    expect(row.materialsDrawn.length).toBeGreaterThan(0);
    for (const m of row.materialsDrawn) {
      expect(m.name).toBeTruthy();
      expect(m.quantity).toBeGreaterThan(0);
    }
  });

  // Two jobs can each over-plan the same elastic, and an order detail
  // that showed only the latest would hide the first decision.
  test('a second excess is appended, not overwritten', async () => {
    const { elastic } = await makeElastic(9000);
    const order = await makeOrder(elastic, 1000);
    await createJob(order, elastic, 1100);
    await createJob(order, elastic, 500, {
      excessReason: 'Second beam added after the customer raised the quantity.',
    });

    const rows = (await detail(order._id)).body.data.excessPlanning;
    expect(rows).toHaveLength(2);
    expect(rows[0].reason).toBe('');
    expect(rows[1].reason).toMatch(/Second beam/);
  });
});

// ══════════════════════════════════════════════════════════════════
//  WHEN THE JOB ITSELF FAILS
//
//  The yarn comes off the shelf before the job exists — deliberately,
//  so a job can never reach the floor on stock that was not there. But
//  everything between that deduction and the records explaining it used
//  to be outside any guard: the job created, then a warping programme,
//  then a covering programme, then the order saved, and only then the
//  outward rows and the ledger. A throw anywhere in that stretch took
//  the yarn with it — stock down, nothing anywhere to say where it went,
//  and no refund.
//
//  This route cannot use a transaction (it runs on a standalone mongod
//  here, and in production the same code path must work either way), so
//  the guarantee is compensation: either the yarn is booked to a job, or
//  it goes back on the shelf.
// ══════════════════════════════════════════════════════════════════
describe('a job that fails after the yarn has been drawn', () => {
  test('puts the yarn back rather than losing it', async () => {
    const { elastic, nylon, spandex } = await makeElastic(1000);
    const order = await makeOrder(elastic, 1000);
    const before = { n: await stockOf(nylon._id), s: await stockOf(spandex._id) };

    // Fail the job insert itself — the first thing after the draw.
    const boom = jest
      .spyOn(M.JobOrder, 'create')
      .mockRejectedValueOnce(new Error('write conflict'));

    const res = await createJob(order, elastic, 1200);
    expect(res.status).toBeGreaterThanOrEqual(400);

    expect(await stockOf(nylon._id)).toBe(before.n);
    expect(await stockOf(spandex._id)).toBe(before.s);
    // And no orphan job, obviously.
    expect(await M.JobOrder.countDocuments({ order: order._id })).toBe(0);
    boom.mockRestore();
  });

  test('leaves no outward row for yarn that went back', async () => {
    // A refund with a consumption row still standing would be worse
    // than the original fault: the P&L would charge the order for yarn
    // that is on the shelf.
    const { elastic, nylon } = await makeElastic(1000);
    const order = await makeOrder(elastic, 1000);
    const boom = jest
      .spyOn(M.JobOrder, 'create')
      .mockRejectedValueOnce(new Error('write conflict'));

    await createJob(order, elastic, 1200);

    // Scoped to this test's own material: the suite shares a database
    // across cases, so an unscoped count would read every other job's
    // rows and pass — or fail — for reasons that have nothing to do
    // with what is being tested here.
    expect(await M.MaterialOutward.countDocuments({ rawMaterial: nylon._id })).toBe(0);
    boom.mockRestore();
  });

  test('restores the consumption counter too, not just the stock', async () => {
    const { elastic, nylon } = await makeElastic(1000);
    const order = await makeOrder(elastic, 1000);
    const before = (await M.RawMaterial.findById(nylon._id).lean()).totalConsumption || 0;
    const boom = jest
      .spyOn(M.JobOrder, 'create')
      .mockRejectedValueOnce(new Error('write conflict'));

    await createJob(order, elastic, 1200);

    const after = (await M.RawMaterial.findById(nylon._id).lean()).totalConsumption || 0;
    expect(after).toBe(before);
    boom.mockRestore();
  });

  test('books the draw before the warping programme can fail', async () => {
    // The booking used to run at the very end of the route. Moving it
    // to directly after the job exists is what shrinks the window to
    // nothing — so a failure this late leaves the yarn explained.
    const Warping = require('../../models/Warping.js');
    const { elastic, nylon } = await makeElastic(1000);
    const order = await makeOrder(elastic, 1000);
    const boom = jest
      .spyOn(Warping, 'create')
      .mockRejectedValueOnce(new Error('warping blew up'));

    const res = await createJob(order, elastic, 1200);
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Stock is down — the job exists, so that is correct — and there is
    // a row saying so on both records.
    const rows = await M.MaterialOutward.find({
      rawMaterial: nylon._id, type: 'JOB_CONSUMPTION',
    }).lean();
    expect(rows.length).toBeGreaterThan(0);
    const doc = await M.RawMaterial.findById(nylon._id).select('+stockMovements').lean();
    const move = doc.stockMovements.at(-1);
    expect(move.type).toBe('JOB_CONSUMPTION');
    expect(move.quantity).toBeLessThan(0);
    expect(doc.stock).toBe(move.balance);
    boom.mockRestore();
  });
});
