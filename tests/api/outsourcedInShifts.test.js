'use strict';
// A job can be set to "outsource" — made by a vendor rather than on this
// floor. The Shifts screens all show a job number, so without carrying the
// production mode through, an outsourced job reads as ordinary in-house
// work to whoever is planning or verifying the shift.
//
// Each of the three Shifts read paths projects the job differently, and
// two of them SELECT specific fields — so a field that isn't named simply
// arrives undefined and the marker silently never appears. These tests pin
// the contract at each endpoint rather than trusting the populate.

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app, User, Employee, Machine, JobOrder, ShiftPlan, ShiftDetail, Customer, Order, admin;
// JobOrder requires customer/order/date refs; these tests only care about
// productionMode reaching the Shifts responses, so the refs are minimal.
let refs;
const cookie = (id, role) => [`token=${jwt.sign({ id, role }, process.env.JWT_SECRET_KEY)}`];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User.js');
  Employee = require('../../models/Employee.js');
  Machine = require('../../models/Machine.js');
  JobOrder = require('../../models/JobOrder.js');
  ShiftPlan = require('../../models/ShiftPlan.js');
  ShiftDetail = require('../../models/ShiftDetail.js');
  Customer = require('../../models/Customer.js');
  Order = require('../../models/Order.js');
  admin = await User.create({
    name: 'Owner', email: 'outsrc-owner@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  const cust = await Customer.create({ name: 'Acme', contactName: 'Ms Rao', phoneNumber: '9000000009' });
  const ord = await Order.create({ customer: cust._id, orderNo: 9001, po: 'PO-9001', date: new Date('2026-03-01'), supplyDate: new Date('2026-04-30') });
  refs = { customer: cust._id, order: ord._id, date: new Date('2026-03-01') };
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

// Builds a plan whose single machine runs an OUTSOURCED job.
async function seedOutsourced() {
  const emp = await Employee.create({ name: 'Ravi', department: 'production', hourlyRate: 50 });
  const job = await JobOrder.create({
    status: 'weaving', ...refs,
    productionMode: 'outsource', outsourceVendor: 'Sunrise Weaving',
  });
  const machine = await Machine.create({
    ID: 'M-77', manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'),
    NoOfHead: 8, NoOfHooks: 8, status: 'running', orderRunning: job._id,
  });
  const date = new Date('2026-04-01'); date.setHours(0, 0, 0, 0);
  // ShiftDetail requires its plan and the plan lists its details, so the
  // plan is created first and back-filled.
  const plan = await ShiftPlan.create({ date, shift: 'DAY', plan: [], totalProduction: 120 });
  const detail = await ShiftDetail.create({
    date, shift: 'DAY', shiftPlan: plan._id,
    machine: machine._id, employee: emp._id, job: job._id,
    timer: '08:00:00', productionMeters: 120, status: 'pending_verification',
    submittedProductionMeters: 120, submittedTimer: '08:00:00', submittedAt: new Date(),
  });
  plan.plan = [detail._id]; await plan.save();
  return { job, machine, plan, detail, emp };
}

describe('an outsourced job is flagged across the Shifts read paths', () => {
  let seeded;
  beforeAll(async () => { seeded = await seedOutsourced(); });

  test('shift plan detail rows carry the production mode and vendor', async () => {
    const res = await request(app)
      .get('/api/v2/shift/shiftPlanById')
      .query({ id: String(seeded.plan._id) })
      .set('Cookie', cookie(admin._id, 'admin'));

    expect(res.status).toBe(200);
    // jobOrderNo is auto-assigned by the model, so match on the value the
    // fixture actually got rather than the number we passed in.
    const row = res.body.data.machines.find(
      (m) => String(m.jobOrderNo) === String(seeded.job.jobOrderNo));
    expect(row).toBeTruthy();
    expect(row.productionMode).toBe('outsource');
    expect(row.outsourceVendor).toBe('Sunrise Weaving');
  });

  test('the production view projects it too (it SELECTs job fields explicitly)', async () => {
    const res = await request(app)
      .get(`/api/v2/production/shift-detail/${seeded.plan._id}`)
      .set('Cookie', cookie(admin._id, 'admin'));

    expect(res.status).toBe(200);
    const row = (res.body.data?.machines ?? []).find(
      (d) => String(d.shiftDetailId) === String(seeded.detail._id));
    expect(row).toBeTruthy();
    expect(row.job.productionMode).toBe('outsource');
    expect(row.job.outsourceVendor).toBe('Sunrise Weaving');
  });

  test('pending-verification carries it on the job the card reads', async () => {
    const res = await request(app)
      .get('/api/v2/shift/pending-verification')
      .set('Cookie', cookie(admin._id, 'admin'));

    expect(res.status).toBe(200);
    const s = res.body.shifts.find(
      (x) => String(x.job?.jobOrderNo) === String(seeded.job.jobOrderNo));
    expect(s).toBeTruthy();
    // The card falls back machine.orderRunning → job, so BOTH must carry it
    // or the marker disagrees with the "J-4242" printed beside it.
    expect(s.job.productionMode).toBe('outsource');
    expect(s.machine?.orderRunning?.productionMode).toBe('outsource');
  });
});

describe('an in-house job is not flagged', () => {
  test('production mode comes back in_house, so the UI renders nothing', async () => {
    const emp = await Employee.create({ name: 'Asha', department: 'production', hourlyRate: 50 });
    const job = await JobOrder.create({ status: 'weaving', ...refs }); // default mode
    const machine = await Machine.create({
      ID: 'M-78', manufacturer: 'Comez', DateOfPurchase: new Date('2020-01-01'),
      NoOfHead: 8, NoOfHooks: 8, status: 'running', orderRunning: job._id,
    });
    const date = new Date('2026-04-02'); date.setHours(0, 0, 0, 0);
    const plan = await ShiftPlan.create({ date, shift: 'DAY', plan: [], totalProduction: 90 });
    const detail = await ShiftDetail.create({
      date, shift: 'DAY', shiftPlan: plan._id,
      machine: machine._id, employee: emp._id, job: job._id,
      timer: '08:00:00', productionMeters: 90, status: 'closed',
    });
    plan.plan = [detail._id]; await plan.save();

    const res = await request(app)
      .get('/api/v2/shift/shiftPlanById')
      .query({ id: String(plan._id) })
      .set('Cookie', cookie(admin._id, 'admin'));

    expect(res.status).toBe(200);
    const row = res.body.data.machines.find(
      (m) => String(m.jobOrderNo) === String(job.jobOrderNo));
    expect(row.productionMode).toBe('in_house');
    expect(row.outsourceVendor).toBe('');
  });
});

// The job DETAIL page's "Shifts on this job" card swaps the shift table
// for a vendor panel when the job is outsourced, so the detail endpoint
// has to carry the mode — it is a different projection from the three
// Shifts endpoints above and was missing it.
describe('the job detail endpoint carries the production mode', () => {
  test('an outsourced job reports its mode and vendor', async () => {
    const job = await JobOrder.create({
      status: 'weaving', ...refs,
      productionMode: 'outsource', outsourceVendor: 'Sunrise Weaving',
    });
    const res = await request(app)
      .get(`/api/v2/job/${job._id}`)
      .set('Cookie', cookie(admin._id, 'admin'));

    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body.job ?? res.body;
    expect(body.productionMode).toBe('outsource');
    expect(body.outsourceVendor).toBe('Sunrise Weaving');
  });

  test('an in-house job reports in_house, so the card keeps its shifts', async () => {
    const job = await JobOrder.create({ status: 'weaving', ...refs });
    const res = await request(app)
      .get(`/api/v2/job/${job._id}`)
      .set('Cookie', cookie(admin._id, 'admin'));

    expect(res.status).toBe(200);
    const body = res.body.data ?? res.body.job ?? res.body;
    expect(body.productionMode).toBe('in_house');
  });
});
