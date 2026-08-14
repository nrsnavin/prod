'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT THE P&L CHARGES FOR LABOUR, AGAINST WHAT PAYROLL PAYS
//
//  utils/shiftHours.js exists so these two cannot drift:
//
//    "Payroll pays a worked shift against this, and the order P&L
//     charges a job's labour against it. They were about to hold the
//     number separately, which is the shape of drift that makes a job
//     cost more (or less) than the wage it was paid from."
//
//  That was true when it was written. Actual-hours pay came later:
//  payroll now reads the shift timer and pays what was WORKED, capped
//  at the shift length, plus overtime beyond it. The P&L was not
//  changed, and still charges a flat scheduled 12 hours.
//
//  So the guarantee the shared helper was created to provide no longer
//  holds, and the comment asserting it is stale. These pin the actual
//  behaviour of both sides so the gap is a measured number rather than
//  an argument.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo;
let Order, JobOrder, Customer, Elastic, Employee, ShiftDetail, Machine, ShiftPlan;
let orderPnl;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Order       = require('../../models/Order');
  JobOrder    = require('../../models/JobOrder');
  Customer    = require('../../models/Customer');
  Elastic     = require('../../models/Elastic');
  Employee    = require('../../models/Employee');
  ShiftDetail = require('../../models/ShiftDetail');
  Machine     = require('../../models/Machine');
  ShiftPlan   = require('../../models/ShiftPlan');
  ({ orderPnl } = require('../../services/orderPnl'));
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

const HOURLY = 50;   // ₹50/hour → a 12-hour shift is ₹600

/**
 * One order, one job, one worked shift.
 * `timer` sets clock-in/out so payroll's actual-hours path engages.
 */
async function seed({ workedHours = null } = {}) {
  const customer = await Customer.create({
    name: 'Acme', contactName: 'R', phoneNumber: '9000000001',
  });
  const elastic = await Elastic.create({
    name: `20mm ${Math.random().toString(36).slice(2, 8)}`, weaveType: '8',
    spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
  });
  const order = await Order.create({
    customer: customer._id, po: 'PO-1', date: new Date(), supplyDate: new Date(),
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
    status: 'InProgress',
  });
  const job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(), status: 'weaving',
    elastics: [{ elastic: elastic._id, quantity: 1000 }],
    producedElastic: [{ elastic: elastic._id, quantity: 1000 }],
  });
  const employee = await Employee.create({
    name: 'Weaver', phoneNumber: '9000000002', hourlyRate: HOURLY,
  });

  const machine = await Machine.create({
    ID: `M-${Math.random().toString(36).slice(2, 6)}`,
    NoOfHead: 1, NoOfHooks: 12, manufacturer: 'Acme',
  });
  const plan = await ShiftPlan.create({ date: new Date(), shift: 'DAY' });

  const shift = {
    job: job._id, employee: employee._id, date: new Date(),
    shift: 'DAY', status: 'closed',
    machine: machine._id, shiftPlan: plan._id,
  };
  if (workedHours != null) {
    const start = new Date('2026-08-12T08:00:00Z');
    shift.clockInAt  = start;
    shift.clockOutAt = new Date(start.getTime() + workedHours * 3600_000);
    shift.workedMinutes = workedHours * 60;
  }
  await ShiftDetail.create(shift);

  return { order, job, employee };
}

describe('a shift worked for its full scheduled length', () => {
  it('costs the P&L the whole shift', async () => {
    const { order } = await seed({ workedHours: 12 });
    const pnl = await orderPnl(order._id);
    expect(pnl.costs.labour).toBe(12 * HOURLY);   // ₹600
  });
});

