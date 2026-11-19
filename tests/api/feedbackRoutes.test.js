'use strict';
// ══════════════════════════════════════════════════════════════════
//  ANSWERING A WORKER'S FEEDBACK
//
//  Found reading api/feedback.js line by line.
//
//  1. A CHANGE OF STATUS WIPED THE REPLY. PUT /:id/respond wrote the
//     response on every call — an empty text when none was sent. Marking
//     an answered note "closed" erased the answer the worker had read.
//
//  2. WHO REPLIED, AND WHEN, was stamped on every save: the admin who
//     closed a note a week later became the one who had "responded",
//     that day.
//
//  3. A NOTE THE OFFICE HAD JUST TAKEN UP could still be withdrawn: the
//     status was read, then the note deleted, as two steps.
//
//  (The web inbox's own faults — it showed no feedback text, and its
//  reply was always refused — are pinned in the web's tests.)
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, ALWAYS_ON, owner, manager, worker, ravi;
const M = {};
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role, v: u.tokenVersion ?? 0 }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get:  (url)       => request(app).get(`/api/v2/feedback${url}`).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(`/api/v2/feedback${url}`).set('Cookie', cookieFor(u)).send(body),
  put:  (url, body) => request(app).put(`/api/v2/feedback${url}`).set('Cookie', cookieFor(u)).send(body),
  del:  (url)       => request(app).delete(`/api/v2/feedback${url}`).set('Cookie', cookieFor(u)),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  for (const n of ['User', 'Employee', 'EmployeeFeedback', 'Notification', 'NotificationSettings']) M[n] = require(`../../models/${n}.js`);
  ({ ALWAYS_ON } = require('../../utils/features'));
  ravi = await M.Employee.create({ name: 'Ravi', phoneNumber: '9300000001', department: 'weaving', role: 'operator' });
  owner = await M.User.create({ name: 'Owner', email: 'fb-own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  manager = await M.User.create({ name: 'Manager', email: 'fb-mgr@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  worker = await M.User.create({
    name: 'Ravi', email: 'fb-ravi@workers.invalid', password: 'pass1234', role: 'production', department: 'production',
    employee: ravi._id, features: ALWAYS_ON,
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (!['users', 'employees'].includes(c.collectionName)) await c.deleteMany({});
  }
});

const note = (over = {}) => M.EmployeeFeedback.create({
  employee: ravi._id, type: 'complaint', category: 'facilities', subject: 'Canteen water', body: 'The cooler is broken.', ...over,
});
const stored = (n) => M.EmployeeFeedback.findById(n._id).lean();
const at = (iso) => new Date(iso);
const eventually = async (read, ms = 4000) => {
  const until = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 25));
  }
};

