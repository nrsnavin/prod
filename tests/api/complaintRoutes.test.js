'use strict';
// ══════════════════════════════════════════════════════════════════
//  ROUTES FOR A MODEL THAT HAD NONE
//
//  models/Complaints.js existed for a long time with no mount in
//  app.js. Nothing could file a complaint, read one or resolve one; the
//  collection could only ever have been empty. These are the tests for
//  the doors that were missing.
//
//  Three of them are about specific traps rather than happy paths:
//
//    • /themes must be matched BEFORE /:id. Express matches in order,
//      so a route added later is swallowed by the parameterised one and
//      answers "Invalid complaint id" — a bug that looks like a
//      validation problem and is a routing problem.
//
//    • A complaint filed against a job belonging to a DIFFERENT
//      customer puts the wrong name at the head of the trace and sends
//      somebody to ring a customer about goods they never received.
//
//    • A PUT carrying only a status must not blank the resolution
//      somebody typed yesterday.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app;
let Complaint, JobOrder, Order, Customer, Elastic, User;
let admin, outsider;

const cookieFor = (u) => [
  `token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app       = require('../../app.js');
  Complaint = require('../../models/Complaints');
  JobOrder  = require('../../models/JobOrder');
  Order     = require('../../models/Order');
  Customer  = require('../../models/Customer');
  Elastic   = require('../../models/Elastic');
  User      = require('../../models/User');

  admin = await User.create({
    name: 'Admin', email: 'comp-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  // A role outside the mount's gate. gate(...) checks req.user.role,
  // not department, so this is what an account with no business seeing
  // other customers' exposure actually looks like.
  outsider = await User.create({
    name: 'Store', email: 'comp-store@t.co', password: 'pass1234',
    role: 'store', department: 'packing',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
afterEach(async () => {
  await Promise.all([
    Complaint.deleteMany({}), JobOrder.deleteMany({}),
    Order.deleteMany({}), Customer.deleteMany({}), Elastic.deleteMany({}),
  ]);
});

const makeCustomer = (name) => Customer.create({
  name, contactName: name, phoneNumber: `9${String(seq++).padStart(9, '0')}`,
});

const makeElastic = () => Elastic.create({
  name: `E-${seq++}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120,
  pick: 12, noOfHook: 8, weight: 2.4,
});

async function makeJob(customer, elastic) {
  const order = await Order.create({
    customer, date: new Date(), po: `PO-${seq++}`, supplyDate: new Date(),
    elastics: [{ elastic, quantity: 1000 }],
  });
  return JobOrder.create({
    order: order._id, customer, date: new Date(), status: 'weaving',
    elastics: [{ elastic, quantity: 1000 }],
  });
}

