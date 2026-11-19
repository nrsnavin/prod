'use strict';
// ══════════════════════════════════════════════════════════════════
//  A MACHINE ISSUE: WHAT IS KEPT WHEN ITS STATUS MOVES, WHOSE IT IS TO
//  WITHDRAW, WHO RAISED IT, AND WHO IS TOLD
//
//  Found reading api/machineIssue.js line by line.
//
//  1. A STATUS CHANGE WIPED THE NOTES. PUT /:id/status wrote
//     `resolutionNotes` on every call — and an empty text when none was
//     sent. "Ordered the belt, due Friday" was gone the moment someone
//     moved the issue on without retyping it.
//
//  2. WHEN, AND BY WHOM. `resolvedAt` / `resolvedBy` were stamped on
//     every save of a closed issue, so correcting a note moved the time
//     it was resolved to now and the name to the one correcting. And an
//     issue moved back to "in progress" went on saying it was resolved,
//     on a day, by a person.
//
//  3. "NOBODY" WAS THE OWNER OF NOBODY'S ISSUE. Withdrawing asks whether
//     the login's employee is the issue's employee. An office login has
//     none, and neither has an issue the office raised: undefined is
//     undefined, so any such login could delete it. And an issue the
//     supervisor raised from the floor entry carries the loom's operator
//     — who could withdraw it, though it was never theirs.
//
//  4. A TITLE THAT IS NOT TEXT was a server error.
//
//  5. WHO RAISED IT. The list named the reporter only when a worker had:
//     an issue raised by the office, or from the floor entry, came with
//     nobody's name.
//
//  6. NOBODY WAS TOLD. The worker's phone answers "Maintenance team has
//     been notified"; nothing was sent to anyone. A high or critical
//     issue now goes out as the breakdown alert does — once an hour a
//     machine at most.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, ALWAYS_ON;
let admin, supervisor, worker, otherWorker, ravi, kumar;
const M = {};
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get:  (url)       => request(app).get(`/api/v2/machine-issue${url}`).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(`/api/v2/machine-issue${url}`).set('Cookie', cookieFor(u)).send(body),
  put:  (url, body) => request(app).put(`/api/v2/machine-issue${url}`).set('Cookie', cookieFor(u)).send(body),
  del:  (url)       => request(app).delete(`/api/v2/machine-issue${url}`).set('Cookie', cookieFor(u)),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Employee', 'Machine', 'MachineIssue', 'Notification', 'NotificationSettings']) M[n] = require(`../../models/${n}.js`);
  ({ ALWAYS_ON } = require('../../utils/features'));
  admin = await M.User.create({ name: 'Owner', email: 'mi-own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await M.User.create({ name: 'Floor Lead', email: 'mi-floor@t.co', password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
  await M.User.deleteMany({ _id: { $nin: [admin._id, supervisor._id] } });
});

let seq = 0;
const makeMachine = () => M.Machine.create({ ID: `LOOM-MI-${++seq}`, manufacturer: 'Comez', DateOfPurchase: new Date(), NoOfHead: 4, NoOfHooks: 12 });
/** Two operators, each with their own login. */
beforeEach(async () => {
  seq += 1;
  ravi  = await M.Employee.create({ name: 'Ravi',  phoneNumber: `91000${String(seq).padStart(5, '0')}`, department: 'weaving', role: 'operator' });
  kumar = await M.Employee.create({ name: 'Kumar', phoneNumber: `92000${String(seq).padStart(5, '0')}`, department: 'weaving', role: 'operator' });
  worker = await M.User.create({
    name: 'Ravi', email: `mi-ravi-${seq}@workers.invalid`, password: 'pass1234', role: 'production', department: 'production',
    employee: ravi._id, features: ALWAYS_ON,
  });
  otherWorker = await M.User.create({
    name: 'Kumar', email: `mi-kumar-${seq}@workers.invalid`, password: 'pass1234', role: 'production', department: 'production',
    employee: kumar._id, features: ALWAYS_ON,
  });
});