// ══════════════════════════════════════════════════════════════════
describe('the reply to a note', () => {
  it('is kept when only the status is changed', async () => {
    const n = await note({ status: 'in_review', response: 'A new cooler is ordered.', respondedBy: owner._id, respondedAt: at('2026-11-10T06:30:00Z') });

    const res = await as(manager).put(`/${n._id}/respond`, { status: 'closed' });
    expect(res.status).toBe(200);
    const saved = await stored(n);
    expect(saved.status).toBe('closed');
    // Before: "".
    expect(saved.response).toBe('A new cooler is ordered.');
    expect(res.body.data.response).toBe('A new cooler is ordered.');
  });

  it('keeps who gave it, and when, through a change of status', async () => {
    const n = await note({ status: 'in_review', response: 'A new cooler is ordered.', respondedBy: owner._id, respondedAt: at('2026-11-10T06:30:00Z') });

    await as(manager).put(`/${n._id}/respond`, { status: 'resolved' });
    await as(manager).put(`/${n._id}/respond`, { status: 'closed', response: 'A new cooler is ordered.' });   // re-sent as it was
    const saved = await stored(n);
    // Before: the Manager, today.
    expect(String(saved.respondedBy)).toBe(String(owner._id));
    expect(new Date(saved.respondedAt).toISOString()).toBe('2026-11-10T06:30:00.000Z');
  });

  it('is stamped with whoever writes or changes it', async () => {
    const n = await note();
    const before = Date.now();

    const first = await as(owner).put(`/${n._id}/respond`, { response: 'Looking into it.', status: 'in_review' });
    expect(first.status).toBe(200);
    let saved = await stored(n);
    expect(saved).toMatchObject({ response: 'Looking into it.', status: 'in_review' });
    expect(String(saved.respondedBy)).toBe(String(owner._id));
    expect(new Date(saved.respondedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);

    await as(manager).put(`/${n._id}/respond`, { response: 'A new cooler is fitted.', status: 'resolved' });
    saved = await stored(n);
    expect(saved).toMatchObject({ response: 'A new cooler is fitted.', status: 'resolved' });
    expect(String(saved.respondedBy)).toBe(String(manager._id));
  });

  it('can be sent without a status: the status stays (unchanged)', async () => {
    const n = await note({ status: 'in_review' });
    await as(owner).put(`/${n._id}/respond`, { response: 'Ordered.' });
    expect(await stored(n)).toMatchObject({ status: 'in_review', response: 'Ordered.' });
  });

  it('can be taken back: an empty text, sent, clears it', async () => {
    const n = await note({ status: 'in_review', response: 'Sent to the wrong note.', respondedBy: owner._id, respondedAt: at('2026-11-10T06:30:00Z') });
    await as(owner).put(`/${n._id}/respond`, { response: '' });
    expect((await stored(n)).response).toBe('');
  });

  it('refuses a status that is not one, and a note that is not there (unchanged)', async () => {
    const n = await note();
    const bad = await as(owner).put(`/${n._id}/respond`, { response: 'Thanks', status: 'responded' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/open, in_review, resolved, rejected, closed/);
    expect((await as(owner).put(`/${new mongoose.Types.ObjectId()}/respond`, { status: 'closed' })).status).toBe(404);
    expect((await as(owner).put('/not-an-id/respond', { status: 'closed' })).status).toBe(400);
    expect((await as(worker).put(`/${n._id}/respond`, { status: 'closed' })).status).toBe(403);
  });

  it('answers with who replied, by name', async () => {
    const n = await note();
    const res = await as(owner).put(`/${n._id}/respond`, { response: 'Looking into it.', status: 'in_review' });
    // Before: an id.
    expect(res.body.data.respondedBy).toMatchObject({ name: 'Owner' });
    expect(res.body.data.employee).toMatchObject({ name: 'Ravi' });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('withdrawing a note', () => {
  it('is the author\'s while it is open (unchanged)', async () => {
    const n = await note();
    expect((await as(worker).del(`/${n._id}`)).status).toBe(200);
    expect(await stored(n)).toBeNull();
  });

  it('is over once the office has taken it up (unchanged)', async () => {
    const n = await note({ status: 'in_review' });
    const res = await as(worker).del(`/${n._id}`);
    expect(res.status).toBe(400);
    expect(await stored(n)).not.toBeNull();
  });

  it('does not remove a note the office took up between the check and the delete', async () => {
    const n = await note();
    // The office answers at the very moment the worker withdraws: whichever
    // lands, the note is never both answered and gone.
    const [gone, answered] = await Promise.all([
      as(worker).del(`/${n._id}`),
      as(owner).put(`/${n._id}/respond`, { response: 'Looking into it.', status: 'in_review' }),
    ]);
    const left = await stored(n);
    if (gone.status === 200) {
      expect(left).toBeNull();
      expect(answered.status).toBe(404);
    } else {
      expect(gone.status).toBe(400);
      expect(left).toMatchObject({ status: 'in_review', response: 'Looking into it.' });
    }
  });
});

// ══════════════════════════════════════════════════════════════════
describe('telling the owner of a complaint', () => {
  const told = () => M.Notification.find({ event: 'customerComplaintFiled', status: 'dry_run' }).lean();
  const tellSomeone = async () => {
    const s = await M.NotificationSettings.load();
    s.recipients = ['+919876543210'];
    await s.save();
  };
  const send = (over = {}) => as(worker).post('/', {
    employeeId: String(ravi._id), type: 'complaint', category: 'management', subject: 'Night shift supervisor', body: 'Shouts at the operators.', ...over,
  });

  it('names the author of a note sent with a name', async () => {
    await tellSomeone();
    expect((await send()).status).toBe(201);
    const rows = await eventually(async () => { const r = await told(); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/From: Ravi/);
  });

  it('never names the author of an anonymous one', async () => {
    await tellSomeone();
    expect((await send({ isAnonymous: true })).status).toBe(201);
    const rows = await eventually(async () => { const r = await told(); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toMatch(/From: \(anonymous\)/);
    expect(rows[0].body).not.toMatch(/Ravi/);
  });

  it('goes by what was stored: "false" as text is a note with a name', async () => {
    await tellSomeone();
    const res = await send({ isAnonymous: 'false' });
    expect(res.body.data.isAnonymous).toBe(false);
    const rows = await eventually(async () => { const r = await told(); return r.length ? r : null; });
    // Before: "(anonymous)" — for a note the office list shows with its name.
    expect(rows[0].body).toMatch(/From: Ravi/);
  });

  it('a suggestion wakes nobody (unchanged)', async () => {
    await tellSomeone();
    expect((await send({ type: 'suggestion' })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 200));
    expect(await M.Notification.countDocuments({ event: 'customerComplaintFiled' })).toBe(0);
  });
});
