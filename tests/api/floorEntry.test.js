'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FLOOR-ENTRY SCREEN — api/floor.js, services/floorEntry.js
//
//  A supervisor opens one shift with its PIN (made on the shift card),
//  puts operators on looms — the plan, if nobody made one — scans a
//  loom's QR label and enters its production. Every rule the signed-in
//  screens follow holds here: loading looms, verified entries, finalised
//  plans and jobs past weaving are refused; an entry is a submission
//  pending verification. Rotating the PIN ends every open session.
//
//  The photo reading (Claude vision) is stubbed.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockRead = jest.fn();
jest.mock('../../utils/timerOcr', () => ({ readTimerPhoto: (...a) => mockRead(...a) }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { pdfText } = require('../helpers/pdfText');

let mongo, app, M, admin, accounts;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const adminGet = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(admin));
const adminPost = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(admin)).send(body);

const DATE = '2026-10-21';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'ShiftPin', 'TimerPhoto', 'Customer', 'Order', 'Elastic']) {
    M[n] = require(`../../models/${n}.js`);
  }
  admin = await M.User.create({ name: 'Owner', email: 'o@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  accounts = await M.User.create({ name: 'Books', email: 'b@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  }
  mockRead.mockReset();
});

// ── Fixtures ──────────────────────────────────────────────────────

let n = 0;
async function seed() {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: `90000000${String(n).padStart(2, '0')}` });
  const elastic = await M.Elastic.create({
    name: `20mm ${n}-${Math.random().toString(36).slice(2, 6)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await M.Order.create({
    orderNo: 1000 + n, customer: customer._id, status: 'InProgress', po: `PO-${n}`,
    date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }],
  });
  const job = await M.JobOrder.create({
    date: new Date(), order: order._id, customer: customer._id, status: 'weaving',
    elastics: [{ elastic: elastic._id, quantity: 100000 }],
  });
  // L1 weaves the job on two heads; L2 is free; L3 is being loaded.
  const running = await M.Machine.create({
    ID: `L1-${n}`, manufacturer: 'Comez', NoOfHead: 4, NoOfHooks: 8, status: 'running',
    orderRunning: job._id, elastics: [{ head: 0, elastic: elastic._id }, { head: 1, elastic: elastic._id }, { head: 2, elastic: null }],
  });
  const free = await M.Machine.create({ ID: `L2-${n}`, manufacturer: 'Muller', NoOfHead: 2, NoOfHooks: 12, status: 'free', elastics: [] });
  const loading = await M.Machine.create({
    ID: `L3-${n}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'running', loading: true, loadingSince: new Date(),
    orderRunning: job._id, elastics: [{ head: 0, elastic: elastic._id }],
  });
  const ravi = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  const sita = await M.Employee.create({ name: 'Sita', department: 'weaving' });
  const clerk = await M.Employee.create({ name: 'Anu', department: 'office' });
  return { job, elastic, running, free, loading, ravi, sita, clerk };
}

/** The shift's PIN, as the admin would read it off the shift card. */
async function pinOf(date = DATE, shift = 'DAY') {
  const res = await adminGet(`/shift/floor-pin?date=${date}&shift=${shift}`);
  expect(res.status).toBe(200);
  return res.body.pin;
}

/** Open the floor for the shift; the token every other call carries. */
async function open({ date = DATE, shift = 'DAY', pin, name = 'Kumar' } = {}) {
  const res = await request(app).post('/api/v2/floor/open').send({ dateKey: date, shift, pin: pin ?? (await pinOf(date, shift)), name });
  return res;
}
const floor = (token) => ({
  get: (url) => request(app).get(`/api/v2/floor${url}`).set('X-Floor-Token', token),
  post: (url, body) => request(app).post(`/api/v2/floor${url}`).set('X-Floor-Token', token).send(body),
});

async function planned(s, rows) {
  const { createShiftPlan } = require('../../services/shiftPlanCreate');
  const { shiftPlan } = await createShiftPlan({
    date: DATE, shiftType: 'DAY',
    machines: rows || [{ machine: s.running._id, operator: s.ravi._id }, { machine: s.loading._id, operator: s.sita._id }],
  });
  return shiftPlan;
}
const detailOf = (plan, machine) => M.ShiftDetail.findOne({ shiftPlan: plan._id, machine: machine._id });

// ── The PIN ───────────────────────────────────────────────────────

