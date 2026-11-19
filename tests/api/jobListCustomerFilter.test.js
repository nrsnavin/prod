'use strict';
// ══════════════════════════════════════════════════════════════════
//  FILTERING THE JOB LIST BY CUSTOMER
//
//  Added for the complaint form, whose job picker has to offer the jobs
//  one specific customer received. The alternatives were both wrong:
//
//    • `search` only matches an integer job number, so it cannot find
//      "this customer's jobs" at all;
//    • filtering the returned page client-side hides every job outside
//      the newest twenty — and a complaint is usually about goods
//      delivered months ago, which is to say all of them.
//
//  GET /job/jobs had no test coverage of any kind before this. These
//  cover the new parameter and the two existing ones beside it, so a
//  future change to the filter block has something to fail against.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let JobOrder, Order, Customer, Elastic, User;
let admin, alpha, beta, elastic;

const cookieFor = (u) => [
  `token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app      = require('../../app.js');
  JobOrder = require('../../models/JobOrder');
  Order    = require('../../models/Order');
  Customer = require('../../models/Customer');
  Elastic  = require('../../models/Elastic');
  User     = require('../../models/User');

  admin = await User.create({
    name: 'Admin', email: 'joblist-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;

beforeEach(async () => {
  alpha = await Customer.create({
    name: 'Alpha', contactName: 'Alpha', phoneNumber: `9${String(seq++).padStart(9, '0')}`,
  });
  beta = await Customer.create({
    name: 'Beta', contactName: 'Beta', phoneNumber: `9${String(seq++).padStart(9, '0')}`,
  });
  elastic = await Elastic.create({
    name: `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
    pick: 12, noOfHook: 8, weight: 2.4,
  });
});

afterEach(async () => {
  await Promise.all([
    JobOrder.deleteMany({}), Order.deleteMany({}),
    Customer.deleteMany({}), Elastic.deleteMany({}),
  ]);
});

async function makeJob(customer, status = 'weaving') {
  const order = await Order.create({
    customer, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
  });
  return JobOrder.create({
    order: order._id, customer, date: new Date(), status,
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
  });
}

const list = (query = '') =>
  request(app).get(`/api/v2/job/jobs${query}`).set('Cookie', cookieFor(admin));

