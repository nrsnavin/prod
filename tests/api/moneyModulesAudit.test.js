'use strict';
// ══════════════════════════════════════════════════════════════════
//  THREE PLACES WHERE A CAREFUL CAP WAS ONLY HALF APPLIED
//
//  These are the money modules, and all three faults have the same
//  shape: a limit that the code thought about, wrote down, and then
//  applied to one of the two figures derived from the same input.
//
//    PAYROLL   base pay takes `Math.min(worked, shiftLength)`, so an
//              absurd worked duration costs nothing there — and the
//              OVERTIME taken from that same `worked` had no ceiling
//              at all. One clock-in never clocked out until somebody
//              noticed days later paid 58 hours of overtime at 1.25×.
//
//    PO        the over-receipt tolerance measures a delivery against
//              what was ordered — using `receivedQuantity` as loaded,
//              which is the same figure for every row in the submit.
//              Two rows for one material each measured themselves
//              against an untouched balance and neither looked over.
//
//    BONUS     the attendance rate was deliberately moved off
//              ShiftDetail because "a scheduled shift is not proof of
//              attendance". The earnings estimate beside it kept
//              counting scheduled shifts.
//
//  And one that is not a cap: payroll keyed every date off
//  `toISOString()` while attendance is written at LOCAL midnight, so
//  east of Greenwich every payslip line is labelled a day early. It is
//  invisible on a UTC box, which is why it lasted.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, computePayroll;
let Employee, Attendance, PayrollSettings, Supplier, RawMaterial,
    PurchaseOrder, BonusConfig, ShiftDetail, ShiftPlan, Machine, User, admin;

