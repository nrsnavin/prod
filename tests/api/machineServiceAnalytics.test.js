'use strict';
// ══════════════════════════════════════════════════════════════════
//  SERVICE SPENDING AND THE PATTERNS WORTH A LOOK
//
//  What these hold:
//
//    • a chart's months include the QUIET ones. Drawn only from months
//      that had a bill, three idle months and a spike read as four
//      steady ones — the gaps are the shape of the data.
//    • the typical month is a MEDIAN. One rebuild must not become the
//      figure somebody budgets against for a year.
//    • the detector says "not enough history" rather than "no problems
//      found" when it has too little to go on. Those are different
//      statements and only one of them is honest from four logs.
//    • a dismissal silences ONE reading of ONE subject, needs a
//      reason, and expires.
//    • production excludes unverified shifts, whose figures are the
//      operator's own and change at verification.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, Machine, MachineServiceBill, ServiceAnomalyFeedback, ShiftDetail, User, admin;

const adminCookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Machine = require('../../models/Machine');
  MachineServiceBill = require('../../models/MachineServiceBill');
  ServiceAnomalyFeedback = require('../../models/ServiceAnomalyFeedback');
  ShiftDetail = require('../../models/ShiftDetail');
  User = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'svc@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

/** A machine with the given service logs. */
const makeMachine = (id, logs = [], over = {}) =>
  Machine.create({
    ID: id, manufacturer: 'Comez', NoOfHead: 8, NoOfHooks: 24,
    serviceLogs: logs, ...over,
  });

const serviceLog = (over = {}) => ({
  date: daysAgo(30), type: 'Preventive', description: 'Replaced drive belt',
  technician: 'Rajan', cost: 1000, ...over,
});

/** ShiftDetail requires a plan and an operator; neither matters here. */
const shiftRow = (over = {}) => ({
  shiftPlan: new mongoose.Types.ObjectId(),
  employee:  new mongoose.Types.ObjectId(),
  shift: 'DAY',
  ...over,
});

const analytics = (query = '') =>
  request(app).get(`/api/v2/machine/service-analytics${query}`)
    .set('Cookie', adminCookie());

describe('what the plant is spending', () => {
  it('buckets spending by month', async () => {
    await makeMachine('LOOM-01', [
      serviceLog({ date: daysAgo(10), cost: 5000 }),
      serviceLog({ date: daysAgo(12), cost: 3000 }),
    ]);

    const res = await analytics('?days=365');
    expect(res.status).toBe(200);
    expect(res.body.spend.total).toBe(8000);
    expect(res.body.spend.services).toBe(2);
  });

  it('includes the months with nothing in them', async () => {
    // A chart drawn only from months that had a bill closes the gaps.
    await makeMachine('LOOM-01', [serviceLog({ date: daysAgo(300), cost: 5000 })]);

    const res = await analytics('?days=365');
    const months = res.body.spend.series.map((b) => b.month);
    expect(months.length).toBeGreaterThanOrEqual(12);
    // Most of them are empty, and they are still there.
    expect(res.body.spend.series.filter((b) => b.total === 0).length)
      .toBeGreaterThan(6);
  });

  it('reports the typical month as a median, not a mean', async () => {
    // Eleven quiet months and one rebuild: the mean says this plant
    // spends ₹10,000 a month, which is not a number to budget against.
    await makeMachine('LOOM-01', [serviceLog({ date: daysAgo(15), cost: 120_000 })]);

    const res = await analytics('?days=365');
    expect(res.body.spend.typicalMonth).toBe(0);
    expect(res.body.spend.meanMonth).toBeGreaterThan(0);
  });

  it('splits labour from parts where bills say which', async () => {
    const m = await makeMachine('LOOM-01', [serviceLog({ date: daysAgo(10), cost: 0 })]);
    const logId = m.serviceLogs[0]._id;
    await MachineServiceBill.create([
      { machine: m._id, serviceLog: logId, kind: 'service_bill',
        contentType: 'application/pdf', size: 10, data: 'data:x', amount: 2000 },
      { machine: m._id, serviceLog: logId, kind: 'spare_bill',
        contentType: 'application/pdf', size: 10, data: 'data:x', amount: 3000 },
    ]);

    const res = await analytics('?days=365');
    const month = res.body.spend.series.find((b) => b.total > 0);
    expect(month.labour).toBe(2000);
    expect(month.parts).toBe(3000);
  });

  it('prefers the filed bills over the typed cost', async () => {
    // The logged cost is what somebody remembered; the bills are what
    // was actually filed.
    const m = await makeMachine('LOOM-01', [serviceLog({ date: daysAgo(10), cost: 500 })]);
    await MachineServiceBill.create({
      machine: m._id, serviceLog: m.serviceLogs[0]._id, kind: 'service_bill',
      contentType: 'application/pdf', size: 10, data: 'data:x', amount: 7000,
    });

    const res = await analytics('?days=365');
    expect(res.body.spend.total).toBe(7000);
  });

  it('ranks the machines that cost most to keep running', async () => {
    await makeMachine('LOOM-01', [serviceLog({ cost: 9000 })]);
    await makeMachine('LOOM-02', [serviceLog({ cost: 1000 })]);

    const res = await analytics('?days=365');
    expect(res.body.costliest[0].machineID).toBe('LOOM-01');
    expect(res.body.costliest[0].total).toBe(9000);
  });

  it("reports one machine's spending on its own", async () => {
    const a = await makeMachine('LOOM-01', [serviceLog({ cost: 9000 })]);
    await makeMachine('LOOM-02', [serviceLog({ cost: 1000 })]);

    const res = await request(app)
      .get(`/api/v2/machine/service-analytics/${a._id}?days=365`)
      .set('Cookie', adminCookie());

    expect(res.body.spend.total).toBe(9000);
  });
});

