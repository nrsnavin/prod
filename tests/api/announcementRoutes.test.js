'use strict';
// ══════════════════════════════════════════════════════════════════
//  A NOTICE: HOW LONG IT IS UP, AND WHAT CAN BE CHANGED OF IT
//
//  Found reading api/announcement.js line by line, beside the web form
//  and the phone's.
//
//  1. "VALID UNTIL THE 20TH" WAS NOT VALID ON THE 20TH. The end date was
//     compared with the clock. The web sends the day ("2026-11-20"), kept
//     as that day's UTC midnight — half past five in the morning in
//     India: the notice came down at 05:30 on its last day. The phone
//     sends its own midnight as an instant (18:30 UTC the evening
//     before): the notice came down as its last day began. Either way the
//     day it was meant to cover was the day it was missing. The end date
//     is now kept as a day, and a notice is up through that day.
//
//  2. AN END DATE COULD NOT BE REMOVED. Clearing it sends nothing (the
//     phone) or an empty value (an edit form): the server read both as
//     "no change". A notice given an end date by mistake kept it.
//
//  3. A TITLE THAT IS NOT TEXT was a server error when posting; an EMPTY
//     title was saved when editing (the checks on the model do not run on
//     an update).
//
//  4. TWO READERS, TWO RULES. The employee app's reader and the web's
//     each had their own copy of "what is up now", and they disagreed
//     about a notice whose start date is empty.
//
//  5. An end date before the start date was accepted — a notice nobody
//     would ever see.
//
//  6. A WORKER NEVER SAW THEIR DEPARTMENT'S NOTICES ON THE WEB. A notice
//     is addressed to where people work ("weaving"); an employee's login
//     is in "production" whatever they do, and the web's reader went by
//     the login alone.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// No model: notices stay in English, and nothing is translated behind a test.
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

let mongo, app, admin, worker, weaver, A;
const cookieFor = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get:  (url)       => request(app).get(`/api/v2/announcement${url}`).set('Cookie', cookieFor(u)),
  post: (url, body) => request(app).post(`/api/v2/announcement${url}`).set('Cookie', cookieFor(u)).send(body),
  put:  (url, body) => request(app).put(`/api/v2/announcement${url}`).set('Cookie', cookieFor(u)).send(body),
  del:  (url)       => request(app).delete(`/api/v2/announcement${url}`).set('Cookie', cookieFor(u)),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  A = require('../../models/Announcement');
  const User = require('../../models/User');
  admin  = await User.create({ name: 'Owner', email: 'an-own@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  worker = await User.create({ name: 'Ravi', email: 'an-ravi@t.co', password: 'pass1234', role: 'production', department: 'weaving' });
  // An employee's own login: in "production", whatever they do; they work in weaving.
  const kumar = await require('../../models/Employee').create({ name: 'Kumar', phoneNumber: '9400000001', department: 'weaving', role: 'operator' });
  weaver = await User.create({ name: 'Kumar', email: 'an-kumar@workers.invalid', password: 'pass1234', role: 'production', department: 'production', employee: kumar._id });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.useRealTimers();
  await A.deleteMany({});
});

/** The clock, as a time in India. Everything but `Date` runs as usual. */
const itIs = (indiaTime) => jest.useFakeTimers({
  now: new Date(`${indiaTime}+05:30`),
  doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
});
const post = async (over = {}) => {
  const res = await as(admin).post('/', { title: 'Safety drill', body: 'Friday at 4 pm', ...over });
  expect(res.status).toBe(201);
  return res.body.data;
};
/** The titles a worker in weaving sees — on the employee app, and on the web. */
const onTheApp = async () => (await as(worker).get('/active?dept=weaving')).body.data.map((n) => n.title);
const onTheWeb = async () => (await as(worker).get('/')).body.data.map((n) => n.title);
const stored = (n) => A.findById(n._id).lean();

