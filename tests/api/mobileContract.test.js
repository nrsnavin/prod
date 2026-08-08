'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE CONTRACT THE FLUTTER APP PARSES
//
//  The mobile models in nrsnavin/flu are hand-written `fromJson`
//  factories against these responses. Nothing in that repo compiles
//  here — there is no Dart toolchain and no pubspec.yaml in the
//  checkout — so a renamed field on this side does not break a build.
//  It produces a screen of dashes on somebody's phone, and it does it
//  silently, because every one of those factories defaults a missing
//  key rather than throwing.
//
//  This file is the guard for that. Each block lists the exact keys one
//  Dart model reads, names the file it lives in, and asserts the server
//  still sends them. It is deliberately about NAMES and NULLS rather
//  than about values — the arithmetic is already covered by
//  orderPnl.test.js, lotLedger.test.js, elasticHistory.test.js and the
//  rest. What is not covered anywhere else is "did the key survive".
//
//  The null assertions matter as much as the key assertions. Several of
//  these fields are null-when-unknown on purpose — an unpriced order's
//  margin, a planned lot's quantity — and the Dart side keeps the null
//  so the screen can print "—". A server that starts sending 0 there
//  would not fail any test about keys, and would quietly turn "we never
//  priced this" into "this made nothing".
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, admin;
let RawMaterial, Supplier, PurchaseOrder, YarnLot, WarpingBatch, Warping,
  WarpingPlan, JobOrder, Customer, Elastic, Order, Machine, CostSettings, User;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

/**
 * Assert every key a Dart `fromJson` reads is present on the object.
 *
 * Presence, not truthiness: a legitimately-null field still has to be
 * SENT, because `j['x']` on an absent key and on an explicit null are
 * the same thing to Dart but very different things to whoever renamed
 * it. Reported all at once — finding one missing key per run when six
 * were renamed together is a poor way to spend an afternoon.
 */
function hasKeys(obj, keys, where) {
  const missing = keys.filter((k) => !(k in (obj || {})));
  expect({ where, missing }).toEqual({ where, missing: [] });
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  RawMaterial   = require('../../models/RawMaterial');
  Supplier      = require('../../models/Supplier');
  PurchaseOrder = require('../../models/PurchaseOrder');
  YarnLot       = require('../../models/YarnLot');
  WarpingBatch  = require('../../models/WarpingBatch');
  Warping       = require('../../models/Warping');
  WarpingPlan   = require('../../models/WarpingPlan');
  JobOrder      = require('../../models/JobOrder');
  Customer      = require('../../models/Customer');
  Elastic       = require('../../models/Elastic');
  Order         = require('../../models/Order');
  Machine       = require('../../models/Machine');
  CostSettings  = require('../../models/CostSettings');
  User          = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

// ── Fixtures ──────────────────────────────────────────────────────

async function yarnWithLot({ quantity = 100, lotNo = 'D-4471' } = {}) {
  const supplier = await Supplier.create({ name: 'Kumar Yarns', phoneNumber: '9000000001' });
  const yarn = await RawMaterial.create({
    name: 'Nylon 70D', category: 'Yarn', stock: 0, price: 300, supplier: supplier._id,
  });
  const po = await PurchaseOrder.create({
    poNo: Math.floor(Math.random() * 100000), supplier: supplier._id, status: 'Open',
    items: [{ rawMaterial: yarn._id, quantity: 1000, price: 300, receivedQuantity: 0 }],
  });
  const res = await request(app).post('/api/v2/supplier/inward-stock')
    .set('Cookie', adminCookie())
    .send({
      poId: String(po._id),
      items: [{ rawMaterial: String(yarn._id), quantity, lotNo, shade: 'Ecru' }],
    });
  expect(res.status).toBeLessThan(400);
  const lot = await YarnLot.findOne({ lotNo });
  expect(lot).toBeTruthy();
  return { supplier, yarn, lot };
}

async function elasticOn(yarn) {
  return Elastic.create({
    name: `E-${Math.random().toString(36).slice(2, 8)}`,
    weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    warpYarn: [{ id: yarn._id, ends: 120, weight: 2.4 }],
  });
}

/** An order, its job, and the warping the job hangs off. */
async function jobWithWarping(yarn, elastic) {
  const customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000002',
  });
  const order = await Order.create({
    orderNo: Math.floor(Math.random() * 1000000),
    customer: customer._id, status: 'Approved', po: 'PO-9',
    date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 12 }],
  });
  const job = await JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'preparatory',
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
    producedElastic: [{ elastic: elastic._id, quantity: 400 }],
  });
  const warping = await Warping.create({
    date: new Date(), job: job._id, status: 'open',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000 }],
  });
  return { customer, order, job, warping };
}