describe('what the detector will and will not say', () => {
  it('says it has too little history rather than "no problems"', async () => {
    // These are different statements and only one is honest here.
    await makeMachine('LOOM-01', [serviceLog(), serviceLog()]);

    const res = await analytics('?days=365');
    expect(res.body.anomalies.ready).toBe(false);
    expect(res.body.anomalies.reason).toMatch(/at least/i);
    expect(res.body.anomalies.findings).toEqual([]);
  });

  it('finds a bill number filed against two machines', async () => {
    const a = await makeMachine('LOOM-01', [serviceLog()]);
    const b = await makeMachine('LOOM-02', [serviceLog()]);
    // Enough history to clear the floor.
    for (let i = 3; i <= 14; i++) {
      await makeMachine(`LOOM-${i}`, [serviceLog({ date: daysAgo(20 + i) })]);
    }

    const bill = (machine, serviceLog) => ({
      machine, serviceLog, kind: 'service_bill',
      contentType: 'application/pdf', size: 10, data: 'data:x',
      amount: 5000, vendor: 'Comez Spares', billNo: 'INV-100',
    });
    await MachineServiceBill.create([
      bill(a._id, a.serviceLogs[0]._id),
      bill(b._id, b.serviceLogs[0]._id),
    ]);

    const res = await analytics('?days=365');
    expect(res.body.anomalies.ready).toBe(true);
    const dup = res.body.anomalies.findings.find((f) => f.kind === 'duplicate-bill-no');
    expect(dup).toBeDefined();
    expect(dup.innocent).toBeTruthy();
  });

  it('carries the innocent reading on every finding', async () => {
    // The difference between an observation and an accusation.
    for (let i = 1; i <= 16; i++) {
      await makeMachine(`LOOM-${i}`, [
        serviceLog({ date: daysAgo(10 + i), cost: 1000 }),
        serviceLog({ date: daysAgo(70 + i), cost: 1000 }),
      ]);
    }
    const res = await analytics('?days=365');
    for (const f of res.body.anomalies.findings) {
      expect(f.innocent).toBeTruthy();
      expect(f.title).not.toMatch(/fraud|theft|steal/i);
    }
  });
});