describe('the shift PIN on the shift card', () => {
  it('is made the first time it is asked for and stays the same after', async () => {
    const a = await adminGet(`/shift/floor-pin?date=${DATE}&shift=DAY`);
    expect(a.status).toBe(200);
    expect(a.body.pin).toMatch(/^\d{4}$/);
    expect(a.body.generation).toBe(1);
    const b = await adminGet(`/shift/floor-pin?date=${DATE}&shift=day`);
    expect(b.body.pin).toBe(a.body.pin);
    // The night shift has its own.
    const night = await adminGet(`/shift/floor-pin?date=${DATE}&shift=NIGHT`);
    expect(night.body.shift).toBe('NIGHT');
    expect(await M.ShiftPin.countDocuments()).toBe(2);
  });

  it('needs a date and a shift', async () => {
    expect((await adminGet('/shift/floor-pin?date=2026-13-45&shift=DAY')).status).toBe(400);
    expect((await adminGet(`/shift/floor-pin?date=${DATE}&shift=EVENING`)).status).toBe(400);
  });

  it('is not for the accounts desk', async () => {
    const res = await request(app).get(`/api/v2/shift/floor-pin?date=${DATE}&shift=DAY`).set('Cookie', cookie(accounts));
    expect([401, 403]).toContain(res.status);
  });

  it('rotating makes a new PIN and ends every session opened with the old one', async () => {
    const before = await pinOf();
    const opened = await open({ pin: before });
    expect(opened.status).toBe(200);
    const token = opened.body.token;
    expect((await floor(token).get('/shift')).status).toBe(200);

    const rot = await adminPost('/shift/floor-pin/rotate', { date: DATE, shift: 'DAY' });
    expect(rot.status).toBe(200);
    expect(rot.body.pin).toMatch(/^\d{4}$/);
    expect(rot.body.generation).toBe(2);

    const after = await floor(token).get('/shift');
    expect(after.status).toBe(401);
    expect(after.body.message).toMatch(/PIN was changed/);
    // The old PIN no longer opens anything; the new one does.
    expect((await open({ pin: before })).status).toBe(401);
    expect((await open({ pin: rot.body.pin })).status).toBe(200);
  });
});

// ── Opening the floor ─────────────────────────────────────────────

describe('opening the floor', () => {
  it('with the right PIN gives a token, who opened it, and the shift as it stands', async () => {
    const s = await seed();
    const res = await open({ name: 'Kumar' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.session).toMatchObject({ dateKey: DATE, shift: 'DAY', name: 'Kumar' });
    expect(res.body.state.plan).toBeNull();
    expect(res.body.state.label).toMatch(/Day shift · 21 Oct 2026/);
    expect(res.body.state.machines.map((m) => m.ID)).toEqual([s.running.ID, s.free.ID, s.loading.ID]);
    // Weavers before the office.
    expect(res.body.state.operators.map((o) => o.name)).toEqual(['Ravi', 'Sita', 'Anu']);
    const pin = await M.ShiftPin.findOne({ dateKey: DATE, shift: 'DAY' }).lean();
    expect(pin.opens.map((o) => o.name)).toEqual(['Kumar']);
  });

  it('refuses a wrong PIN, counts the attempt, and says when none has been made', async () => {
    const pin = await pinOf();
    const wrong = String((Number(pin) + 1) % 10000).padStart(4, '0');
    const res = await open({ pin: wrong });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/not the PIN for the day shift of 21 Oct 2026/);
    expect((await M.ShiftPin.findOne({ dateKey: DATE, shift: 'DAY' }).lean()).failedAttempts).toBe(1);

    const none = await open({ date: '2026-10-22', shift: 'NIGHT', pin: '5555' });
    expect(none.status).toBe(401);
    expect(none.body.message).toMatch(/No PIN has been made for the night shift of 22 Oct 2026/);
  });

  it('needs a name and a four-digit PIN', async () => {
    const pin = await pinOf();
    expect((await open({ pin, name: 'K' })).status).toBe(400);
    expect((await open({ pin: '12' })).status).toBe(400);
    expect((await open({ pin: 'abcd' })).status).toBe(400);
  });

  it('everything else needs the token', async () => {
    const res = await request(app).get('/api/v2/floor/shift');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Enter the shift PIN again/);
    const forged = jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY);
    expect((await floor(forged).get('/shift')).status).toBe(401);
  });
});