// ══════════════════════════════════════════════════════════════════
//  1. WARPING PLAN CONTEXT — the lot picker's whole input
//     flu: src/features/Warping/models/models.dart
//          YarnLotStock.fromJson / LotOption.fromJson
// ══════════════════════════════════════════════════════════════════

const LOT_STOCK_KEYS = ['warpYarnId', 'warpYarnName', 'lots', 'totalAvailable', 'largestLot'];
const LOT_OPTION_KEYS = ['id', 'lotNo', 'shade', 'balance'];

describe('GET /warping/plan-context/:jobId — what the lot picker reads', () => {
  it('sends lotStock with the keys YarnLotStock and LotOption parse', async () => {
    const { yarn, lot } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { job } = await jobWithWarping(yarn, elastic);

    const { body, status } = await request(app)
      .get(`/api/v2/warping/plan-context/${job._id}`).set('Cookie', adminCookie());
    expect(status).toBe(200);

    expect(Array.isArray(body.lotStock)).toBe(true);
    const row = body.lotStock.find((r) => String(r.warpYarnId) === String(yarn._id));
    expect(row).toBeTruthy();
    hasKeys(row, LOT_STOCK_KEYS, 'lotStock[]');
    hasKeys(row.lots[0], LOT_OPTION_KEYS, 'lotStock[].lots[]');

    // The two figures the picker weighs against each other. One open
    // lot means they agree; that they are BOTH present and both the
    // balance is the point — a picker showing only the total cannot
    // answer "can this beam come off one lot".
    expect(row.totalAvailable).toBe(100);
    expect(row.largestLot).toBe(100);
    expect(String(row.lots[0].id)).toBe(String(lot._id));
  });

  it('separates total from largest once a yarn has two lots', async () => {
    const { supplier, yarn } = await yarnWithLot({ quantity: 60, lotNo: 'D-1' });
    const po = await PurchaseOrder.create({
      poNo: 771, supplier: supplier._id, status: 'Open',
      items: [{ rawMaterial: yarn._id, quantity: 1000, price: 300, receivedQuantity: 0 }],
    });
    await request(app).post('/api/v2/supplier/inward-stock').set('Cookie', adminCookie())
      .send({
        poId: String(po._id),
        items: [{ rawMaterial: String(yarn._id), quantity: 40, lotNo: 'D-2', shade: 'Ecru' }],
      });

    const elastic = await elasticOn(yarn);
    const { job } = await jobWithWarping(yarn, elastic);

    const { body } = await request(app)
      .get(`/api/v2/warping/plan-context/${job._id}`).set('Cookie', adminCookie());
    const row = body.lotStock.find((r) => String(r.warpYarnId) === String(yarn._id));

    // 100 kg over two lots is a different thing from 100 kg on one, and
    // this is the pair of numbers that says so.
    expect(row.totalAvailable).toBe(100);
    expect(row.largestLot).toBe(60);
    expect(row.lots).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. THE PLAN'S SECTIONS — lot in, lot back out
//     flu: WarpingBeamSectionDetail.fromJson / EditableBeamSection.toJson
// ══════════════════════════════════════════════════════════════════

describe('warping plan sections carry the lot the phone sent', () => {
  it('accepts yarnLot on a section and reads it back with lotNo and shade', async () => {
    const { yarn, lot } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { warping } = await jobWithWarping(yarn, elastic);

    // Exactly the body EditableBeam.toJson builds.
    const created = await request(app).post('/api/v2/warping/warpingPlan/create')
      .set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id),
        beams: [{
          beamNo: 1, totalEnds: 120,
          sections: [{ warpYarn: String(yarn._id), ends: 120, yarnLot: String(lot._id) }],
        }],
      });
    expect(created.status).toBe(201);

    const section = created.body.plan.beams[0].sections[0];
    hasKeys(section, ['warpYarn', 'ends', 'yarnLot', 'lotNo', 'shade'], 'plan section');
    // The snapshot, not just the reference: it is what the programme
    // sheet prints and it outlives the lot record.
    expect(section.lotNo).toBe('D-4471');
    expect(section.shade).toBe('Ecru');
  });

  it('omitting yarnLot leaves the section open rather than failing', async () => {
    // The phone omits the key entirely when the picker says "Not
    // decided". Sending "" instead used to sink the whole plan.
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { warping } = await jobWithWarping(yarn, elastic);

    const created = await request(app).post('/api/v2/warping/warpingPlan/create')
      .set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id),
        beams: [{
          beamNo: 1, totalEnds: 120,
          sections: [{ warpYarn: String(yarn._id), ends: 120 }],
        }],
      });
    expect(created.status).toBe(201);
    const section = created.body.plan.beams[0].sections[0];
    expect(section.yarnLot ?? null).toBeNull();
    expect(section.lotNo).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. WARPING BATCHES
//     flu: WarpingBatchModel.fromJson / BatchAllocation.fromJson+toJson
// ══════════════════════════════════════════════════════════════════

const BATCH_KEYS = [
  '_id', 'batchNo', 'status', 'beamNos', 'elastics', 'allocations', 'remarks',
];
const ALLOCATION_KEYS = ['rawMaterial', 'yarnLot', 'lotNo', 'shade', 'materialName', 'quantity'];

describe('warping batches — what the phone sends and reads', () => {
  async function planned() {
    const { yarn, lot } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { warping, job } = await jobWithWarping(yarn, elastic);
    await request(app).post('/api/v2/warping/warpingPlan/create').set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id),
        beams: [
          { beamNo: 1, totalEnds: 120, sections: [{ warpYarn: String(yarn._id), ends: 120 }] },
          { beamNo: 2, totalEnds: 120, sections: [{ warpYarn: String(yarn._id), ends: 120 }] },
        ],
      });
    return { yarn, lot, elastic, warping, job };
  }

  it('takes the create body BatchAllocation.toJson builds', async () => {
    const { yarn, lot, warping } = await planned();

    const res = await request(app).post('/api/v2/warping/batch/create')
      .set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id),
        beamNos: [1],
        // Exactly the three keys toJson sends — no lotNo, no shade, no
        // materialName. Those are the server's to snapshot.
        allocations: [{
          rawMaterial: String(yarn._id), yarnLot: String(lot._id), quantity: 25,
        }],
        remarks: 'first sitting',
      });
    expect(res.status).toBe(201);
    hasKeys(res.body.batch, BATCH_KEYS, 'batch');
    hasKeys(res.body.batch.allocations[0], ALLOCATION_KEYS, 'batch.allocations[]');
    expect(res.body.batch.allocations[0].lotNo).toBe('D-4471');
    expect(res.body.batch.allocations[0].materialName).toBe('Nylon 70D');
  });

  it('lists batches with the elastic populated as { name }', async () => {
    const { yarn, lot, warping } = await planned();
    await request(app).post('/api/v2/warping/batch/create').set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id), beamNos: [1],
        allocations: [{ rawMaterial: String(yarn._id), yarnLot: String(lot._id), quantity: 25 }],
      });

    const { body, status } = await request(app)
      .get('/api/v2/warping/batch/list').query({ warpingId: String(warping._id) })
      .set('Cookie', adminCookie());
    expect(status).toBe(200);
    hasKeys(body.batches[0], BATCH_KEYS, 'batch/list[]');
    // WarpingBatchModel reads e['name'] off each entry; a bare id would
    // read as an empty string and the chip would vanish.
    expect(body.batches[0].elastics[0]).toHaveProperty('name');
  });

  it('refuses a beam a live batch already holds, in words worth showing', async () => {
    const { yarn, lot, warping } = await planned();
    const first = await request(app).post('/api/v2/warping/batch/create')
      .set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id), beamNos: [1],
        allocations: [{ rawMaterial: String(yarn._id), yarnLot: String(lot._id), quantity: 25 }],
      });
    expect(first.status).toBe(201);

    const clash = await request(app).post('/api/v2/warping/batch/create')
      .set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id), beamNos: [1, 2],
        allocations: [{ rawMaterial: String(yarn._id), yarnLot: String(lot._id), quantity: 10 }],
      });
    expect(clash.status).toBe(409);
    // The phone shows `message` verbatim, so it has to name the beam.
    expect(clash.body.message).toMatch(/Beam 1/);
  });

  it('issue moves the lot balance and the picker sees it move', async () => {
    const { yarn, lot, warping, job } = await planned();
    const created = await request(app).post('/api/v2/warping/batch/create')
      .set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id), beamNos: [1],
        allocations: [{ rawMaterial: String(yarn._id), yarnLot: String(lot._id), quantity: 25 }],
      });

    const issued = await request(app)
      .post(`/api/v2/warping/batch/${created.body.batch._id}/issue`)
      .set('Cookie', adminCookie());
    expect(issued.status).toBe(200);
    expect(issued.body.batch.status).toBe('issued');
    expect(issued.body.batch).toHaveProperty('issuedDate');

    // Why the controller re-reads the context after issuing rather than
    // patching the row in place: these numbers are stale the moment a
    // batch is issued.
    const { body } = await request(app)
      .get(`/api/v2/warping/plan-context/${job._id}`).set('Cookie', adminCookie());
    const row = body.lotStock.find((r) => String(r.warpYarnId) === String(yarn._id));
    expect(row.totalAvailable).toBe(75);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. THE JOB'S LOT TRAIL