const cookie = () => [
  `token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  ({ computePayroll } = require('../../services/payrollService'));
  Employee        = require('../../models/Employee');
  Attendance      = require('../../models/Attendence');
  PayrollSettings = require('../../models/PayrollSettings');
  Supplier        = require('../../models/Supplier');
  RawMaterial     = require('../../models/RawMaterial');
  PurchaseOrder   = require('../../models/PurchaseOrder');
  BonusConfig     = require('../../models/BonusConfig');
  ShiftDetail     = require('../../models/ShiftDetail');
  ShiftPlan       = require('../../models/ShiftPlan');
  Machine         = require('../../models/Machine');
  User            = require('../../models/User');
  admin = await User.create({
    name: 'Owner', email: 'money@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

let seq = 0;
const makeEmployee = (rate = 100) =>
  Employee.create({
    name: `Ravi ${seq}`, phoneNumber: `90000000${String(seq++).padStart(2, '0')}`,
    department: 'production', hourlyRate: rate,
  });

// ══════════════════════════════════════════════════════════════════
describe('a shift someone forgot to clock out of', () => {
  /** Clocked in at 08:00 on the 6th, clocked out `days` later. */
  async function shiftLeftOpen(days) {
    await PayrollSettings.create({});
    const emp = await makeEmployee(100);
    const day = new Date(2026, 6, 6); day.setHours(0, 0, 0, 0);
    await Attendance.create({
      employee: emp._id, date: day, shift: 'DAY', status: 'present',
      clockInAt:  new Date(2026, 6, 6, 8, 0, 0),
      clockOutAt: new Date(2026, 6, 6 + days, 8, 0, 0),
    });
    return computePayroll(emp._id, 2026, 7);
  }

  it('pays the shift, not the gap', async () => {
    // A 12h day at ₹100/h is ₹1,200. Before the cap this came out at
    // ₹8,450 gross — 58 hours of overtime — and the payslip called it
    // an ordinary overtime line.
    const p = await shiftLeftOpen(3);

    expect(p.dayShiftEarnings).toBe(1200);           // base was always right
    expect(p.overtimeEarnings).toBeLessThanOrEqual(500);
    expect(p.grossEarnings).toBeLessThan(2000);
  });

  it('caps the overtime minutes at the configured maximum', async () => {
    const p = await shiftLeftOpen(3);
    expect(p.totalOvertimeMinutes).toBe(240);        // the 4h default
  });

  it('says on the payslip that it was capped, so the data gets fixed', async () => {
    // Silently dropping it would hide a missing clock-out that somebody
    // needs to correct.
    const p = await shiftLeftOpen(3);
    const ot = p.lineItems.find((l) => /Overtime/.test(l.label));
    expect(ot.label).toMatch(/capped from/i);
    expect(ot.label).toMatch(/clock-out/i);
  });

  it('does not touch a plausible overtime run', async () => {
    // The control: 3 hours past a 12h shift, well inside the cap and
    // past the 2h grace, must be paid in full.
    await PayrollSettings.create({});
    const emp = await makeEmployee(100);
    const day = new Date(2026, 6, 6); day.setHours(0, 0, 0, 0);
    await Attendance.create({
      employee: emp._id, date: day, shift: 'DAY', status: 'present',
      clockInAt:  new Date(2026, 6, 6, 8, 0, 0),
      clockOutAt: new Date(2026, 6, 6, 23, 0, 0),   // 15h worked
    });

    const p = await computePayroll(emp._id, 2026, 7);
    expect(p.totalOvertimeMinutes).toBe(60);         // 180 worked-over − 120 grace
    const ot = p.lineItems.find((l) => /Overtime/.test(l.label));
    expect(ot.label).not.toMatch(/capped/i);
  });

  it('can be switched off entirely', async () => {
    await PayrollSettings.create({ maxOvertimeMinutesPerShift: 0 });
    const emp = await makeEmployee(100);
    const day = new Date(2026, 6, 6); day.setHours(0, 0, 0, 0);
    await Attendance.create({
      employee: emp._id, date: day, shift: 'DAY', status: 'present',
      clockInAt:  new Date(2026, 6, 6, 8, 0, 0),
      clockOutAt: new Date(2026, 6, 9, 8, 0, 0),
    });

    const p = await computePayroll(emp._id, 2026, 7);
    expect(p.totalOvertimeMinutes).toBe(3480);
  });
});

describe('the date on a payslip line', () => {
  it('is the day the shift was actually worked', async () => {
    // Attendance is written at LOCAL midnight and every key here read it
    // through toISOString(), so east of Greenwich the label landed on
    // the previous day — and a shift on the 1st was labelled into the
    // previous MONTH.
    await PayrollSettings.create({});
    const emp = await makeEmployee(100);
    const first = new Date(2026, 6, 1); first.setHours(0, 0, 0, 0);
    await Attendance.create({
      employee: emp._id, date: first, shift: 'DAY', status: 'present',
    });

    const p = await computePayroll(emp._id, 2026, 7);
    const line = p.lineItems.find((l) => /DAY Shift/.test(l.label));
    expect(line.label).toContain('2026-07-01');
    expect(line.label).not.toContain('2026-06-30');
  });
});

describe('receiving a delivery against a purchase order', () => {
  async function poFor(ordered) {
    const sup = await Supplier.create({ name: `S${seq++}`, phoneNumber: '9000000099' });
    const rm  = await RawMaterial.create({
      name: `Yarn ${seq++}`, category: 'Yarn', stock: 0, price: 100, supplier: sup._id,
    });
    const po = await PurchaseOrder.create({
      supplier: sup._id, poNo: seq++, createdBy: admin._id,
      items: [{ rawMaterial: rm._id, quantity: ordered, price: 100, receivedQuantity: 0 }],
    });
    return { rm, po };
  }

  const inward = (poId, items, extra = {}) =>
    request(app).post('/api/v2/supplier/inward-stock')
      .set('Cookie', cookie()).send({ poId, items, ...extra });

  it('refuses the same material on two lines of one submit', async () => {
    // 60 + 60 against an order of 100. Each line measured itself against
    // an untouched receivedQuantity of 0, so neither looked over — and
    // 120 was credited, 20% over, with no reason asked for.
    const { rm, po } = await poFor(100);
    const res = await inward(po._id, [
      { rawMaterial: rm._id, quantity: 60 },
      { rawMaterial: rm._id, quantity: 60 },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than one line/i);
  });

  it('credits nothing when it refuses', async () => {
    const { rm, po } = await poFor(100);
    await inward(po._id, [
      { rawMaterial: rm._id, quantity: 60 },
      { rawMaterial: rm._id, quantity: 60 },
    ]);

    expect((await RawMaterial.findById(rm._id).lean()).stock).toBe(0);
    expect((await PurchaseOrder.findById(po._id).lean()).items[0].receivedQuantity).toBe(0);
  });

  it('still asks for a reason when ONE line goes past the tolerance', async () => {
    // The guard the split was evading. 120 on a single line against 100
    // is 20% over, past the 10% free allowance.
    const { rm, po } = await poFor(100);
    const res = await inward(po._id, [{ rawMaterial: rm._id, quantity: 120 }]);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/tolerance/i);
  });

  it('still receives an ordinary delivery', async () => {
    const { rm, po } = await poFor(100);
    const res = await inward(po._id, [{ rawMaterial: rm._id, quantity: 100 }]);

    expect(res.status).toBe(201);
    expect((await RawMaterial.findById(rm._id).lean()).stock).toBe(100);
  });

  it('still takes two DIFFERENT materials on one submit', async () => {
    const sup = await Supplier.create({ name: `S${seq++}`, phoneNumber: '9000000098' });
    const a = await RawMaterial.create({ name: `A${seq++}`, category: 'Yarn', stock: 0, price: 10, supplier: sup._id });
    const b = await RawMaterial.create({ name: `B${seq++}`, category: 'Yarn', stock: 0, price: 10, supplier: sup._id });
    const po = await PurchaseOrder.create({
      supplier: sup._id, poNo: seq++, createdBy: admin._id,
      items: [
        { rawMaterial: a._id, quantity: 50, price: 10, receivedQuantity: 0 },
        { rawMaterial: b._id, quantity: 50, price: 10, receivedQuantity: 0 },
      ],
    });

    const res = await inward(po._id, [
      { rawMaterial: a._id, quantity: 50 },
      { rawMaterial: b._id, quantity: 50 },
    ]);
    expect(res.status).toBe(201);
  });
});

describe('the bonus base when no payroll exists for the window', () => {
  it('counts shifts the employee attended, not shifts they were rostered for', async () => {
    // The attendance RATE was deliberately moved off ShiftDetail —
    // "someone marked absent every single day still scored 100%". The
    // earnings estimate beside it kept counting scheduled shifts, so
    // that same employee still got a full earnings base.
    const emp = await makeEmployee(100);
    const year = 2026;
    await BonusConfig.create({
      year, bonusDate: new Date(year, 9, 20), yearlyWorkingDays: 300,
    });

    const machine = await Machine.create({
      ID: `LOOM-${seq++}`, manufacturer: 'Comez', DateOfPurchase: new Date(),
      NoOfHead: 4, NoOfHooks: 12,
    });

    // Rostered for 10 shifts in the window, present for 2.
    for (let i = 0; i < 10; i++) {
      const d = new Date(year, 5, 1 + i); d.setHours(0, 0, 0, 0);
      const plan = await ShiftPlan.create({ date: d, shift: 'DAY' });
      await ShiftDetail.create({
        employee: emp._id, date: d, shift: 'DAY', status: 'closed',
        machine: machine._id, shiftPlan: plan._id,
      });
      await Attendance.create({
        employee: emp._id, date: d, shift: 'DAY',
        status: i < 2 ? 'present' : 'absent',
      });
    }

    const res = await request(app)
      .get(`/api/v2/bonus/preview?year=${year}`).set('Cookie', cookie());
    expect(res.status).toBe(200);

    const row = (res.body.rows || []).find(
      (r) => String(r.employeeId) === String(emp._id)
    );
    expect(row).toBeDefined();
    // 2 attended shifts × 12h × ₹100 = 2400, not 10 × 12 × 100 = 12000.
    expect(row.annualEarnings).toBe(2400);
  });
});
