'use strict';
// ══════════════════════════════════════════════════════════════════
//  TAKING THE EXPLAINING LINES OUT OF LEDGERS ALREADY POSTED
//
//  Finalising a payslip used to post every line, including "Absent —
//  pay lost" and "Late deduction", which take nothing off, and an
//  advance being recovered, which the ledger already carries from the
//  day it was paid out. The code no longer posts them
//  (tests/api/ledger.test.js); this moves out the ones posted before,
//  and nothing else.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');

const migration = require('../../migrations/20261110000001-ledger-drop-memo-lines');

let mongo, client, db;

beforeAll(async () => {
  mongo  = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db     = client.db('test');
}, 120_000);

afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => {
  for (const c of ['ledgerentries', 'ledgerentries_memo_removed', 'payrolls', 'advancerequests']) await db.collection(c).deleteMany({});
});

const balance = async (employee) =>
  (await db.collection('ledgerentries').find({ employee }).toArray()).reduce((s, r) => s + r.amount, 0);

async function seed() {
  const emp = new ObjectId(), other = new ObjectId(), slip = new ObjectId();
  const row = (employee, kind, amount, label, source = 'payroll') =>
    ({ employee, kind, amount, label, source, sourceId: source === 'payroll' ? slip : new ObjectId(), date: new Date('2026-06-03') });
  await db.collection('ledgerentries').insertMany([
    row(emp, 'shift_salary', 1200, 'DAY Shift (2026-06-02)'),
    row(emp, 'absence', -1200, 'Absent — pay lost (DAY 2026-06-03)'),
    row(emp, 'absence', -1200, 'Absent — no attendance for scheduled NIGHT (2026-06-05)'),
    row(emp, 'penalty', -50, 'Late deduction 30m (DAY 2026-06-04)'),
    row(emp, 'shift_salary', 1150, 'DAY Shift (2026-06-04)'),
    // Real deductions and everything else stay where they are.
    row(emp, 'penalty', -200, 'Excess absent penalty (1 × ₹200)'),
    row(emp, 'penalty', -75, 'Wastage penalty (1 entry)'),
    row(emp, 'statutory', -120, 'PF (12%)'),
    row(emp, 'payment', -1955, 'Salary paid'), // 2350 earned, less 395 of real deductions
    // Somebody's own correction that happens to read alike is not a payslip line.
    row(emp, 'adjustment', -10, 'Late deduction corrected by hand', 'manual'),
    row(other, 'shift_salary', 1200, 'DAY Shift (2026-06-02)'),
  ]);
  return { emp, other };
}

test('the explaining rows leave the ledger; the balance comes back to what was owed and paid', async () => {
  const { emp, other } = await seed();
  expect(await balance(emp)).toBe(-2460); // "owes" two shifts and a late cut

  await migration.up(db);
  expect(await balance(emp)).toBe(-10);   // paid in full; only the hand correction is left
  expect(await balance(other)).toBe(1200);
  const left = await db.collection('ledgerentries').find({ employee: emp }).toArray();
  expect(left.map((r) => r.label).sort()).toEqual([
    'DAY Shift (2026-06-02)', 'DAY Shift (2026-06-04)', 'Excess absent penalty (1 × ₹200)',
    'Late deduction corrected by hand', 'PF (12%)', 'Salary paid', 'Wastage penalty (1 entry)',
  ]);
  expect(await db.collection('ledgerentries_memo_removed').countDocuments({})).toBe(3);
});