// ── The shift as it stands ────────────────────────────────────────

describe('the shift as the floor sees it', () => {
  it('with no plan: a weaving loom is unplanned, a free one free, a loading one loading', async () => {
    const s = await seed();
    const { body } = await open();
    const by = Object.fromEntries(body.state.machines.map((m) => [m.ID, m]));
    expect(by[s.running.ID]).toMatchObject({ entry: 'unplanned', headsRunning: 2, heads: 4, hooks: 8, manufacturer: 'Comez', detail: null });
    expect(by[s.running.ID].job).toMatchObject({ id: String(s.job._id), status: 'weaving' });
    expect(by[s.running.ID].headMap).toEqual([
      { head: 0, elastic: { id: String(s.elastic._id), name: s.elastic.name } },
      { head: 1, elastic: { id: String(s.elastic._id), name: s.elastic.name } },
      { head: 2, elastic: null },
    ]);
    expect(by[s.free.ID]).toMatchObject({ entry: 'free', job: null, why: 'No job on this loom.' });
    expect(by[s.loading.ID]).toMatchObject({ entry: 'loading', loading: true });
    expect(body.state.counts).toMatchObject({ total: 3, toEnter: 1, entered: 0, free: 1, loading: 1, unplanned: 1 });
  });

  it('with a plan: the planned loom is ready with its operator; a loom past weaving is locked', async () => {
    const s = await seed();
    const plan = await planned(s);
    await M.JobOrder.updateOne({ _id: s.job._id }, { status: 'weaving' });
    let { body } = await floor((await open()).body.token).get('/shift');
    let by = Object.fromEntries(body.state.machines.map((m) => [m.ID, m]));
    expect(body.state.plan).toMatchObject({ id: String(plan._id), finalized: false });
    expect(by[s.running.ID]).toMatchObject({ entry: 'ready' });
    expect(by[s.running.ID].detail).toMatchObject({ status: 'open', operator: { id: String(s.ravi._id), name: 'Ravi' }, submitted: null });
    expect(by[s.loading.ID]).toMatchObject({ entry: 'loading' });
    expect(by[s.loading.ID].detail.status).toBe('loading');

    await M.JobOrder.updateOne({ _id: s.job._id }, { status: 'finishing' });
    ({ body } = await floor((await open()).body.token).get('/shift'));
    by = Object.fromEntries(body.state.machines.map((m) => [m.ID, m]));
    expect(by[s.running.ID]).toMatchObject({ entry: 'locked' });
    expect(by[s.running.ID].why).toMatch(/finishing/);
  });

  it('a finalised plan locks every loom', async () => {
    const s = await seed();
    const plan = await planned(s);
    await M.ShiftPlan.updateOne({ _id: plan._id }, { finalized: true });
    const { body } = await floor((await open()).body.token).get('/shift');
    expect(body.state.machines.every((m) => m.entry === 'locked')).toBe(true);
    expect(body.state.plan.finalized).toBe(true);
  });
});

// ── Scanning ──────────────────────────────────────────────────────

describe('scanning a loom', () => {
  it('finds the loom by its QR label, by its id, and by its ID however typed', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    for (const code of [`MACHINE|${s.running._id}|${s.running.ID}`, String(s.running._id), s.running.ID, s.running.ID.toLowerCase(), ` ${s.running.ID} `]) {
      const res = await f.get(`/machine?code=${encodeURIComponent(code)}`);
      expect(res.status).toBe(200);
      expect(res.body.machine).toMatchObject({ id: String(s.running._id), ID: s.running.ID, entry: 'unplanned' });
    }
  });

  it('explains a sheet row, a job label, and an unknown label', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    // A row off a printed sheet still names its machine — it resolves.
    const row = await f.get(`/machine?code=${encodeURIComponent(`SHIFTROW|abc|M:${s.free.ID}|x`)}`);
    expect(row.status).toBe(200);
    expect(row.body.machine.ID).toBe(s.free.ID);
    const rowNoMachine = await f.get(`/machine?code=${encodeURIComponent('FLOORROW|abc|x')}`);
    expect(rowNoMachine.status).toBe(404);
    expect(rowNoMachine.body.message).toMatch(/row off a production sheet/);
    const job = await f.get('/machine?code=J-12');
    expect(job.status).toBe(404);
    expect(job.body.message).toMatch(/job label/);
    const unknown = await f.get('/machine?code=LOOM-99');
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toMatch(/No machine called "LOOM-99"/);
    expect((await f.get('/machine?code=')).status).toBe(400);
  });
});

