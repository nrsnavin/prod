'use strict';
// ══════════════════════════════════════════════════════════════════
//  WRITING OFF, IN LEDGERS ALREADY POSTED, WHAT PAYROLL WROTE OFF
//
//  A month whose deductions came to more than its pay paid ₹0, but the
//  employee ledger posted every deduction, so it showed the worker owing
//  the excess for good. The owner decided the excess is written off: the
//  code now posts a write-off row (tests/api/ledger.test.js), and this
//  migration adds it for the slips posted before. Nothing else moves.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');

const migration = require('../../migrations/20261111000001-ledger-write-off-below-zero');

let mongo, client, db;

beforeAll(async () => {
  mongo  = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db     = client.db('test');
}, 120_000);

afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => {
  for (const c of ['ledgerentries', 'payrolls']) await db.collection(c).deleteMany({});
});

const balance = async (employee) =>
  (await db.collection('ledgerentries').find({ employee }).toArray()).reduce((s, r) => s + r.amount, 0);

async function slip(employee, { gross, deductions, status = 'finalized', posted = true, rows = null }) {
  const _id = new ObjectId();
  await db.collection('payrolls').insertOne({
    _id, employee, year: 2026, month: 6, status,
    grossEarnings: gross, totalBonuses: 0, totalDeductions: deductions, netPay: Math.max(0, gross - deductions),
  });
  if (posted) {
    const r = (kind, amount, label) => ({ employee, kind, amount, label, source: 'payroll', sourceId: _id, date: new Date('2026-06-30') });
    await db.collection('ledgerentries').insertMany(rows ? rows(r) : [
      r('shift_salary', gross, 'DAY Shift (2026-06-02)'),
      r('penalty', -deductions, 'Excess absent penalty (1 × ₹2000)'),
    ]);
  }
  return _id;
}

test('a posted slip that stopped at ₹0 is written off; the balance comes back to nothing owed', async () => {
  const emp = new ObjectId(), fine = new ObjectId();
  const id = await slip(emp, { gross: 1200, deductions: 2000 });
  // A month that covered its deductions, settled in full: untouched.
  await slip(fine, {
    gross: 1200, deductions: 200,
    rows: (r) => [r('shift_salary', 1200, 'DAY Shift (2026-06-02)'), r('penalty', -200, 'Excess absent penalty'), r('payment', -1000, 'Salary paid')],
  });
  expect(await balance(emp)).toBe(-800);

  await migration.up(db);

  const added = await db.collection('ledgerentries').find({ kind: 'write_off' }).toArray();
  expect(added).toEqual([expect.objectContaining({ employee: emp, sourceId: id, amount: 800, source: 'payroll', year: 2026, month: 6 })]);
  expect(await balance(emp)).toBe(0);
  expect(await balance(fine)).toBe(0);
});

test('a draft, a slip never posted, and one already written off are left alone; running twice adds nothing', async () => {
  const a = new ObjectId(), b = new ObjectId(), c = new ObjectId(), d = new ObjectId();
  await slip(a, { gross: 1200, deductions: 2000, status: 'draft' });
  await slip(b, { gross: 1200, deductions: 2000, posted: false });
  await slip(c, {
    gross: 1200, deductions: 2000,
    rows: (r) => [r('shift_salary', 1200, 'DAY Shift'), r('penalty', -2000, 'Excess absent penalty'), r('write_off', 800, "Deductions beyond this month's pay, written off")],
  });
  await slip(d, { gross: 1200, deductions: 2000 });

  await migration.up(db);
  await migration.up(db);

  const offs = await db.collection('ledgerentries').find({ kind: 'write_off' }).toArray();
  expect(offs.map((o) => String(o.employee)).sort()).toEqual([String(c), String(d)].sort());
  expect(await balance(a)).toBe(-800);   // a draft is not in the books yet
});

test('down takes away only what up added', async () => {
  const emp = new ObjectId(), kept = new ObjectId();
  await slip(emp, { gross: 1200, deductions: 2000 });
  await slip(kept, {
    gross: 1200, deductions: 2000,
    rows: (r) => [r('shift_salary', 1200, 'DAY Shift'), r('penalty', -2000, 'Excess absent penalty'), r('write_off', 800, "Deductions beyond this month's pay, written off")],
  });
  await migration.up(db);
  await migration.down(db);
  expect(await balance(emp)).toBe(-800);
  expect(await balance(kept)).toBe(0);
});
