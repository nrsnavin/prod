'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE FLOOR-ENTRY SCREEN — api/floor.js, services/floorEntry.js
//
//  A supervisor opens one shift with its PIN (made on the shift card),
//  scans a loom's QR label, says who ran it — which puts it on the
//  shift, making the plan when nobody did — and enters its production. Every rule the signed-in
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
    await M.Machine.updateOne({ _id: s.free._id }, { status: 'maintenance' });
    const again = await floor((await open()).body.token).get('/shift');
    expect(again.body.state.machines.find((m) => m.ID === s.free.ID)).toMatchObject({ entry: 'free', why: /Under maintenance/ });
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

// ── The plan, made from the floor ─────────────────────────────────

describe('the plan, when nobody made one', () => {
  it('is made from the first loom entered, a draft from the floor, and every loom after is added to it', async () => {
    const s = await seed();
    const f = floor((await open({ name: 'Kumar' })).body.token);
    expect((await f.get('/shift')).body.state.plan).toBeNull();

    const first = await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ added: true, planCreated: true });
    const plan = await M.ShiftPlan.findOne({}).lean();
    expect(plan.description).toBe('From the floor (Kumar)');
    expect(plan.status).toBe('draft');
    expect(plan.finalized).toBeFalsy();
    expect(plan.shift).toBe('DAY');
    const detail = await detailOf(plan, s.running);
    expect(String(detail._id)).toBe(first.body.detailId);
    expect(detail).toMatchObject({ status: 'open', employee: s.ravi._id, job: s.job._id });

    const second = await f.post('/operator', { machine: String(s.loading._id), operator: String(s.sita._id) });
    expect(second.body).toMatchObject({ added: true, planCreated: false });
    expect(await M.ShiftPlan.countDocuments()).toBe(1);
    expect((await detailOf(plan, s.loading)).status).toBe('loading');

    const { state } = (await f.get('/shift')).body;
    expect(state.plan).toMatchObject({ id: String(plan._id), status: 'draft' });
    const by = Object.fromEntries(state.machines.map((m) => [m.ID, m]));
    expect(by[s.running.ID]).toMatchObject({ entry: 'ready', detail: { operator: { name: 'Ravi' } } });
    expect(by[s.loading.ID]).toMatchObject({ entry: 'loading' });
    expect(state.counts.toEnter).toBe(1);
  });

  it('"Create shift plan": the looms noted become the plan, the free looms written on it for the office to confirm', async () => {
    const s = await seed();
    const f = floor((await open({ name: 'Kumar' })).body.token);
    // Nothing noted yet: nothing to create.
    expect((await f.post('/complete', {})).status).toBe(409);
    const detailId = (await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) })).body.detailId;
    // Noted but not entered: not yet.
    const early = await f.post('/complete', {});
    expect(early.status).toBe(409);
    expect(early.body.message).toMatch(/No loom has its production entered/);

    // The office can see the draft all along.
    const plan = await M.ShiftPlan.findOne({}).lean();
    expect((await adminGet(`/shift/shiftPlanById?id=${plan._id}`)).body.data).toMatchObject({ status: 'draft', source: 'floor', floor: null });

    const entry = await f.post('/entry', { detailId, production: 820, timer: '7:30' });
    expect(entry.status).toBe(200);
    expect(entry.body.plan.floor).toBeNull();

    // Sita loaded L3 this shift: on the plan, with nothing to enter.
    const loading = await f.post('/operator', { machine: String(s.loading._id), operator: String(s.sita._id) });
    expect(loading.status).toBe(200);
    expect((await detailOf(plan, s.loading))).toMatchObject({ status: 'loading', employee: s.sita._id });
    const l3 = (await f.get('/shift')).body.state.machines.find((m) => m.ID === s.loading.ID);
    expect(l3).toMatchObject({ entry: 'loading', detail: { operator: { name: 'Sita' } } });
    expect(l3.why).toMatch(/by Sita/);

    // L1 was the only loom running a job (L3 loading, L2 free).
    const res = await f.post('/complete', {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entered: 1, toEnter: [],
      freeMachines: [{ ID: s.free.ID, why: 'No job on this loom.' }],
      loadingMachines: [{ ID: s.loading.ID, operatorName: 'Sita' }],
    });
    expect(res.body.plan).toMatchObject({ status: 'draft', fromFloor: true, floor: { completedBy: 'Kumar', freeMachines: [{ ID: s.free.ID }] } });
    const after = await M.ShiftPlan.findById(plan._id).lean();
    expect(after.floor.completedAt).toBeInstanceOf(Date);
    expect(after.floor.freeMachines.map((m) => m.ID)).toEqual([s.free.ID]);
    expect(after.floor.loadingMachines).toMatchObject([{ ID: s.loading.ID, operatorName: 'Sita' }]);
    expect(after.status).toBe('draft');

    // Not twice; a correction after is still fine.
    expect((await f.post('/complete', {})).status).toBe(409);
    expect((await f.post('/entry', { detailId, production: 830 })).status).toBe(200);
    expect((await f.get('/shift')).body.state.plan.floor.completedBy).toBe('Kumar');

    // The office sees it, and confirms it there.
    const detail = await adminGet(`/shift/shiftPlanById?id=${plan._id}`);
    expect(detail.body.data).toMatchObject({ status: 'draft', source: 'floor', floor: { completedBy: 'Kumar', freeMachines: [{ ID: s.free.ID }], loadingMachines: [{ ID: s.loading.ID, operatorName: 'Sita' }] } });
    expect((await adminPost('/shift/confirm-shift-plan', { id: String(plan._id) })).status).toBe(200);
    expect((await adminGet(`/shift/shiftPlanById?id=${plan._id}`)).body.data.status).toBe('confirmed');
  });

  it('with looms still to enter it says which, and creates the plan only when told to anyway', async () => {
    const s = await seed();
    const other = await M.Machine.create({
      ID: `L4-${n}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'running',
      orderRunning: s.job._id, elastics: [{ head: 0, elastic: s.elastic._id }],
    });
    const f = floor((await open()).body.token);
    const detailId = (await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) })).body.detailId;
    await f.post('/entry', { detailId, production: 820 });

    const held = await f.post('/complete', {});
    expect(held.status).toBe(409);
    expect(held.body.code).toBe('FLOOR_LOOMS_TO_ENTER');
    expect(held.body.details.looms).toEqual([{ id: String(other._id), ID: other.ID }]);
    expect((await M.ShiftPlan.findOne({}).lean()).floor?.completedAt).toBeUndefined();

    const forced = await f.post('/complete', { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.toEnter).toEqual([other.ID]);
    expect(forced.body.freeMachines.map((m) => m.ID)).toEqual([s.free.ID]);
    // A loading loom nobody was put on is still recorded, with nobody.
    expect(forced.body.loadingMachines).toEqual([{ id: String(s.loading._id), ID: s.loading.ID, operatorName: '' }]);
  });

  it('is not for a plan the office made', async () => {
    const s = await seed();
    await planned(s);
    const f = floor((await open()).body.token);
    const res = await f.post('/complete', {});
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/The office made this shift's plan/);
  });

  it('a loom that is not on record makes no plan', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    const res = await f.post('/operator', { machine: String(new mongoose.Types.ObjectId()), operator: String(s.ravi._id) });
    expect(res.status).toBe(404);
    expect(await M.ShiftPlan.countDocuments()).toBe(0);
  });

  it('the entry itself still needs the loom on the shift', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    const res = await f.post('/entry', { detailId: String(new mongoose.Types.ObjectId()), production: 10 });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Choose the operator on this loom first/);
    void s;
  });
});

describe('putting an operator on a loom', () => {
  it('adds a loom the office plan left out, with the operator chosen on the floor', async () => {
    const s = await seed();
    const plan = await planned(s, [{ machine: s.loading._id, operator: s.sita._id }]);
    const f = floor((await open()).body.token);

    const added = await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ added: true, planCreated: false });
    const detail = await detailOf(plan, s.running);
    expect(detail).toMatchObject({ status: 'open', employee: s.ravi._id, job: s.job._id });
    expect(detail.elastics).toHaveLength(2);
    expect((await M.ShiftPlan.findById(plan._id).lean()).plan.map(String)).toContain(String(detail._id));
    expect((await M.JobOrder.findById(s.job._id).lean()).shiftDetails.map(String)).toContain(String(detail._id));
  });

  it('on a plan the office made, the operator it put on a loom is not the floor\'s to change', async () => {
    const s = await seed();
    const plan = await planned(s);
    const f = floor((await open()).body.token);
    const detail = await detailOf(plan, s.running);

    const { state } = (await f.get('/shift')).body;
    expect(state.plan.fromFloor).toBe(false);
    const row = state.machines.find((m) => m.ID === s.running.ID);
    expect(row.detail).toMatchObject({ operator: { name: 'Ravi' }, operatorLocked: true });

    const change = await f.post('/operator', { machine: String(s.running._id), operator: String(s.sita._id) });
    expect(change.status).toBe(409);
    expect(change.body.message).toMatch(/The office put Ravi on this loom/);
    // Saying the same operator again is not a change.
    expect((await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) })).status).toBe(200);

    const entry = await f.post('/entry', { detailId: String(detail._id), production: 100, operator: String(s.sita._id) });
    expect(entry.status).toBe(409);
    expect(entry.body.message).toMatch(/The office put the operator on this loom/);
    expect((await f.post('/entry', { detailId: String(detail._id), production: 100, operator: String(s.ravi._id) })).status).toBe(200);
    expect(String((await detailOf(plan, s.running)).employee)).toBe(String(s.ravi._id));
  });

  it('on a plan made from the floor, the operator can be changed until the entry is verified', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
    const first = await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) });
    expect(first.body.planCreated).toBe(true);
    expect((await f.get('/shift')).body.state.plan.fromFloor).toBe(true);
    const plan = await M.ShiftPlan.findOne({}).lean();
    expect(plan.source).toBe('floor');

    const changed = await f.post('/operator', { machine: String(s.running._id), operator: String(s.sita._id) });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ added: false, detailId: first.body.detailId });
    expect(String((await detailOf(plan, s.running)).employee)).toBe(String(s.sita._id));
    expect((await f.get('/shift')).body.state.machines.find((m) => m.ID === s.running.ID).detail.operatorLocked).toBe(false);
  });

  it('is refused on a verified entry, on a finalised plan, and for nobody on record', async () => {
    const s = await seed();
    const f = floor((await open()).body.token);
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
    const f = floor((await open()).body.token);
    // A plan made from the floor: its operators are the floor's to change.
    const detailId = (await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) })).body.detailId;
    const detail = await M.ShiftDetail.findById(detailId).lean();
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

// ── What the office sees ──────────────────────────────────────────

describe('the plan page, after the floor enters production', () => {
  it('shows the entered figures as a draft, which the admin verifies from there', async () => {
    const s = await seed();
    const f = floor((await open({ name: 'Kumar' })).body.token);
    const detailId = (await f.post('/operator', { machine: String(s.running._id), operator: String(s.ravi._id) })).body.detailId;
    expect((await f.post('/entry', { detailId, production: 820, timer: '7:30', feedback: 'beam changed' })).status).toBe(200);
    const plan = await M.ShiftPlan.findOne({}).lean();

    // Entered on the floor: 820 m a head on the 2 heads running = 1,640 m drafted, nothing verified yet.
    const before = (await adminGet(`/shift/shiftPlanById?id=${plan._id}`)).body.data;
    expect(before).toMatchObject({ totalProduction: 0, draftedProduction: 1640, pendingCount: 1, verifiedCount: 0 });
    const row = before.machines.find((m) => m.machineName === s.running.ID);
    expect(row).toMatchObject({
      status: 'pending_verification', operatorName: 'Ravi', production: 0, headsRun: 2, draftProduction: 1640,
      submitted: { production: 820, timer: '7:30:00', feedback: 'beam changed', byName: 'Kumar' },
    });
    expect(row.submitted.at).toBeTruthy();

    // Verified with the entered figures: the plan carries them for good.
    const verify = await adminPost('/shift/verify-production', { shiftId: detailId, productionMeters: row.submitted.production, timer: row.submitted.timer });
    expect(verify.status).toBe(200);
    const after = (await adminGet(`/shift/shiftPlanById?id=${plan._id}`)).body.data;
    expect(after).toMatchObject({ totalProduction: 1640, draftedProduction: 0, pendingCount: 0, verifiedCount: 1 });
    expect(after.machines.find((m) => m.machineName === s.running.ID)).toMatchObject({ status: 'closed', production: 1640, timer: '7:30:00', submitted: null, draftProduction: 0 });
  });
});

// ── The shift before's timer photo ────────────────────────────────

describe('the timer photo from the shift before', () => {
  /** A shift on `date`/`shift` for L1 with Ravi, entered with a kept timer photo. */
  async function before(s, date, shift, { photo = true } = {}) {
    const { createShiftPlan } = require('../../services/shiftPlanCreate');
    const { shiftPlan } = await createShiftPlan({ date, shiftType: shift, machines: [{ machine: s.running._id, operator: s.ravi._id }] });
    const detail = await M.ShiftDetail.findOne({ shiftPlan: shiftPlan._id, machine: s.running._id });
    await M.ShiftDetail.updateOne({ _id: detail._id }, { $set: { status: 'pending_verification', submittedTimer: '7:45:00' } });
    if (!photo) return { detail, photo: null };
    const kept = await M.TimerPhoto.create({
      shift: detail._id, contentType: 'image/png', size: PNG.length, data: `data:image/png;base64,${PNG.toString('base64')}`,
      uploadedByName: 'Night Sup', readText: '07:45:12', readKind: 'run_time', used: true, runTimeUsed: '7:45:00',
    });
    return { detail, photo: kept };
  }

  it('a day shift sees the night before; a night shift sees that day\'s day shift', async () => {
    const s = await seed();
    const { photo: night } = await before(s, '2026-10-20', 'NIGHT');
    const day = floor((await open({ date: DATE, shift: 'DAY' })).body.token);
    const res = await day.get(`/previous-timer-photo?machine=${s.running._id}`);
    expect(res.status).toBe(200);
    expect(res.body.previous).toMatchObject({
      shift: { dateKey: '2026-10-20', shift: 'NIGHT', label: 'Night shift · 20 Oct 2026' },
      operator: 'Ravi', runTime: '7:45:00',
      photo: { id: String(night._id), byName: 'Night Sup', readText: '07:45:12', runTimeUsed: '7:45:00', used: true },
    });

    const { photo: today } = await before(s, DATE, 'DAY');
    const nightToken = (await open({ date: DATE, shift: 'NIGHT' })).body.token;
    const night2 = await floor(nightToken).get(`/previous-timer-photo?machine=${s.running._id}`);
    expect(night2.body.previous).toMatchObject({ shift: { dateKey: DATE, shift: 'DAY' }, photo: { id: String(today._id) } });

    // The photo itself, with the token in the query so an <img> can ask for it.
    const file = await request(app).get(`/api/v2/floor/timer-photo/${today._id}/file?floorToken=${nightToken}`)
      .buffer(true).parse((r, cb) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(file.body, PNG)).toBe(0);
    // The day shift may see the night before's photo too, but not one further back.
    expect((await day.get(`/timer-photo/${night._id}/file`)).status).toBe(200);
    const { photo: old } = await before(s, '2026-10-18', 'DAY');
    expect((await day.get(`/timer-photo/${old._id}/file`)).status).toBe(404);
  });

  it('says so when the shift before had no plan, no entry on this loom, or no photo', async () => {
    const s = await seed();
    const f = floor((await open({ date: DATE, shift: 'DAY' })).body.token);
    expect((await f.get(`/previous-timer-photo?machine=${s.running._id}`)).body.previous).toMatchObject({ shift: { shift: 'NIGHT' }, operator: null, runTime: null, photo: null });
    await before(s, '2026-10-20', 'NIGHT', { photo: false });
    expect((await f.get(`/previous-timer-photo?machine=${s.running._id}`)).body.previous).toMatchObject({ operator: 'Ravi', runTime: '7:45:00', photo: null });
    expect((await f.get(`/previous-timer-photo?machine=${s.free._id}`)).body.previous).toMatchObject({ operator: null, photo: null });
    expect((await f.get('/previous-timer-photo?machine=nope')).status).toBe(400);
  });
});

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