//     flu: src/features/Job/models/yarn_lot_trail.dart
// ══════════════════════════════════════════════════════════════════

const TRAIL_KEYS = ['byElastic', 'lots', 'sections', 'openBeamNos', 'hasUnattributed'];
const TRAIL_ROW_KEYS = [
  'source', 'yarnLot', 'lotNo', 'shade', 'materialName', 'beamNos',
  'quantity', 'sections', 'sharedAcross',
];

describe('GET /job/:jobId/yarn-lots — the lots-used panel', () => {
  it('sends the envelope and rows JobYarnLots parses', async () => {
    const { yarn, lot } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { warping, job } = await jobWithWarping(yarn, elastic);

    await request(app).post('/api/v2/warping/warpingPlan/create').set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id),
        beams: [{
          beamNo: 1, totalEnds: 240,
          elastic: String(elastic._id),
          sections: [
            { warpYarn: String(yarn._id), ends: 120, yarnLot: String(lot._id) },
            { warpYarn: String(yarn._id), ends: 120 }, // left open on purpose
          ],
        }],
      });

    const { body, status } = await request(app)
      .get(`/api/v2/job/${job._id}/yarn-lots`).set('Cookie', adminCookie());
    expect(status).toBe(200);
    hasKeys(body.data, TRAIL_KEYS, 'yarn-lots data');
    hasKeys(body.data.sections, ['total', 'withLot', 'open'], 'yarn-lots sections');

    // "1 of 2 sections have a lot" is the sentence the panel prints, and
    // an open section is a decision not yet made, not a fault.
    expect(body.data.sections).toMatchObject({ total: 2, withLot: 1, open: 1 });
    expect(body.data.openBeamNos).toEqual([1]);

    const row = body.data.byElastic.flatMap((g) => g.lots)[0];
    hasKeys(row, TRAIL_ROW_KEYS, 'yarn-lots row');
    hasKeys(body.data.byElastic[0], ['elasticId', 'elasticName', 'lots'], 'byElastic[]');
  });

  it('leaves a planned row quantity NULL rather than zero', async () => {
    // The panel prints "—" for this. A 0 would claim a measurement
    // nobody made: programming names the lot, it does not weigh it.
    const { yarn, lot } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { warping, job } = await jobWithWarping(yarn, elastic);
    await request(app).post('/api/v2/warping/warpingPlan/create').set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id),
        beams: [{
          beamNo: 1, totalEnds: 120, elastic: String(elastic._id),
          sections: [{ warpYarn: String(yarn._id), ends: 120, yarnLot: String(lot._id) }],
        }],
      });

    const { body } = await request(app)
      .get(`/api/v2/job/${job._id}/yarn-lots`).set('Cookie', adminCookie());
    const planned = body.data.byElastic.flatMap((g) => g.lots).find((l) => l.source === 'planned');
    expect(planned).toBeTruthy();
    expect(planned.quantity).toBeNull();
    expect(planned.sections).toBe(1);
  });

  it('keeps planned and issued as separate rows, never summed', async () => {
    const { yarn, lot } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { warping, job } = await jobWithWarping(yarn, elastic);
    await request(app).post('/api/v2/warping/warpingPlan/create').set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id),
        beams: [{
          beamNo: 1, totalEnds: 120, elastic: String(elastic._id),
          sections: [{ warpYarn: String(yarn._id), ends: 120, yarnLot: String(lot._id) }],
        }],
      });
    const created = await request(app).post('/api/v2/warping/batch/create')
      .set('Cookie', adminCookie())
      .send({
        warpingId: String(warping._id), beamNos: [1],
        allocations: [{ rawMaterial: String(yarn._id), yarnLot: String(lot._id), quantity: 25 }],
      });
    await request(app).post(`/api/v2/warping/batch/${created.body.batch._id}/issue`)
      .set('Cookie', adminCookie());

    const { body } = await request(app)
      .get(`/api/v2/job/${job._id}/yarn-lots`).set('Cookie', adminCookie());
    const rows = body.data.byElastic.flatMap((g) => g.lots);
    // One decision, one draw — two rows. Folding them together would
    // report a lot as used twice.
    expect(rows.filter((r) => r.source === 'planned')).toHaveLength(1);
    expect(rows.filter((r) => r.source === 'issued')).toHaveLength(1);
    expect(rows.find((r) => r.source === 'issued').quantity).toBe(25);
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. MACHINE SERVICE BILLS
//     flu: src/features/machines/models/service_bill.dart
//          + MachineServiceLog.billCount / billTotal
// ══════════════════════════════════════════════════════════════════