/** An issue on file. A worker's by default; `over` makes it anything else. */
const filed = async (over = {}) => M.MachineIssue.create({
  machine: (await makeMachine())._id, employee: ravi._id, reportedBy: worker._id, source: 'worker',
  title: 'Belt slipping', description: 'Slips under load', severity: 'medium', ...over,
});
const stored = (issue) => M.MachineIssue.findById(issue._id).lean();
const at = (iso) => new Date(iso);
/**
 * A high or critical issue is told to the owner after the answer has
 * gone. A test that files one waits for that to be over, so it cannot
 * land in the test after it.
 */
const alertTried = () => eventually(() => M.Notification.findOne({ event: 'machineBreakdown' }).lean());
/** Wait for something written after the answer has gone. */
const eventually = async (read, ms = 4000) => {
  const until = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 25));
  }
};
const tellSomeone = async () => {
  const s = await M.NotificationSettings.load();
  s.recipients = ['+919876543210'];
  await s.save();
};

// ══════════════════════════════════════════════════════════════════
describe('moving an issue on', () => {
  it('leaves the notes when the change says nothing of them', async () => {
    const issue = await filed({ status: 'in_progress', resolutionNotes: 'Ordered the belt, due Friday' });

    const res = await as(supervisor).put(`/${issue._id}/status`, { status: 'acknowledged' });
    expect(res.status).toBe(200);
    // Before: "".
    expect(res.body.data.resolutionNotes).toBe('Ordered the belt, due Friday');
    expect((await stored(issue)).resolutionNotes).toBe('Ordered the belt, due Friday');
  });

  it('takes the notes that are sent — an empty text clears them', async () => {
    const issue = await filed({ status: 'in_progress', resolutionNotes: 'Ordered the belt' });

    await as(supervisor).put(`/${issue._id}/status`, { status: 'in_progress', resolutionNotes: 'Belt arrived; fitting tomorrow' });
    expect((await stored(issue)).resolutionNotes).toBe('Belt arrived; fitting tomorrow');

    await as(supervisor).put(`/${issue._id}/status`, { status: 'in_progress', resolutionNotes: '' });
    expect((await stored(issue)).resolutionNotes).toBe('');
  });

  it('records the closing: when, and by whom', async () => {
    const issue = await filed({ status: 'in_progress' });
    const before = Date.now();

    const res = await as(supervisor).put(`/${issue._id}/status`, { status: 'resolved', resolutionNotes: 'Belt replaced' });
    expect(res.status).toBe(200);
    const saved = await stored(issue);
    expect(String(saved.resolvedBy)).toBe(String(supervisor._id));
    expect(new Date(saved.resolvedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(saved.resolvedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('does not move the closing when a closed issue is saved again', async () => {
    const issue = await filed({
      status: 'resolved', resolutionNotes: 'Belt replaced', resolvedAt: at('2026-11-10T06:30:00Z'), resolvedBy: admin._id,
    });

    const res = await as(supervisor).put(`/${issue._id}/status`, { status: 'resolved', resolutionNotes: 'Belt replaced; pulley checked too' });
    expect(res.status).toBe(200);
    const saved = await stored(issue);
    expect(saved.resolutionNotes).toBe('Belt replaced; pulley checked too');
    // Before: today, by the Floor Lead.
    expect(new Date(saved.resolvedAt).toISOString()).toBe('2026-11-10T06:30:00.000Z');
    expect(String(saved.resolvedBy)).toBe(String(admin._id));
  });

  it('stamps it again when the decision itself changes', async () => {
    const issue = await filed({ status: 'resolved', resolvedAt: at('2026-11-10T06:30:00Z'), resolvedBy: admin._id });

    await as(supervisor).put(`/${issue._id}/status`, { status: 'rejected', resolutionNotes: 'Not a fault: wrong setting' });
    const saved = await stored(issue);
    expect(saved.status).toBe('rejected');
    expect(String(saved.resolvedBy)).toBe(String(supervisor._id));
    expect(new Date(saved.resolvedAt).getTime()).toBeGreaterThan(at('2026-11-11T00:00:00Z').getTime());
  });

  it('no longer says it was resolved once it is open again', async () => {
    const issue = await filed({
      status: 'resolved', resolutionNotes: 'Belt replaced', resolvedAt: at('2026-11-10T06:30:00Z'), resolvedBy: admin._id,
    });

    const res = await as(supervisor).put(`/${issue._id}/status`, { status: 'in_progress', resolutionNotes: 'Slipping again' });
    expect(res.status).toBe(200);
    const saved = await stored(issue);
    expect(saved.status).toBe('in_progress');
    // Before: still "resolved 10 Nov, by Owner".
    expect(saved.resolvedAt).toBeUndefined();
    expect(saved.resolvedBy).toBeUndefined();
    expect(res.body.data.resolvedAt).toBeUndefined();
  });

  it('answers with what the page shows: the reporter, their department, who closed it', async () => {
    const issue = await filed({ status: 'in_progress' });

    const res = await as(supervisor).put(`/${issue._id}/status`, { status: 'resolved', resolutionNotes: 'Belt replaced' });
    // Before: the employee's name alone, and an id for who resolved it.
    expect(res.body.data.employee).toMatchObject({ name: 'Ravi', department: 'weaving' });
    expect(res.body.data.resolvedBy).toMatchObject({ name: 'Floor Lead' });
    expect(res.body.data.machine.ID).toMatch(/^LOOM-MI-/);
  });

  it('refuses a status that is not one, and an issue that is not there (unchanged)', async () => {
    const issue = await filed();
    expect((await as(supervisor).put(`/${issue._id}/status`, { status: 'dismissed' })).status).toBe(400);
    expect((await as(supervisor).put(`/${new mongoose.Types.ObjectId()}/status`, { status: 'resolved' })).status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('withdrawing an issue', () => {
  it('is not for a login with no employee, of an issue with none', async () => {
    // Raised by the owner from the office: no employee on it.
    const issue = await filed({ employee: undefined, reportedBy: admin._id, source: 'admin' });

    const res = await as(supervisor).del(`/${issue._id}`);
    // Before: 200 — nobody's employee "was" nobody's employee.
    expect(res.status).toBe(403);
    expect(await stored(issue)).not.toBeNull();
  });

  it('is not the operator\'s when the supervisor raised it from the floor entry', async () => {
    const issue = await filed({ source: 'floor', reportedBy: undefined, reportedByName: 'Murugan' });

    const res = await as(worker).del(`/${issue._id}`);
    // Before: 200 — the loom's operator is on it, so it counted as theirs.
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/floor/i);
    expect(await stored(issue)).not.toBeNull();
  });

  it('is the worker\'s who raised it (unchanged)', async () => {
    const issue = await filed();
    const res = await as(worker).del(`/${issue._id}`);
    expect(res.status).toBe(200);
    expect(await stored(issue)).toBeNull();
  });

  it('is not another worker\'s (unchanged)', async () => {
    const issue = await filed();
    expect((await as(otherWorker).del(`/${issue._id}`)).status).toBe(403);
    expect(await stored(issue)).not.toBeNull();
  });

  it('is the owner\'s, whoever raised it (unchanged)', async () => {
    const mine = await filed({ employee: undefined, reportedBy: admin._id, source: 'admin' });
    const floor = await filed({ source: 'floor', reportedBy: undefined, reportedByName: 'Murugan' });
    expect((await as(admin).del(`/${mine._id}`)).status).toBe(200);
    expect((await as(admin).del(`/${floor._id}`)).status).toBe(200);
    expect(await M.MachineIssue.countDocuments()).toBe(0);
  });

  it('is over once the office has picked it up (unchanged)', async () => {
    const issue = await filed({ status: 'acknowledged' });
    const res = await as(worker).del(`/${issue._id}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/open/i);
    expect(await stored(issue)).not.toBeNull();
  });

  it('an id that is not one, or not there, is said so (unchanged)', async () => {
    expect((await as(worker).del('/not-an-id')).status).toBe(400);
    expect((await as(worker).del(`/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('raising an issue', () => {
  it('a title or description that is not text is refused, not a server error', async () => {
    const machine = await makeMachine();
    const base = { machineId: String(machine._id), title: 'Belt slipping', description: 'Slips under load' };

    const noTitle = await as(worker).post('/', { ...base, title: 42 });
    // Before: 500 — "title?.trim is not a function".
    expect(noTitle.status).toBe(400);
    expect(noTitle.body.message).toMatch(/title/i);

    const noText = await as(worker).post('/', { ...base, description: { said: 'slips' } });
    expect(noText.status).toBe(400);
    expect(noText.body.message).toMatch(/description/i);

    expect(await M.MachineIssue.countDocuments()).toBe(0);
  });

  it('a worker files under their own name, whatever id is sent (unchanged)', async () => {
    const machine = await makeMachine();
    const res = await as(worker).post('/', {
      machineId: String(machine._id), employeeId: String(kumar._id), title: ' Belt slipping ', description: ' Slips under load ',
    });
    expect(res.status).toBe(201);
    const saved = await M.MachineIssue.findOne().lean();
    expect(String(saved.employee)).toBe(String(ravi._id));
    expect(saved).toMatchObject({ source: 'worker', title: 'Belt slipping', description: 'Slips under load', severity: 'medium', status: 'open' });
  });

  it('the owner raises one with no employee on it (unchanged)', async () => {
    const machine = await makeMachine();
    const res = await as(admin).post('/', { machineId: String(machine._id), title: 'Guard missing', description: 'Side guard not refitted', severity: 'high' });
    expect(res.status).toBe(201);
    const saved = await M.MachineIssue.findOne().lean();
    expect(saved.employee).toBeUndefined();
    expect(String(saved.reportedBy)).toBe(String(admin._id));
    expect(saved.source).toBe('admin');
    await alertTried();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('who raised it', () => {
  it('is on the list and on the issue, whoever it was', async () => {
    const byWorker = await filed({ title: 'By the operator' });
    const byOffice = await filed({ title: 'By the office', employee: undefined, reportedBy: admin._id, source: 'admin' });
    const byFloor  = await filed({ title: 'From the floor', source: 'floor', reportedBy: undefined, reportedByName: 'Murugan' });

    const list = await as(supervisor).get('/');
    expect(list.status).toBe(200);
    const by = Object.fromEntries(list.body.data.map((i) => [i.title, i]));
    expect(by['By the operator'].employee).toMatchObject({ name: 'Ravi' });
    // Before: an id — the office's own issues came with nobody's name.
    expect(by['By the office'].reportedBy).toMatchObject({ name: 'Owner' });
    expect(by['From the floor']).toMatchObject({ source: 'floor', reportedByName: 'Murugan' });

    const one = await as(supervisor).get(`/${byOffice._id}`);
    expect(one.body.data.reportedBy).toMatchObject({ name: 'Owner' });
    expect((await as(supervisor).get(`/${byWorker._id}`)).body.data.employee).toMatchObject({ name: 'Ravi', department: 'weaving' });
    expect((await as(supervisor).get(`/${byFloor._id}`)).body.data.reportedByName).toBe('Murugan');
  });

  it('says who closed a closed issue on the list', async () => {
    await filed({ status: 'resolved', resolutionNotes: 'Belt replaced', resolvedAt: at('2026-11-10T06:30:00Z'), resolvedBy: admin._id });
    const list = await as(supervisor).get('/?status=resolved');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].resolvedBy).toMatchObject({ name: 'Owner' });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('telling the owner', () => {
  const alerts = () => M.Notification.find({ event: 'machineBreakdown' }).lean();

  it('a critical issue goes out as the breakdown alert does', async () => {
    await tellSomeone();
    const machine = await makeMachine();

    const res = await as(worker).post('/', {
      machineId: String(machine._id), title: 'Smoke from the motor', description: 'Smoke and a burning smell from the main motor', severity: 'critical',
    });
    expect(res.status).toBe(201);

    // Before: nothing, ever — though the phone says "notified".
    const rows = await eventually(async () => { const r = await alerts(); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('dry_run');                       // no provider in a test
    expect(rows[0].body).toMatch(/critical/i);
    expect(rows[0].body).toContain(machine.ID);
    expect(rows[0].body).toContain('Smoke from the motor');
    expect(rows[0].body).toContain('Ravi');
    expect(String(rows[0].entity.id)).toBe(String(machine._id));
  });

  it('so does a high one; a medium or low one does not', async () => {
    await tellSomeone();
    const { alertIfUrgent } = require('../../services/machineIssueAlert');
    const [a, b, c] = [await makeMachine(), await makeMachine(), await makeMachine()];

    const high = await M.MachineIssue.create({ machine: a._id, employee: ravi._id, title: 'Loom stopped', description: 'Will not start', severity: 'high' });
    expect(await alertIfUrgent(high, { by: 'Ravi' })).toMatchObject({ sent: 0 });   // tried: a dry run sends none
    expect(await alerts()).toHaveLength(1);

    const medium = await M.MachineIssue.create({ machine: b._id, employee: ravi._id, title: 'Noisy', description: 'Rattle on the left', severity: 'medium' });
    expect(await alertIfUrgent(medium, { by: 'Ravi' })).toEqual({ skipped: 'not urgent' });
    const low = await M.MachineIssue.create({ machine: c._id, employee: ravi._id, title: 'Oil mark', description: 'A drop under the gearbox', severity: 'low' });
    expect(await alertIfUrgent(low, { by: 'Ravi' })).toEqual({ skipped: 'not urgent' });
    expect(await alerts()).toHaveLength(1);
  });

  it('a second urgent report on the same machine within the hour is not told again', async () => {
    await tellSomeone();
    const { alertIfUrgent } = require('../../services/machineIssueAlert');
    const [machine, another] = [await makeMachine(), await makeMachine()];
    const first = await M.MachineIssue.create({ machine: machine._id, employee: ravi._id, title: 'Loom stopped', description: 'Will not start', severity: 'high' });
    await alertIfUrgent(first, { by: 'Ravi' });

    const second = await M.MachineIssue.create({ machine: machine._id, employee: kumar._id, title: 'Stopped again', description: 'Same loom, still dead', severity: 'critical' });
    expect(await alertIfUrgent(second, { by: 'Kumar' })).toEqual({ skipped: 'already told' });
    expect(await alerts()).toHaveLength(1);

    // Another machine is another matter.
    const elsewhere = await M.MachineIssue.create({ machine: another._id, employee: kumar._id, title: 'Needle bar broken', description: 'Snapped', severity: 'high' });
    await alertIfUrgent(elsewhere, { by: 'Kumar' });
    expect(await alerts()).toHaveLength(2);

    // And so is the same machine two hours on. (Straight to the collection:
    // the model will not move a `createdAt`.)
    await M.MachineIssue.collection.updateMany({ machine: machine._id }, { $set: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    const later = await M.MachineIssue.create({ machine: machine._id, employee: ravi._id, title: 'Stopped once more', description: 'Dead again', severity: 'high' });
    await alertIfUrgent(later, { by: 'Ravi' });
    expect(await alerts()).toHaveLength(3);
  });

  it('never holds up, or fails, the report itself', async () => {
    // Nobody to tell: the issue is filed all the same.
    const machine = await makeMachine();
    const res = await as(worker).post('/', { machineId: String(machine._id), title: 'Loom stopped', description: 'Will not start', severity: 'high' });
    expect(res.status).toBe(201);
    expect(await M.MachineIssue.countDocuments()).toBe(1);
    expect(await alertTried()).toMatchObject({ status: 'skipped', reason: 'no recipients' });
  });
});