describe('GET /job/jobs?customer=', () => {
  test('returns only that customer\'s jobs', async () => {
    await makeJob(alpha._id);
    await makeJob(alpha._id);
    await makeJob(beta._id);

    const res = await list(`?customer=${alpha._id}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(2);
    for (const j of res.body.jobs) {
      expect(String(j.customer._id)).toBe(String(alpha._id));
    }
    expect(res.body.pagination.total).toBe(2);
  });

  test('reaches past the first page — the whole reason it is server-side', async () => {
    // One recent job for Beta and an older one for Alpha. Filtering the
    // returned page instead would find nothing for Alpha at limit=1.
    const old = await makeJob(alpha._id);
    await JobOrder.updateOne({ _id: old._id }, { createdAt: new Date('2025-01-01') });
    await makeJob(beta._id);

    const res = await list(`?customer=${alpha._id}&limit=1`);
    expect(res.body.jobs).toHaveLength(1);
    expect(String(res.body.jobs[0]._id)).toBe(String(old._id));
  });

  test('combines with the status filter', async () => {
    await makeJob(alpha._id, 'weaving');
    await makeJob(alpha._id, 'completed');
    await makeJob(beta._id, 'completed');

    const res = await list(`?customer=${alpha._id}&status=completed`);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].status).toBe('completed');
  });

  test('a malformed customer id is a 400, not a silent empty list', async () => {
    // An empty list reads as "this customer has no jobs", which would
    // send somebody looking for a job that is right there.
    await makeJob(alpha._id);
    const res = await list('?customer=not-an-id');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid customer id/i);
  });

  test('omitting it returns everybody, as before', async () => {
    await makeJob(alpha._id);
    await makeJob(beta._id);

    const res = await list();
    expect(res.body.jobs).toHaveLength(2);
  });

  test('an unknown but well-formed customer returns nothing', async () => {
    await makeJob(alpha._id);
    const res = await list(`?customer=${new mongoose.Types.ObjectId()}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(0);
  });

  test('an invalid status is still rejected', async () => {
    const res = await list('?status=nonsense');
    expect(res.status).toBe(400);
  });
});

describe('GET /job/jobs — what the list shows of each job', () => {
  test('carries its order and its metres planned, made and packed', async () => {
    const job = await makeJob(alpha._id);
    await JobOrder.updateOne({ _id: job._id }, {
      producedElastic: [{ elastic: elastic._id, quantity: 400 }],
      packedElastic: [{ elastic: elastic._id, quantity: 150 }],
    });
    const res = await list();
    expect(res.status).toBe(200);
    const row = res.body.jobs.find((j) => String(j._id) === String(job._id));
    expect(row.order).toEqual(expect.objectContaining({ orderNo: expect.any(Number), supplyDate: expect.any(String) }));
    expect(row.elastics.map((e) => e.quantity)).toEqual([1000]);
    expect(row.producedElastic.map((e) => e.quantity)).toEqual([400]);
    expect(row.packedElastic.map((e) => e.quantity)).toEqual([150]);
    // Still the slim row: nothing heavy such as shift details came along.
    expect(row.shiftDetails).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
//  Found reading api/jobPlanning.js line by line.
//
//  THE SEARCH BOX says "Search by job number", and the list beside it
//  prints job numbers as "J-12". Only a bare whole number was read as a
//  search; anything else — "J-12", "j12", "12abc" — was dropped, and the
//  WHOLE list came back as though it had matched.
// ══════════════════════════════════════════════════════════════════
describe('GET /job/jobs?search=', () => {
  const numbers = (res) => res.body.jobs.map((j) => j.jobOrderNo);
  let first, second;
  beforeEach(async () => {
    first = await makeJob(alpha._id);
    second = await makeJob(beta._id);
  });

  test('the bare number finds that job, as before', async () => {
    const res = await list(`?search=${first.jobOrderNo}`);
    expect(numbers(res)).toEqual([first.jobOrderNo]);
    expect(res.body.pagination.total).toBe(1);
  });

  test.each([
    ['J-12, as the list prints it', (n) => `J-${n}`],
    ['j12', (n) => `j${n}`],
    ['J 12', (n) => `J ${n}`],
    ['#12', (n) => `%23${n}`],
    ['with spaces round it', (n) => `%20${n}%20`],
  ])('%s finds it too', async (_what, write) => {
    const res = await list(`?search=${write(second.jobOrderNo)}`);
    expect(res.status).toBe(200);
    // Before: every job on the list.
    expect(numbers(res)).toEqual([second.jobOrderNo]);
  });

  test.each([['12abc'], ['Alpha'], ['12.5'], ['J-']])('"%s" is no job\'s number: nothing, not everything', async (text) => {
    const res = await list(`?search=${encodeURIComponent(text)}`);
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.pagination).toMatchObject({ total: 0, hasMore: false });
  });

  test('a number no job has finds nothing', async () => {
    const res = await list('?search=999999');
    expect(res.body.jobs).toEqual([]);
  });

  test('an empty box is no search', async () => {
    expect((await list('?search=')).body.jobs).toHaveLength(2);
    expect((await list('?search=%20')).body.jobs).toHaveLength(2);
  });
});

describe('GET /job/ — the older list', () => {
  const older = (query = '') => request(app).get(`/api/v2/job/${query}`).set('Cookie', cookieFor(admin));
  beforeEach(async () => { await makeJob(alpha._id); await makeJob(beta._id, 'completed'); });

  test('still lists', async () => {
    const res = await older();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, pages: 1 });
    expect(res.body.data).toHaveLength(2);
  });

  test.each([
    ['page 0', '?page=0'],
    ['a page that is not a number', '?page=abc'],
    ['a size that is not a number', '?limit=abc'],
    ['a size of nothing', '?limit=0'],
    ['a negative size', '?limit=-5'],
  ])('%s is the first page at an ordinary size, not a server error', async (_what, query) => {
    const res = await older(query);
    // Before: 500 for most of these; limit=0 sent every job there is.
    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pages).toBe(1);
    expect(res.body.data).toHaveLength(2);
  });

  test('a page is at most 100 jobs however many are asked for', async () => {
    const res = await older('?limit=100000');
    expect(res.status).toBe(200);
    expect(res.body.pages).toBe(1);
  });

  test('filters by a real status, and refuses one that is not', async () => {
    expect((await older('?status=completed')).body.data.map((j) => j.status)).toEqual(['completed']);
    const bad = await older('?status=nonsense');
    expect(bad.status).toBe(400);
  });
});

describe('GET /job/detail', () => {
  test('carries the machine\'s heads and the customer\'s phone — it asked for fields that do not exist', async () => {
    const Machine = require('../../models/Machine');
    const machine = await Machine.create({
      ID: `M-${seq++}`, manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'), NoOfHead: 6, NoOfHooks: 8, status: 'running',
    });
    const job = await makeJob(alpha._id);
    await JobOrder.updateOne({ _id: job._id }, { machine: machine._id });

    const res = await request(app).get(`/api/v2/job/detail?id=${job._id}`).set('Cookie', cookieFor(admin));
    expect(res.status).toBe(200);
    // Before: undefined, both — "NoOfHeads" and "phone" are not fields.
    expect(res.body.job.machine.NoOfHead).toBe(6);
    expect(res.body.job.customer.phoneNumber).toBe(alpha.phoneNumber);
    await Machine.deleteMany({});
  });
});