// ══════════════════════════════════════════════════════════════════
describe('POST /api/v2/complaint', () => {
  test('files a complaint against the customer\'s own job', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);

    const res = await request(app)
      .post('/api/v2/complaint')
      .set('Cookie', cookieFor(admin))
      .send({ customer: c._id, job: job._id, elastic: el._id,
              category: 'shade', reason: 'Shade band across the roll' });

    expect(res.status).toBe(201);
    expect(res.body.data.category).toBe('shade');
    expect(res.body.data.status).toBe('Open');
  });

  test('refuses a job belonging to a different customer', async () => {
    // Otherwise the trace runs from the wrong head and produces a list
    // of exposed customers that has nothing to do with the complaint.
    const mine = await makeCustomer('Anand');
    const theirs = await makeCustomer('Bharat');
    const el = await makeElastic();
    const job = await makeJob(theirs._id, el._id);

    const res = await request(app)
      .post('/api/v2/complaint')
      .set('Cookie', cookieFor(admin))
      .send({ customer: mine._id, job: job._id, reason: 'Wrong shade' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/different customer/i);
    expect(await Complaint.countDocuments({})).toBe(0);
  });

  test('refuses a job that does not exist', async () => {
    const c = await makeCustomer('Anand');
    const res = await request(app)
      .post('/api/v2/complaint')
      .set('Cookie', cookieFor(admin))
      .send({ customer: c._id, job: new mongoose.Types.ObjectId(), reason: 'x' });

    expect(res.status).toBe(404);
  });

  test('refuses an unknown category rather than silently filing it as other', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);

    const res = await request(app)
      .post('/api/v2/complaint')
      .set('Cookie', cookieFor(admin))
      .send({ customer: c._id, job: job._id, category: 'colour', reason: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/category must be one of/i);
  });

  test('requires a reason', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);

    const res = await request(app)
      .post('/api/v2/complaint')
      .set('Cookie', cookieFor(admin))
      .send({ customer: c._id, job: job._id, reason: '   ' });

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /api/v2/complaint/themes', () => {
  test('is not swallowed by /:id', async () => {
    // The trap this test exists for: with the routes in the other
    // order, "themes" is read as an id and the endpoint answers 400
    // "Invalid complaint id" for ever.
    const res = await request(app)
      .get('/api/v2/complaint/themes')
      .set('Cookie', cookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('byCategory');
    expect(res.body.data.total).toBe(0);
  });

  test('a genuinely invalid id still gets the validation error', async () => {
    const res = await request(app)
      .get('/api/v2/complaint/not-an-id')
      .set('Cookie', cookieFor(admin));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid complaint id/i);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /api/v2/complaint/:id/trace', () => {
  test('returns a trace for a real complaint', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);
    const comp = await Complaint.create({
      customer: c._id, job: job._id, category: 'shade', reason: 'Shade band',
    });

    const res = await request(app)
      .get(`/api/v2/complaint/${comp._id}/trace`)
      .set('Cookie', cookieFor(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.summary.otherJobs).toBe(0);
    // No lot recorded is not the same as nobody else being affected,
    // and the payload has to carry that distinction to the screen.
    expect(res.body.data.caveats.join(' ')).toMatch(/not evidence/i);
  });

  test('404s for an unknown complaint', async () => {
    const res = await request(app)
      .get(`/api/v2/complaint/${new mongoose.Types.ObjectId()}/trace`)
      .set('Cookie', cookieFor(admin));
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('PUT /api/v2/complaint/:id', () => {
  test('a status-only update leaves the resolution alone', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);
    const comp = await Complaint.create({
      customer: c._id, job: job._id, category: 'shade',
      reason: 'Shade band', resolution: 'Lot D-4471 quarantined',
    });

    const res = await request(app)
      .put(`/api/v2/complaint/${comp._id}`)
      .set('Cookie', cookieFor(admin))
      .send({ status: 'InReview' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('InReview');
    expect(res.body.data.resolution).toBe('Lot D-4471 quarantined');
  });

  test('an explicitly empty resolution does clear it', async () => {
    // The other half of the same rule: absent means "leave it", empty
    // string means "the user cleared the box".
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);
    const comp = await Complaint.create({
      customer: c._id, job: job._id, reason: 'x', resolution: 'was here',
    });

    const res = await request(app)
      .put(`/api/v2/complaint/${comp._id}`)
      .set('Cookie', cookieFor(admin))
      .send({ resolution: '' });

    expect(res.status).toBe(200);
    expect(res.body.data.resolution).toBe('');
  });

  test('refuses an unknown status', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);
    const comp = await Complaint.create({ customer: c._id, job: job._id, reason: 'x' });

    const res = await request(app)
      .put(`/api/v2/complaint/${comp._id}`)
      .set('Cookie', cookieFor(admin))
      .send({ status: 'Escalated' });

    expect(res.status).toBe(400);
  });

  test('an empty body is rejected rather than counted as a no-op success', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);
    const comp = await Complaint.create({ customer: c._id, job: job._id, reason: 'x' });

    const res = await request(app)
      .put(`/api/v2/complaint/${comp._id}`)
      .set('Cookie', cookieFor(admin))
      .send({});

    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('gating', () => {
  test('an unauthenticated request is refused', async () => {
    const res = await request(app).get('/api/v2/complaint');
    expect([401, 403]).toContain(res.status);
  });

  test('a role outside the gate is refused', async () => {
    // The report names other customers and the jobs still on the floor
    // carrying the same lot. It is not general-access data.
    const res = await request(app)
      .get('/api/v2/complaint')
      .set('Cookie', cookieFor(outsider));
    expect([401, 403]).toContain(res.status);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('GET /api/v2/complaint', () => {
  test('filters by status and paginates', async () => {
    const c = await makeCustomer('Anand');
    const el = await makeElastic();
    const job = await makeJob(c._id, el._id);
    await Complaint.insertMany([
      { customer: c._id, job: job._id, reason: 'a', status: 'Open' },
      { customer: c._id, job: job._id, reason: 'b', status: 'Open' },
      { customer: c._id, job: job._id, reason: 'c', status: 'Closed' },
    ]);

    const open = await request(app)
      .get('/api/v2/complaint?status=Open')
      .set('Cookie', cookieFor(admin));
    expect(open.body.total).toBe(2);

    const paged = await request(app)
      .get('/api/v2/complaint?limit=1&page=2')
      .set('Cookie', cookieFor(admin));
    expect(paged.body.count).toBe(1);
    expect(paged.body.total).toBe(3);
  });
});