// ── Planning from the floor ───────────────────────────────────────

describe('the plan, when nobody made one', () => {
  it('is made from the operators the supervisor put on the looms, as a draft from the floor', async () => {
    const s = await seed();
    const f = floor((await open({ name: 'Kumar' })).body.token);
    const res = await f.post('/plan', { rows: [
      { machine: String(s.running._id), operator: String(s.ravi._id) },
      { machine: String(s.loading._id), operator: String(s.sita._id) },
    ] });
    expect(res.status).toBe(201);
    expect(res.body.planned).toBe(2);
    const plan = await M.ShiftPlan.findById(res.body.planId).lean();
    expect(plan.description).toBe('From the floor (Kumar)');
    expect(plan.finalized).toBeFalsy();
    expect(plan.shift).toBe('DAY');
    const by = Object.fromEntries(res.body.state.machines.map((m) => [m.ID, m]));
    expect(by[s.running.ID]).toMatchObject({ entry: 'ready', detail: { operator: { name: 'Ravi' } } });
    expect(by[s.loading.ID]).toMatchObject({ entry: 'loading' });
    expect((await detailOf(plan, s.loading)).status).toBe('loading');
    expect(res.body.state.counts.toEnter).toBe(1);
  });

  it('is refused when a plan exists meanwhile, and when the rows are empty or doubled', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    expect((await f.post('/plan', { rows: [] })).status).toBe(400);
    const doubled = await f.post('/plan', { rows: [
      { machine: String(s.running._id), operator: String(s.ravi._id) },
      { machine: String(s.running._id), operator: String(s.sita._id) },
    ] });
    expect(doubled.status).toBe(400);
    expect(doubled.body.message).toMatch(/listed twice/);

    await planned(s);
    const again = await f.post('/plan', { rows: [{ machine: String(s.running._id), operator: String(s.ravi._id) }] });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PLAN_EXISTS');
    expect(await M.ShiftPlan.countDocuments()).toBe(1);
  });
});

describe('putting an operator on a loom', () => {
  it('adds a loom the plan left out, and changes the operator on one it has', async () => {
    const s = await seed();
    const plan = await planned(s, [{ machine: s.loading._id, operator: s.sita._id }]);
    const f = floor((await open()).body.token);

    const added = await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) });
    expect(added.status).toBe(200);
    expect(added.body.added).toBe(true);
    const detail = await detailOf(plan, s.running);
    expect(detail).toMatchObject({ status: 'open', employee: s.ravi._id, job: s.job._id });
    expect(detail.elastics).toHaveLength(2);
    expect((await M.ShiftPlan.findById(plan._id).lean()).plan.map(String)).toContain(String(detail._id));
    expect((await M.JobOrder.findById(s.job._id).lean()).shiftDetails.map(String)).toContain(String(detail._id));

    const changed = await f.post('/operator', { machine: String(s.running._id), operator: String(s.sita._id) });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ added: false, detailId: String(detail._id) });
    expect(String((await detailOf(plan, s.running)).employee)).toBe(String(s.sita._id));
  });

  it('is refused with no plan, on a verified entry, on a finalised plan, and for nobody on record', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    const noPlan = await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) });
    expect(noPlan.status).toBe(409);
    expect(noPlan.body.message).toMatch(/Make the shift plan first/);

    const plan = await planned(s);
    expect((await f.post('/operator', { machine: String(s.running._id), operator: String(new mongoose.Types.ObjectId()) })).status).toBe(404);
    await M.ShiftDetail.updateOne({ shiftPlan: plan._id, machine: s.running._id }, { status: 'closed' });
    expect((await f.post('/operator', { machine: String(s.running._id), operator: String(s.sita._id) })).status).toBe(409);
    await M.ShiftPlan.updateOne({ _id: plan._id }, { finalized: true });
    expect((await f.post('/operator', { machine: String(s.free._id), operator: String(s.sita._id) })).status).toBe(409);
  });
});

// ── Entering production ───────────────────────────────────────────