describe('dismissing a finding', () => {
  const dismiss = (body) =>
    request(app).post('/api/v2/machine/service-analytics/dismiss')
      .set('Cookie', adminCookie()).send(body);

  it('wants a reason — it is the only record of the judgement', async () => {
    const res = await dismiss({ kind: 'technician-cost', subject: 'Rajan' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/say why/i);
  });

  it('refuses a reason too short to mean anything', async () => {
    const res = await dismiss({ kind: 'technician-cost', subject: 'Rajan', reason: 'ok' });
    expect(res.status).toBe(400);
  });

  it('records it with an expiry', async () => {
    // A dismissal is a judgement about a situation, and situations end.
    const res = await dismiss({
      kind: 'technician-cost', subject: 'Rajan',
      reason: 'He only works the two rebuilt looms',
    });

    expect(res.status).toBe(201);
    expect(new Date(res.body.dismissal.expiresAt).getTime())
      .toBeGreaterThan(Date.now());
  });

  it('silences that reading of that subject, and nothing else', async () => {
    await dismiss({
      kind: 'technician-cost', subject: 'Rajan',
      reason: 'He only works the difficult machines',
    });

    const stored = await ServiceAnomalyFeedback.find({}).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe('technician-cost');
    expect(stored[0].subject).toBe('Rajan');
  });

  it('keeps a dismissed finding out of the report', async () => {
    const a = await makeMachine('LOOM-01', [serviceLog()]);
    const b = await makeMachine('LOOM-02', [serviceLog()]);
    for (let i = 3; i <= 14; i++) {
      await makeMachine(`LOOM-${i}`, [serviceLog({ date: daysAgo(20 + i) })]);
    }
    const bill = (machine, serviceLog) => ({
      machine, serviceLog, kind: 'service_bill',
      contentType: 'application/pdf', size: 10, data: 'data:x',
      amount: 5000, vendor: 'Comez Spares', billNo: 'INV-100',
    });
    await MachineServiceBill.create([
      bill(a._id, a.serviceLogs[0]._id),
      bill(b._id, b.serviceLogs[0]._id),
    ]);

    const before = await analytics('?days=365');
    const dup = before.body.anomalies.findings.find((f) => f.kind === 'duplicate-bill-no');
    expect(dup).toBeDefined();

    await dismiss({
      kind: dup.kind, subject: dup.subject,
      reason: 'One invoice covered both looms',
    });

    const after = await analytics('?days=365');
    expect(after.body.anomalies.findings.find((f) => f.kind === 'duplicate-bill-no'))
      .toBeUndefined();
    expect(after.body.anomalies.dismissed).toBeGreaterThan(0);
  });
});

describe('what a machine produced', () => {
  const series = (id) =>
    request(app).get(`/api/v2/machine/production-series/${id}?days=365`)
      .set('Cookie', adminCookie());

  it('leaves out shifts nobody has verified', async () => {
    // Their figures are the operator's own and are rewritten at
    // verification, so a chart including them changes days later.
    const m = await makeMachine('LOOM-01');
    await ShiftDetail.create([
      shiftRow({ date: daysAgo(5), machine: m._id, status: 'closed', productionMeters: 900 }),
      shiftRow({ date: daysAgo(4), machine: m._id,
        status: 'pending_verification', productionMeters: 5000 }),
    ]);

    const res = await series(m._id);
    expect(res.status).toBe(200);
    expect(res.body.totalMeters).toBe(900);
    expect(res.body.totalShifts).toBe(1);
  });

  it('includes the months with no output', async () => {
    const m = await makeMachine('LOOM-01');
    await ShiftDetail.create(
      shiftRow({ machine: m._id, date: daysAgo(300), status: 'closed', productionMeters: 900 })
    );

    const res = await series(m._id);
    expect(res.body.series.length).toBeGreaterThanOrEqual(12);
  });

  it('refuses an id that is not one', async () => {
    const res = await series('not-an-id');
    expect(res.status).toBe(400);
  });
});