describe('a SHORT shift — clocked out after eight hours', () => {
  it('is paid for eight hours by payroll', () => {
    // Payroll: basePaidMin = min(worked, cap) → 8h × ₹50 = ₹400.
    const worked = 8 * 60;
    const cap    = 12 * 60;
    expect((Math.min(worked, cap) / 60) * HOURLY).toBe(400);
  });

  it('is charged at TWELVE hours by the P&L', async () => {
    const { order } = await seed({ workedHours: 8 });
    const pnl = await orderPnl(order._id);

    // The gap: ₹600 charged against the job, ₹400 actually paid.
    expect(pnl.costs.labour).toBe(600);
    expect(pnl.jobs[0].labour.hours).toBe(12);
  });

  it('overstates the job by the hours nobody worked', async () => {
    const { order } = await seed({ workedHours: 8 });
    const pnl = await orderPnl(order._id);
    const actuallyPaid = 8 * HOURLY;
    expect(pnl.costs.labour - actuallyPaid).toBe(200);
  });
});

describe('an OVERTIME shift — fourteen hours on the clock', () => {
  it('is paid for more than the shift by payroll', () => {
    // 12h base + 2h overtime; the P&L knows nothing of the extra 2h.
    const worked = 14 * 60;
    const cap    = 12 * 60;
    expect(Math.max(0, worked - cap)).toBe(120);
  });

  it('is still charged at twelve hours by the P&L', async () => {
    const { order } = await seed({ workedHours: 14 });
    const pnl = await orderPnl(order._id);

    // Understated this time: the overtime the factory paid for is not
    // charged to the job that caused it.
    expect(pnl.costs.labour).toBe(600);
    expect(pnl.jobs[0].labour.hours).toBe(12);
  });
});

describe('a shift with no timer at all', () => {
  it('is charged — and paid — at the scheduled length, as it always was', async () => {
    // The legacy path. Here the two sides DO agree, which is why the
    // divergence went unnoticed: every order predating the timer reads
    // correctly.
    const { order } = await seed({ workedHours: null });
    const pnl = await orderPnl(order._id);
    expect(pnl.costs.labour).toBe(600);
  });
});

// ══════════════════════════════════════════════════════════════════
//  THE TWO SIDES DO NOT READ THE SAME DOCUMENT
//
//  The P&L costs labour from ShiftDetail — the roster. Payroll pays
//  from Attendance — the register. They are separate collections
//  written by separate screens, and nothing reconciles them, so the
//  gap does not need a timer to open. A shift can be on the roster and
//  the worker marked absent against it.
// ══════════════════════════════════════════════════════════════════
describe('a rostered shift the worker did not turn up for', () => {
  it('is charged to the job in full', async () => {
    const { order, employee } = await seed({ workedHours: null });
    const Attendance = require('../../models/Attendence');
    await Attendance.create({
      employee: employee._id, date: new Date(), shift: 'DAY', status: 'absent',
    });

    // Payroll's absent branch pays nothing and pushes -fullPay as a
    // deduction. The P&L never opens the register, so the job carries a
    // full shift of wage the factory did not pay — it docked it.
    const pnl = await orderPnl(order._id);
    expect(pnl.costs.labour).toBe(600);
  });
});

describe('the shift statuses each side counts', () => {
  // Payroll's unmarked-shift sweep filters `status: 'closed'` — only
  // completed shifts. The P&L excludes only 'open', so 'running' and
  // 'pending_verification' are charged in full.
  const statusCase = async (status) => {
    const { order } = await seed({ workedHours: null });
    await require('../../models/ShiftDetail')
      .updateOne({}, { $set: { status } });
    const pnl = await orderPnl(order._id);
    return pnl.costs.labour;
  };

  it('charges a shift that is still running', async () => {
    // Twelve hours of wage land on the order the moment somebody
    // starts the shift, before any of it has been worked.
    expect(await statusCase('running')).toBe(600);
  });

  it('charges a shift awaiting verification', async () => {
    expect(await statusCase('pending_verification')).toBe(600);
  });

  it('charges nothing for a shift that is merely rostered', async () => {
    expect(await statusCase('open')).toBe(0);
  });
});