test('run twice it does nothing more; run down it puts every row back as it was', async () => {
  const { emp } = await seed();
  const before = await db.collection('ledgerentries').find({}).sort({ _id: 1 }).toArray();

  await migration.up(db);
  await migration.up(db);
  expect(await db.collection('ledgerentries_memo_removed').countDocuments({})).toBe(3);
  expect(await balance(emp)).toBe(-10);

  await migration.down(db);
  expect(await db.collection('ledgerentries').find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  expect(await db.collection('ledgerentries_memo_removed').countDocuments({})).toBe(0);
});

test('a ledger with nothing of the kind is left alone', async () => {
  await db.collection('ledgerentries').insertOne({ employee: new ObjectId(), kind: 'shift_salary', amount: 1200, label: 'DAY Shift (2026-06-02)', source: 'payroll' });
  await migration.up(db);
  expect(await db.collection('ledgerentries').countDocuments({})).toBe(1);
  expect(await db.collection('ledgerentries_memo_removed').countDocuments({})).toBe(0);
});

test('an advance recovered is counted once: both ways it used to be posted are taken out', async () => {
  const viaSlip = new ObjectId(), atPayment = new ObjectId();
  const row = (employee, kind, amount, label, source = 'payroll') =>
    ({ employee, kind, amount, label, source, sourceId: new ObjectId(), date: new Date('2026-06-30') });
  await db.collection('ledgerentries').insertMany([
    // Recovered through the payslip: 2,000 earned, 600 held back, 1,400 paid.
    row(viaSlip, 'advance_issued', -600, 'Advance paid — medical', 'advance'),
    row(viaSlip, 'shift_salary', 2000, 'DAY Shift (2026-06-02)'),
    row(viaSlip, 'advance_recovered', -600, 'Advance Salary Recovery ₹600'),
    row(viaSlip, 'payment', -1400, 'Salary paid'),
    // Recovered at payment: the same month, the other route.
    row(atPayment, 'advance_issued', -600, 'Advance paid — medical', 'advance'),
    row(atPayment, 'shift_salary', 2000, 'DAY Shift (2026-06-02)'),
    row(atPayment, 'payment', -1400, 'Salary paid'),
    row(atPayment, 'advance_recovered', 600, 'Advance recovered from June 2026 pay', 'advance'),
  ]);
  expect(await balance(viaSlip)).toBe(-600);   // "owes" the advance twice
  expect(await balance(atPayment)).toBe(600);  // "is owed" the advance back

  await migration.up(db);
  expect(await balance(viaSlip)).toBe(0);
  expect(await balance(atPayment)).toBe(0);
  // The advance itself stays: it is the cash that was handed over.
  expect(await db.collection('ledgerentries').countDocuments({ kind: 'advance_issued' })).toBe(2);

  await migration.down(db);
  expect(await balance(viaSlip)).toBe(-600);
  expect(await balance(atPayment)).toBe(600);
});

test('an advance recovered from pay that was never on the ledger as given is put there', async () => {
  // Approved in the admin app, which has no pay-out step: recovered from
  // pay, never booked. Taking the recovery row out alone would leave the
  // ledger saying the worker had been short-paid.
  const viaSlip = new ObjectId(), atPayment = new ObjectId(), booked = new ObjectId();
  const mk = async (employee, { recoveryRow, issued }) => {
    const advance = new ObjectId(), slip = new ObjectId();
    await db.collection('advancerequests').insertOne({
      _id: advance, employee, amount: 600, reason: 'medical', status: 'recovered', remainingBalance: 0,
      approvedAt: new Date('2026-06-01'), createdAt: new Date('2026-05-28'),
    });
    await db.collection('payrolls').insertOne({ _id: slip, employee, year: 2026, month: 6, advanceRecoveries: [{ advance, amount: 600 }] });
    const row = (kind, amount, label, source, sourceId) => ({ employee, kind, amount, label, source, sourceId, date: new Date('2026-06-30') });
    await db.collection('ledgerentries').insertMany([
      row('shift_salary', 2000, 'DAY Shift (2026-06-02)', 'payroll', slip),
      row('payment', -1400, 'Salary paid', 'payroll', slip),
      ...(issued ? [row('advance_issued', -600, 'Advance paid — medical', 'advance', advance)] : []),
      recoveryRow === 'slip'
        ? row('advance_recovered', -600, 'Advance Salary Recovery ₹600', 'payroll', slip)
        : row('advance_recovered', 600, 'Advance recovered from June 2026 pay', 'advance', advance),
    ]);
    return advance;
  };
  const a1 = await mk(viaSlip, { recoveryRow: 'slip', issued: false });
  await mk(atPayment, { recoveryRow: 'payment', issued: false });
  await mk(booked, { recoveryRow: 'slip', issued: true });
  // An advance approved and not recovered yet: nothing has moved, nothing is added.
  await db.collection('advancerequests').insertOne({ _id: new ObjectId(), employee: viaSlip, amount: 250, status: 'approved' });

  await migration.up(db);
  for (const emp of [viaSlip, atPayment, booked]) expect(await balance(emp)).toBe(0);
  const added = await db.collection('ledgerentries').find({ 'meta.addedBy': { $exists: true } }).toArray();
  expect(added).toHaveLength(2);
  expect(added.find((r) => String(r.sourceId) === String(a1))).toMatchObject({
    kind: 'advance_issued', amount: -600, label: 'Advance paid — medical', source: 'advance', date: new Date('2026-06-01'),
  });
  expect(await db.collection('ledgerentries').countDocuments({ kind: 'advance_issued' })).toBe(3);

  // Twice is once.
  await migration.up(db);
  expect(await db.collection('ledgerentries').countDocuments({ kind: 'advance_issued' })).toBe(3);

  // Down: as it was.
  await migration.down(db);
  expect(await balance(viaSlip)).toBe(0);      // 2000 − 1400 − 600: right by accident, as before
  expect(await balance(atPayment)).toBe(1200); // 2000 − 1400 + 600
  expect(await balance(booked)).toBe(-600);
  expect(await db.collection('ledgerentries').countDocuments({ 'meta.addedBy': { $exists: true } })).toBe(0);
});