describe('entering production', () => {
  it('submits the entry for verification, with the run time tidied and who entered it', async () => {
    const s = await seed();
    const plan = await planned(s);
    const detail = await detailOf(plan, s.running);
    const f = floor((await open({ name: 'Kumar' })).body.token);

    const res = await f.post('/entry', { detailId: String(detail._id), production: '820', timer: '7.30', feedback: 'beam changed at 2' });
    expect(res.status).toBe(200);
    expect(res.body.machine).toMatchObject({ entry: 'entered' });
    expect(res.body.machine.detail.submitted).toMatchObject({ production: 820, timer: '7:30:00', feedback: 'beam changed at 2', byName: 'Kumar' });
    const after = await M.ShiftDetail.findById(detail._id).lean();
    expect(after).toMatchObject({
      status: 'pending_verification', submittedProductionMeters: 820, submittedTimer: '7:30:00', submittedFeedback: 'beam changed at 2', submittedByName: 'Kumar',
    });
    expect(after.submittedBy ?? null).toBeNull();
    // Nothing reached the job: it is pending, as every entry is.
    expect((await M.JobOrder.findById(s.job._id).lean()).producedElastic || []).toEqual([]);
  });

  it('can be corrected until verified, and takes the operator with it', async () => {
    const s = await seed();
    const plan = await planned(s);
    const detail = await detailOf(plan, s.running);
    const f = floor((await open()).body.token);
    expect((await f.post('/entry', { detailId: String(detail._id), production: 100, timer: '7:00' })).status).toBe(200);
    const again = await f.post('/entry', { detailId: String(detail._id), production: 120, timer: '07:15:30', operator: String(s.sita._id) });
    expect(again.status).toBe(200);
    const after = await M.ShiftDetail.findById(detail._id).lean();
    expect(after).toMatchObject({ submittedProductionMeters: 120, submittedTimer: '7:15:30', employee: s.sita._id });
    expect(again.body.machine.detail.operator.name).toBe('Sita');

    // The verify route then closes it, after which the floor cannot touch it.
    const verify = await adminPost('/shift/verify-production', { shiftId: String(detail._id), productionMeters: 120 });
    expect(verify.status).toBe(200);
    const locked = await f.post('/entry', { detailId: String(detail._id), production: 130 });
    expect(locked.status).toBe(409);
    expect(locked.body.message).toMatch(/verified already/);
    expect((await f.get(`/machine?code=${s.running.ID}`)).body.machine).toMatchObject({ entry: 'verified' });
  });

  it('checks the figures: metres 0 or more, run time like 7:30 and inside the shift', async () => {
    const s = await seed();
    const plan = await planned(s);
    const detail = await detailOf(plan, s.running);
    const f = floor((await open()).body.token);
    const bad = async (body, re) => {
      const res = await f.post('/entry', { detailId: String(detail._id), ...body });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(re);
    };
    await bad({ production: -5 }, /0 or more/);
    await bad({ production: 'lots' }, /0 or more/);
    await bad({ production: 10, timer: '7h30' }, /like 7:30/);
    await bad({ production: 10, timer: '13:00' }, /12 hours/);
    const zero = await f.post('/entry', { detailId: String(detail._id), production: 0 });
    expect(zero.status).toBe(200);
    expect((await M.ShiftDetail.findById(detail._id).lean()).submittedTimer).toBe('00:00:00');
  });

  it('refuses a loading loom, a loom not on this shift, and a finalised plan', async () => {
    const s = await seed();
    const plan = await planned(s);
    const f = floor((await open()).body.token);
    const loading = await f.post('/entry', { detailId: String((await detailOf(plan, s.loading))._id), production: 10 });
    expect(loading.status).toBe(409);
    expect(loading.body.message).toMatch(/being loaded/);

    // An entry on another shift's plan is not reachable from this one.
    const { createShiftPlan } = require('../../services/shiftPlanCreate');
    const { shiftPlan: night } = await createShiftPlan({ date: DATE, shiftType: 'NIGHT', machines: [{ machine: s.running._id, operator: s.ravi._id }] });
    const other = await f.post('/entry', { detailId: String((await detailOf(night, s.running))._id), production: 10 });
    expect(other.status).toBe(404);
    expect((await f.post('/entry', { detailId: 'nope', production: 10 })).status).toBe(400);

    await M.ShiftPlan.updateOne({ _id: plan._id }, { finalized: true });
    const fin = await f.post('/entry', { detailId: String((await detailOf(plan, s.running))._id), production: 10 });
    expect(fin.status).toBe(409);
    expect(fin.body.message).toMatch(/finalised/);
  });

  it('with no plan says to make it first', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    const res = await f.post('/entry', { detailId: String(new mongoose.Types.ObjectId()), production: 10 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Make the shift plan first/);
  });
});

