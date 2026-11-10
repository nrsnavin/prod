'use strict';
// ══════════════════════════════════════════════════════════════════
//  TAKING THE EXPLAINING LINES OUT OF LEDGERS ALREADY POSTED
//
//  Finalising a payslip used to post every line, including "Absent —
//  pay lost" and "Late deduction", which take nothing off. The code no
//  longer posts them (tests/api/ledger.test.js); this moves out the ones
//  posted before, and nothing else.
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
  for (const c of ['ledgerentries', 'ledgerentries_memo_removed']) await db.collection(c).deleteMany({});
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