// ══════════════════════════════════════════════════════════════════
describe('a notice valid until a day', () => {
  it('is up through that day — sent as the web sends it', async () => {
    itIs('2026-11-18T10:00:00');
    const n = await post({ validUntil: '2026-11-20' });
    expect(new Date((await stored(n)).validUntil).toISOString()).toBe('2026-11-20T00:00:00.000Z');

    itIs('2026-11-20T05:29:00');
    expect(await onTheApp()).toEqual(['Safety drill']);
    // Before: gone from here on — 05:30 in India is that day's UTC midnight.
    itIs('2026-11-20T10:00:00');
    expect(await onTheApp()).toEqual(['Safety drill']);
    expect(await onTheWeb()).toEqual(['Safety drill']);
    itIs('2026-11-20T23:59:00');
    expect(await onTheApp()).toEqual(['Safety drill']);

    // The day after, it is down.
    itIs('2026-11-21T00:01:00');
    expect(await onTheApp()).toEqual([]);
    expect(await onTheWeb()).toEqual([]);
  });

  it('is up through that day — sent as the phone sends it', async () => {
    itIs('2026-11-18T10:00:00');
    // The phone's own midnight on the 20th, as an instant.
    const n = await post({ validUntil: '2026-11-19T18:30:00.000Z' });
    // Kept as the day it names.
    expect(new Date((await stored(n)).validUntil).toISOString()).toBe('2026-11-20T00:00:00.000Z');

    // Before: gone as the 20th began.
    itIs('2026-11-20T00:01:00');
    expect(await onTheApp()).toEqual(['Safety drill']);
    itIs('2026-11-20T18:00:00');
    expect(await onTheApp()).toEqual(['Safety drill']);
    itIs('2026-11-21T00:01:00');
    expect(await onTheApp()).toEqual([]);
  });

  it('is up through that day when it was stored the old way, too', async () => {
    // On file from before: the phone's instant, as it came.
    await A.create({ title: 'Old notice', body: 'x', validFrom: new Date('2026-11-01T00:00:00Z'), validUntil: new Date('2026-11-19T18:30:00.000Z') });
    itIs('2026-11-20T15:00:00');
    expect(await onTheApp()).toEqual(['Old notice']);
    itIs('2026-11-21T00:01:00');
    expect(await onTheApp()).toEqual([]);
  });

  it('with no end date stays up (unchanged)', async () => {
    itIs('2026-11-18T10:00:00');
    await post();
    itIs('2027-06-01T10:00:00');
    expect(await onTheApp()).toEqual(['Safety drill']);
  });

  it('cannot end before it begins', async () => {
    itIs('2026-11-18T10:00:00');
    const res = await as(admin).post('/', { title: 'Safety drill', body: 'Friday at 4 pm', validFrom: '2026-11-25', validUntil: '2026-11-20' });
    // Before: 201 — a notice nobody would ever see.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/before/i);
    expect(await A.countDocuments()).toBe(0);

    // The same day is a notice for that day.
    expect((await as(admin).post('/', { title: 'One day', body: 'x', validFrom: '2026-11-25', validUntil: '2026-11-25' })).status).toBe(201);
  });

  it('refuses a date that is not one (unchanged)', async () => {
    expect((await as(admin).post('/', { title: 'x', body: 'y', validUntil: 'next week' })).status).toBe(400);
    const n = await post();
    expect((await as(admin).put(`/${n._id}`, { validUntil: 'next week' })).status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a notice that starts on a day', () => {
  it('is up from the start of that day in India', async () => {
    itIs('2026-11-18T10:00:00');
    await post({ validFrom: '2026-11-20' });
    itIs('2026-11-19T23:59:00');
    expect(await onTheApp()).toEqual([]);
    // Before: not until 05:30.
    itIs('2026-11-20T00:01:00');
    expect(await onTheApp()).toEqual(['Safety drill']);
  });

  it('with an empty start date is up on both readers alike', async () => {
    // On file with its start date empty.
    await A.collection.insertOne({ title: 'No start', body: 'x', type: 'info', audience: 'all', department: '', isActive: true, isPinned: false, validFrom: null, createdAt: new Date(), updatedAt: new Date() });
    expect(await onTheWeb()).toEqual(['No start']);
    // Before: the employee app did not show it.
    expect(await onTheApp()).toEqual(['No start']);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('editing a notice', () => {
  it('can take its end date away', async () => {
    itIs('2026-11-18T10:00:00');
    const n = await post({ validUntil: '2026-11-20' });

    const res = await as(admin).put(`/${n._id}`, { validUntil: null });
    expect(res.status).toBe(200);
    // Before: still the 20th — null was read as "no change".
    expect((await stored(n)).validUntil).toBeUndefined();
    expect(res.body.data.validUntil).toBeUndefined();

    itIs('2026-12-25T10:00:00');
    expect(await onTheApp()).toEqual(['Safety drill']);
  });

  it('takes an empty end date as taking it away, too', async () => {
    const n = await post({ validUntil: '2026-11-20' });
    await as(admin).put(`/${n._id}`, { validUntil: '' });
    expect((await stored(n)).validUntil).toBeUndefined();
  });

  it('leaves the end date alone when the change says nothing of it', async () => {
    const n = await post({ validUntil: '2026-11-20' });
    await as(admin).put(`/${n._id}`, { isPinned: true });
    const saved = await stored(n);
    expect(saved.isPinned).toBe(true);
    expect(new Date(saved.validUntil).toISOString()).toBe('2026-11-20T00:00:00.000Z');
  });

  it('can move the end date, kept as the day', async () => {
    const n = await post({ validUntil: '2026-11-20' });
    await as(admin).put(`/${n._id}`, { validUntil: '2026-11-24T18:30:00.000Z' });      // the phone's 25th
    expect(new Date((await stored(n)).validUntil).toISOString()).toBe('2026-11-25T00:00:00.000Z');
  });

  it('cannot move the end before the beginning', async () => {
    itIs('2026-11-18T10:00:00');
    const n = await post({ validFrom: '2026-11-25' });
    const res = await as(admin).put(`/${n._id}`, { validUntil: '2026-11-20' });
    expect(res.status).toBe(400);
    expect((await stored(n)).validUntil).toBeUndefined();
  });

  it('does not save an empty title or message', async () => {
    const n = await post();
    const noTitle = await as(admin).put(`/${n._id}`, { title: '   ' });
    // Before: 200, and a notice with no title.
    expect(noTitle.status).toBe(400);
    expect((await as(admin).put(`/${n._id}`, { body: '' })).status).toBe(400);
    expect((await as(admin).put(`/${n._id}`, { title: 42 })).status).toBe(400);
    expect(await stored(n)).toMatchObject({ title: 'Safety drill', body: 'Friday at 4 pm' });

    const ok = await as(admin).put(`/${n._id}`, { title: '  Fire drill  ' });
    expect(ok.status).toBe(200);
    expect((await stored(n)).title).toBe('Fire drill');
  });

  it('takes it down and puts it back (unchanged)', async () => {
    const n = await post();
    expect((await as(admin).del(`/${n._id}`)).status).toBe(200);
    expect(await onTheApp()).toEqual([]);
    expect((await as(admin).get('/')).body.data.map((x) => [x.title, x.isActive])).toEqual([['Safety drill', false]]);
    expect((await as(admin).put(`/${n._id}`, { isActive: true })).status).toBe(200);
    expect(await onTheApp()).toEqual(['Safety drill']);
  });

  it('says so when the notice is not there, or the id is not one (unchanged)', async () => {
    expect((await as(admin).put(`/${new mongoose.Types.ObjectId()}`, { isPinned: true })).status).toBe(404);
    expect((await as(admin).put('/not-an-id', { isPinned: true })).status).toBe(400);
    expect((await as(worker).put(`/${new mongoose.Types.ObjectId()}`, { isPinned: true })).status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('posting a notice', () => {
  it('a title or message that is not text is refused, not a server error', async () => {
    const noTitle = await as(admin).post('/', { title: 42, body: 'x' });
    // Before: 500 — "title?.trim is not a function".
    expect(noTitle.status).toBe(400);
    expect((await as(admin).post('/', { title: 'x', body: ['y'] })).status).toBe(400);
    expect((await as(admin).post('/', { title: 'x', body: 'y', audience: 'department', department: 7 })).status).toBe(400);
    expect(await A.countDocuments()).toBe(0);
  });

  it('a link that is not a web address is refused', async () => {
    const res = await as(admin).post('/', { title: 'x', body: 'y', attachmentUrl: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/http/i);
    expect((await as(admin).post('/', { title: 'x', body: 'y', attachmentUrl: 'https://example.com/notice.pdf' })).status).toBe(201);
  });

  it('keeps to its kinds and its audiences (unchanged)', async () => {
    expect((await as(admin).post('/', { title: 'x', body: 'y', type: 'urgent' })).status).toBe(400);
    expect((await as(admin).post('/', { title: 'x', body: 'y', audience: 'department' })).status).toBe(400);
    const n = await post({ type: 'safety', audience: 'department', department: ' weaving ' });
    expect(n).toMatchObject({ type: 'safety', audience: 'department', department: 'weaving' });
  });

  it('for a department reaches an employee who works there, on the web as on the phone', async () => {
    await post({ title: 'For weaving', audience: 'department', department: 'weaving' });
    await post({ title: 'For packing', audience: 'department', department: 'packing' });
    await post({ title: 'For production', audience: 'department', department: 'production' });
    const titles = async (url) => (await as(weaver).get(url)).body.data.map((n) => n.title).sort();
    // The phone, which says where they work:
    expect(await titles('/active?dept=weaving')).toEqual(['For production', 'For weaving']);
    // The web, which does not. Before: "For production" alone — never their own department's.
    expect(await titles('/active')).toEqual(['For production', 'For weaving']);
    expect(await titles('/')).toEqual(['For production', 'For weaving']);
  });

  it('for one department reaches that department only (unchanged)', async () => {
    await post({ title: 'For weaving', audience: 'department', department: 'weaving' });
    await post({ title: 'For packing', audience: 'department', department: 'packing' });
    await post({ title: 'For all' });
    expect((await onTheApp()).sort()).toEqual(['For all', 'For weaving']);
    expect((await onTheWeb()).sort()).toEqual(['For all', 'For weaving']);
  });
});