const BILL_KEYS = [
  '_id', 'machine', 'serviceLog', 'kind', 'filename', 'contentType', 'size',
  'amount', 'vendor', 'billNo', 'billDate', 'partName', 'notes', 'createdAt',
];

describe('service bills — the sheet and the rolled-up row', () => {
  async function machineWithLog() {
    const machine = await Machine.create({
      ID: 'LOOM-01', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 8, status: 'free',
    });
    const res = await request(app).post('/api/v2/machine/add-service-log')
      .set('Cookie', adminCookie())
      .send({ machineId: String(machine._id), type: 'Corrective', description: 'belt', cost: 500 });
    return { machine, logId: String(res.body.log._id) };
  }

  it('lists a bill with every key ServiceBill parses, and the totals beside it', async () => {
    const { machine, logId } = await machineWithLog();
    const up = await request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', adminCookie())
      .field('machineId', String(machine._id))
      .field('serviceLogId', logId)
      .field('kind', 'spare_bill')
      .field('amount', '750')
      .field('vendor', 'Comez Spares')
      .field('partName', 'Take-up roller bearing')
      .attach('file', Buffer.from('%PDF-1.4\n'), {
        filename: 'inv.pdf', contentType: 'application/octet-stream',
      });
    expect(up.status).toBe(201);
    hasKeys(up.body.bill, BILL_KEYS, 'service-bill create echo');
    // Never the payload: the list model has no field for it and a 5 MB
    // base64 blob per row would be a disaster on a phone data plan.
    expect(up.body.bill).not.toHaveProperty('data');

    const list = await request(app).get('/api/v2/machine/service-bills')
      .query({ machineId: String(machine._id), serviceLogId: logId })
      .set('Cookie', adminCookie());
    hasKeys(list.body, ['bills', 'count', 'totalAmount'], 'service-bills list');
    hasKeys(list.body.bills[0], BILL_KEYS, 'service-bills list[]');
    expect(list.body.bills[0]).not.toHaveProperty('data');
    expect(list.body.totalAmount).toBe(750);
  });

  it('puts billCount and billTotal on the service log itself', async () => {
    // The machine detail row reads these; without them it would need one
    // request per log to say "2 bills · ₹1,250".
    const { machine, logId } = await machineWithLog();
    for (const amount of ['750', '500']) {
      await request(app).post('/api/v2/machine/service-bill').set('Cookie', adminCookie())
        .field('machineId', String(machine._id)).field('serviceLogId', logId)
        .field('kind', 'service_bill').field('amount', amount)
        .attach('file', Buffer.from('x'), { filename: 'b.png', contentType: 'image/png' });
    }

    const { body } = await request(app).get('/api/v2/machine/get-machine-detail')
      .query({ id: String(machine._id) }).set('Cookie', adminCookie());
    const log = body.machine.serviceLogs[0];
    hasKeys(log, ['_id', 'date', 'type', 'description', 'technician', 'cost',
      'resolved', 'billCount', 'billTotal'], 'serviceLogs[]');
    expect(log.billCount).toBe(2);
    expect(log.billTotal).toBe(1250);
  });

  it('serves the file back with the content type it resolved', async () => {
    const { machine, logId } = await machineWithLog();
    const up = await request(app).post('/api/v2/machine/service-bill')
      .set('Cookie', adminCookie())
      .field('machineId', String(machine._id)).field('serviceLogId', logId)
      .field('kind', 'service_bill')
      .attach('file', Buffer.from('%PDF-1.4\n'), {
        filename: 'inv.PDF', contentType: 'application/octet-stream',
      });

    const file = await request(app)
      .get(`/api/v2/machine/service-bill/${up.body.bill._id}/file`)
      .set('Cookie', adminCookie());
    expect(file.status).toBe(200);
    // The phone writes these bytes to a temp file with this extension
    // and hands it to the OS; a wrong header means nothing opens it.
    expect(file.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('refuses to pull a running machine, and says why', async () => {
    const machine = await Machine.create({
      ID: 'LOOM-02', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 8, status: 'running',
    });
    const res = await request(app).post('/api/v2/machine/add-service-log')
      .set('Cookie', adminCookie())
      .send({
        machineId: String(machine._id), type: 'Breakdown',
        description: 'stripped down', setMaintenance: true,
      });
    // The form keeps this message on screen rather than flashing it,
    // because nothing was saved and the whole entry has to be re-sent.
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/stop the job/i);
    expect((await Machine.findById(machine._id)).serviceLogs).toHaveLength(0);
  });

  it('reports statusChanged so the phone can say what happened', async () => {
    const machine = await Machine.create({
      ID: 'LOOM-03', manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 8, status: 'free',
    });
    const res = await request(app).post('/api/v2/machine/add-service-log')
      .set('Cookie', adminCookie())
      .send({
        machineId: String(machine._id), type: 'Preventive',
        description: 'service', setMaintenance: true,
      });
    expect(res.status).toBe(201);
    hasKeys(res.body, ['log', 'status', 'statusChanged'], 'add-service-log');
    expect(res.body.statusChanged).toBe(true);
    expect(res.body.status).toBe('maintenance');
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. ELASTIC PRODUCT HISTORY
//     flu: src/features/elastic/models/elastic_history.dart
// ══════════════════════════════════════════════════════════════════

const HISTORY_ORDER_KEYS = [
  'id', 'orderNo', 'po', 'date', 'supplyDate', 'status', 'customerId',
  'customerName', 'ordered', 'produced', 'packed',
];
const HISTORY_JOB_KEYS = [
  'id', 'jobOrderNo', 'jobNo', 'date', 'status', 'orderId', 'orderNo',
  'customerName', 'planned', 'produced', 'packed', 'wastage',
];
const PAGE_KEYS = ['page', 'limit', 'total', 'hasMore'];

describe('elastic history — the keys the two tabs parse', () => {
  it('sends order rows and paging facts', async () => {
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    await jobWithWarping(yarn, elastic);

    const { body, status } = await request(app)
      .get(`/api/v2/elastic/${elastic._id}/orders`).set('Cookie', adminCookie());
    expect(status).toBe(200);
    hasKeys(body, [...PAGE_KEYS, 'orders'], 'elastic orders');
    hasKeys(body.orders[0], HISTORY_ORDER_KEYS, 'elastic orders[]');
  });

  it('sends job rows and paging facts', async () => {
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    await jobWithWarping(yarn, elastic);

    const { body } = await request(app)
      .get(`/api/v2/elastic/${elastic._id}/jobs`).set('Cookie', adminCookie());
    hasKeys(body, [...PAGE_KEYS, 'jobs'], 'elastic jobs');
    hasKeys(body.jobs[0], HISTORY_JOB_KEYS, 'elastic jobs[]');
    // The controller pages on hasMore alone; a truthy total with a
    // stuck hasMore would spin the Load-more button forever.
    expect(body.hasMore).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
//  7. ORDER P&L
//     flu: src/features/pnl/models/order_pnl.dart
// ══════════════════════════════════════════════════════════════════

const COST_KEYS = [
  'material', 'labour', 'jobWork', 'finishing', 'checking', 'packing',
  'overhead', 'total',
];
const PNL_LIST_ROW_KEYS = [
  'id', 'orderNo', 'po', 'status', 'date', 'supplyDate', 'customerName',
  'orderValue', 'invoiced', 'cost', 'costs', 'profit', 'marginPct',
  'producedMeters', 'jobs', 'warnings',
];
const PNL_JOB_KEYS = [
  'id', 'jobOrderNo', 'jobNo', 'status', 'productionMode', 'outsourceVendor',
  'producedMeters', 'labour', 'jobWork', 'finishing', 'checking', 'packing',
  'overhead', 'total', 'costPerMeter',
];

describe('order P&L — the shape both screens parse', () => {
  it('sends list rows with the order flattened onto them', async () => {
    // PnlListRow.fromJson parses the order ref from the ROW, not from a
    // nested object — the list flattens and the detail nests, and
    // swapping either would leave the header blank.
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    await jobWithWarping(yarn, elastic);

    const { body, status } = await request(app)
      .get('/api/v2/pnl/orders').set('Cookie', adminCookie());
    expect(status).toBe(200);
    hasKeys(body, ['rows', 'page', 'limit', 'total', 'pages', 'sort', 'sortScope', 'totals'],
      'pnl list');
    hasKeys(body.totals, ['orderValue', 'cost', 'profit'], 'pnl list totals');
    hasKeys(body.rows[0], PNL_LIST_ROW_KEYS, 'pnl list row');
    hasKeys(body.rows[0].costs, COST_KEYS, 'pnl list row costs');
  });

  it('says its margin sort only ordered the page', async () => {
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    await jobWithWarping(yarn, elastic);

    const recent = await request(app).get('/api/v2/pnl/orders')
      .query({ sort: 'recent' }).set('Cookie', adminCookie());
    expect(recent.body.sortScope).toBe('all');

    // The banner on the list page is driven by this. Margin does not
    // exist until each order is costed, so it cannot be sorted at the
    // database, and a "worst margin" heading implying otherwise would
    // send somebody chasing the wrong order.
    const byMargin = await request(app).get('/api/v2/pnl/orders')
      .query({ sort: 'margin' }).set('Cookie', adminCookie());
    expect(byMargin.body.sortScope).toBe('page');
  });

  it('sends the full breakdown with the order NESTED', async () => {
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { order } = await jobWithWarping(yarn, elastic);

    const { body, status } = await request(app)
      .get(`/api/v2/pnl/order/${order._id}`).set('Cookie', adminCookie());
    expect(status).toBe(200);
    const p = body.pnl;
    hasKeys(p, ['order', 'revenue', 'costs', 'jobs', 'totals', 'rateCard',
      'materialLines', 'warnings'], 'pnl detail');
    hasKeys(p.order, ['id', 'orderNo', 'po', 'status', 'date', 'supplyDate', 'customerName'],
      'pnl detail order');
    hasKeys(p.revenue, ['lines', 'orderValue', 'invoiced'], 'pnl revenue');
    hasKeys(p.revenue.invoiced, ['amount', 'quantity', 'challans'], 'pnl invoiced');
    hasKeys(p.revenue.lines[0], ['elasticId', 'name', 'quantity', 'rate', 'amount'],
      'pnl revenue line');
    hasKeys(p.costs, COST_KEYS, 'pnl costs');
    hasKeys(p.totals, ['producedMeters', 'orderedQuantity', 'profit', 'marginPct',
      'costPerMeter', 'revenuePerMeter'], 'pnl totals');
    hasKeys(p.rateCard, ['finishingRatePerMeter', 'checkingRatePerMeter',
      'packingRatePerMeter', 'overheadRatePerMeter', 'configured'], 'pnl rateCard');
    hasKeys(p.jobs[0], PNL_JOB_KEYS, 'pnl job row');
    hasKeys(p.jobs[0].labour, ['amount', 'shifts', 'hours', 'openShifts'], 'pnl job labour');
    // PnlConversion reads amount+basis and tells "entered" from "rate".
    hasKeys(p.jobs[0].finishing, ['amount', 'basis'], 'pnl job finishing');
  });

  it('leaves marginPct NULL on an unpriced order rather than sending a number', async () => {
    // The single most important null in this file. The badge reads "No
    // price" for it; a 0 or a -100 would look like a figure, and an
    // unpriced order ranked as the worst margin in the factory is how a
    // real loss gets lost among the noise.
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const customer = await Customer.create({
      name: 'Acme', contactName: 'R', phoneNumber: '9000000003',
    });
    const order = await Order.create({
      orderNo: 4242, customer: customer._id, status: 'Approved', po: 'PO-U',
      date: new Date(), supplyDate: new Date(),
      elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 0 }],
    });

    const detail = await request(app)
      .get(`/api/v2/pnl/order/${order._id}`).set('Cookie', adminCookie());
    expect(detail.body.pnl.totals.marginPct).toBeNull();
    expect(detail.body.pnl.warnings.some((w) => /selling rate/i.test(w))).toBe(true);

    // Matched on id, not orderNo: `orderNo` is immutable and assigned by
    // the auto-increment plugin, so the number set above is discarded.
    const list = await request(app).get('/api/v2/pnl/orders').set('Cookie', adminCookie());
    const row = list.body.rows.find((r) => String(r.id) === String(order._id));
    expect(row).toBeTruthy();
    expect(row.marginPct).toBeNull();
  });

  it('sends the rate card on its own, with configured', async () => {
    const before = await request(app).get('/api/v2/pnl/settings').set('Cookie', adminCookie());
    hasKeys(before.body.settings, ['finishingRatePerMeter', 'checkingRatePerMeter',
      'packingRatePerMeter', 'overheadRatePerMeter', 'configured'], 'pnl settings');
    // Never set means every conversion is ₹0, which flatters every order
    // in the factory — the phone shows a warning for exactly this.
    expect(before.body.settings.configured).toBe(false);

    await CostSettings.create({ key: 'cost', finishingRatePerMeter: 1.5 });
    const after = await request(app).get('/api/v2/pnl/settings').set('Cookie', adminCookie());
    expect(after.body.settings.configured).toBe(true);
  });

  it('refuses a user without the feature with 403, not 401 or 500', async () => {
    // The whole PnlForbidden screen keys on this exact status. A 401
    // would bounce the phone to the login page it just came from, and a
    // 500 would print a stack-trace-ish blob to somebody on a factory
    // floor — neither says "margin is a separate permission, ask an
    // admin", which is the one useful thing to say here.
    const noMargin = await User.create({
      name: 'Accounts', email: `a${Date.now()}@t.co`, password: 'pass1234',
      role: 'accounts', department: 'finance',
      // An explicit list is honoured exactly, and this one omits
      // /order-pnl while keeping the orders screen — the split the
      // feature exists for.
      features: ['/orders', '/jobs'],
    });
    const cookie = [
      `token=${jwt.sign({ id: noMargin._id, role: 'accounts' }, process.env.JWT_SECRET_KEY)}`,
    ];

    const list = await request(app).get('/api/v2/pnl/orders').set('Cookie', cookie);
    expect(list.status).toBe(403);

    const one = await request(app)
      .get(`/api/v2/pnl/order/${new mongoose.Types.ObjectId()}`).set('Cookie', cookie);
    expect(one.status).toBe(403);

    await User.deleteOne({ _id: noMargin._id });
  });

  it('serves the P&L PDF the app bar opens', async () => {
    const { yarn } = await yarnWithLot();
    const elastic = await elasticOn(yarn);
    const { order } = await jobWithWarping(yarn, elastic);

    const res = await request(app)
      .get(`/api/v2/pnl/order/${order._id}.pdf`).set('Cookie', adminCookie())
      .buffer().parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });
});