// ── The timer photo ───────────────────────────────────────────────

describe('reading the run time off a photo', () => {
  const reading = (text) => ({
    available: true, model: 'test-vision', latencyMs: 10, usage: { input_tokens: 1, output_tokens: 1 },
    reading: { displays: [{ text, kind: 'run_time', label: 'RUN', confidence: 0.9, alternatives: [] }], primary: 0, problem: null },
  });
  const send = (token, detailId, file = PNG, type = 'image/png') => {
    let req = request(app).post('/api/v2/floor/timer-photo').set('X-Floor-Token', token);
    if (detailId) req = req.field('detailId', detailId);
    return req.attach('photo', file, { filename: 'timer.png', contentType: type });
  };

  it('keeps the photo with the shift under the supervisor\'s name, reads it, and marks it used', async () => {
    const s = await seed();
    const plan = await planned(s);
    const detail = await detailOf(plan, s.running);
    const token = (await open({ name: 'Kumar' })).body.token;
    mockRead.mockResolvedValue(reading('07:45:12'));

    const res = await send(token, String(detail._id));
    expect(res.status).toBe(200);
    expect(res.body.reading.displays[0].text).toBe('07:45:12');
    expect(res.body.photoId).toBeTruthy();
    const photo = await M.TimerPhoto.findById(res.body.photoId).lean();
    expect(photo).toMatchObject({ shift: detail._id, uploadedByName: 'Kumar', readText: '07:45:12', uploadedBy: null });

    const use = await request(app).post(`/api/v2/floor/timer-photo/${res.body.photoId}/use`).set('X-Floor-Token', token).send({ runTime: '7:45:12' });
    expect(use.status).toBe(200);
    expect((await M.TimerPhoto.findById(res.body.photoId).lean())).toMatchObject({ used: true, runTimeUsed: '7:45:12' });
  });

  it('says when reading is not set up, keeping the photo, and refuses a loom not on the shift', async () => {
    const s = await seed();
    const plan = await planned(s);
    const detail = await detailOf(plan, s.running);
    const token = (await open()).body.token;
    mockRead.mockResolvedValue({ available: false });
    const res = await send(token, String(detail._id));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
    expect(res.body.details?.photoId).toBeTruthy();

    expect((await send(token, String(new mongoose.Types.ObjectId()))).status).toBe(404);
    expect((await send(token, String(detail._id), Buffer.from('%PDF'), 'application/pdf')).status).toBe(400);
    expect((await request(app).post('/api/v2/floor/timer-photo').attach('photo', PNG, 'timer.png')).status).toBe(401);
  });
});

// ── The labels ────────────────────────────────────────────────────

describe('the QR labels PDF', () => {
  const download = (q = '') => request(app).get(`/api/v2/machine/qr-labels.pdf${q}`).set('Cookie', cookie(admin))
    .buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });

  it('prints every loom with its ID, manufacturer, hooks and heads', async () => {
    const s = await seed();
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/pdf/);
    const text = await pdfText(res.body);
    for (const m of [s.running, s.free, s.loading]) expect(text).toContain(m.ID);
    expect(text).toMatch(/Comez/);
    expect(text).toMatch(/Muller/);
    expect(text).toMatch(/8 hooks · 4 heads/);
    expect(text).toMatch(/12 hooks · 2 heads/);
  });

  it('prints only the chosen looms, and rejects a bad id', async () => {
    const s = await seed();
    const text = await pdfText((await download(`?ids=${s.free._id}`)).body);
    expect(text).toContain(s.free.ID);
    expect(text).not.toContain(s.running.ID);
    expect((await download('?ids=nope')).status).toBe(400);
  });
});

// ── Guessing ──────────────────────────────────────────────────────

describe('guessing the PIN', () => {
  it('is cut off after a handful of wrong tries', async () => {
    const pin = await pinOf();
    const wrong = String((Number(pin) + 7) % 10000).padStart(4, '0');
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = await open({ pin: wrong });
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.body.message).toMatch(/Too many PIN attempts/);
  }, 30_000);
});
