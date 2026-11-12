'use strict';
// The read-only check of the live books (scripts/accounts-audit-check.js):
// it finds each kind of thing the accounts faults could have left behind,
// finds nothing in clean books, and writes nothing.

const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { checks } = require('../../scripts/accounts-audit-check');

let mongo, client, db;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongo.getUri());
  db = client.db('books');
}, 120_000);
afterAll(async () => { await client.close(); await mongo.stop(); });
beforeEach(async () => { for (const c of await db.collections()) await c.deleteMany({}); });

const d = (s) => new Date(`${s}T00:00:00Z`);
const byKey = (results) => Object.fromEntries(results.map((r) => [r.key, r]));

it('finds nothing in books with nothing wrong', async () => {
  const customer = new ObjectId();
  await db.collection('customers').insertOne({ _id: customer, name: 'Sunrise', paymentTerms: '30' });
  await db.collection('invoices').insertOne({ invoiceNumber: 'INV/2026-27/0001', financialYear: '2026-27', sequence: 1, invoiceDate: d('2026-06-01'), dueDate: d('2026-07-01'), customer, status: 'issued', totals: { grand: 10500 } });
  const results = await checks(db);
  expect(results.map((r) => r.count)).toEqual(results.map(() => 0));
  expect(results.map((r) => r.finding)).toEqual(['B-1', 'C-2', 'C-1', 'B-2, B-4', 'C-4', 'B-5', 'B-6', 'B-7', 'I-1', 'I-4', 'C-8', 'Q-8']);
});

it('lists each thing the faults could have left, and changes nothing', async () => {
  const customer = new ObjectId(); const supplier = new ObjectId(); const account = new ObjectId();
  const inv1 = new ObjectId(); const paid = new ObjectId(); const cancelledBill = new ObjectId(); const contra = new ObjectId(); const voucher = new ObjectId();
  await db.collection('customers').insertOne({ _id: customer, name: 'Sunrise', paymentTerms: '45' });
  await db.collection('invoices').insertMany([
    // B-1: due on its own date, the customer has 45 days. C-8: number 2 of the year was never issued.
    { _id: inv1, invoiceNumber: 'INV/2026-27/0001', financialYear: '2026-27', sequence: 1, invoiceDate: d('2026-06-01'), dueDate: d('2026-06-01'), customer, buyer: { name: 'Sunrise' }, status: 'issued', totals: { grand: 10500 }, einvoice: { irn: 'a'.repeat(64) } },
    { invoiceNumber: 'INV/2026-27/0003', financialYear: '2026-27', sequence: 3, invoiceDate: d('2026-06-05'), dueDate: d('2026-07-20'), customer, status: 'issued', totals: { grand: 500 }, einvoice: { irn: 'a'.repeat(64) } },   // Q-8: the same IRN
  ]);
  await db.collection('burntnumbers').insertOne({ series: 'invoice', number: 'INV/2026-27/0099' });
  // C-2: the year's depreciation posted twice.
  await db.collection('journals').insertMany([
    { journalNo: 'JV/2025-26/0001', status: 'posted', source: 'depreciation', sourceRef: '2025-26', total: 161692.67, date: d('2026-03-31') },
    { journalNo: 'JV/2025-26/0002', status: 'posted', source: 'depreciation', sourceRef: '2025-26', total: 161692.67, date: d('2026-03-31') },
    { journalNo: 'JV/2025-26/0003', status: 'posted', source: 'manual', sourceRef: '', total: 10, date: d('2026-03-31') },
  ]);
  // C-1: one bank credit posted as two receipts.
  await db.collection('payments').insertMany([
    { _id: voucher, voucherNo: 'RCT/2026-27/0001', kind: 'receipt', status: 'posted', source: 'statement', statementLine: 'NEFT SUNRISE 2500', account, accountName: 'Kotak CA', date: d('2026-11-03'), amount: 2500 },
    { voucherNo: 'RCT/2026-27/0002', kind: 'receipt', status: 'posted', source: 'statement', statementLine: 'NEFT SUNRISE 2500', account, accountName: 'Kotak CA', date: d('2026-11-03'), amount: 2500 },
  ]);
  // B-2 / B-4: two different lines point at one voucher.
  await db.collection('bankstatements').insertOne({ account, lines: [
    { index: 0, key: '2026-11-03|out|5.9|CHRG|', status: 'recorded', voucher, voucherNo: 'PAY/2026-27/0001', amount: 5.9 },
    { index: 1, key: '2026-11-10|out|5.9|CHRG|', status: 'recorded', voucher, voucherNo: 'PAY/2026-27/0001', amount: 5.9 },
  ] });
  // C-4: 16,800 of credit notes against 10,500.
  await db.collection('accountnotes').insertMany([
    { noteNo: 'CN/2026-27/0001', status: 'issued', kind: 'credit', partyType: 'customer', against: { docType: 'Invoice', doc: inv1 }, totals: { grand: 8400 } },
    { noteNo: 'CN/2026-27/0002', status: 'issued', kind: 'credit', partyType: 'customer', against: { docType: 'Invoice', doc: inv1 }, totals: { grand: 8400 } },
  ]);
  await db.collection('supplierbills').insertMany([
    // B-5: paid, 18,000 reversed, 9,000 re-claimed.
    { _id: paid, billNo: 'PB/2026-27/0001', supplierName: 'Sri Yarn', status: 'paid', billDate: d('2026-03-01'), itcReversal: { amount: 18000, reclaimAmount: 9000 } },
    { _id: cancelledBill, billNo: 'PB/2026-27/0002', status: 'cancelled', billDate: d('2026-07-01') },
  ]);
  // B-6: its sources are still marked entered.
  await db.collection('machineservicebills').insertOne({ billNo: 'CS/77', vendor: 'Comez', amount: 750, supplierBill: cancelledBill });
  await db.collection('inboxbills').insertOne({ filename: 'SY-118.pdf', supplierName: 'Sri Yarn', status: 'entered', bill: cancelledBill });
  // B-7: the slip's contra was cancelled by itself.
  await db.collection('contras').insertOne({ _id: contra, contraNo: 'CTR/2026-27/0001', status: 'cancelled' });
  await db.collection('depositslips').insertOne({ slipNo: 'DEP/2026-27/0001', date: d('2026-11-05'), cash: 20000, contra, contraNo: 'CTR/2026-27/0001' });
  // I-1: dated in the closed year, entered after it closed.
  await db.collection('accountssettings').insertOne({ key: 'accounts', lockDate: d('2026-03-31'), lockedAt: new Date('2026-04-20T10:00:00Z') });
  await db.collection('expenses').insertOne({ expenseNo: 'EXP/2025-26/0090', date: d('2026-03-28'), createdAt: new Date('2026-05-02T10:00:00Z'), status: 'approved' });
  await db.collection('expenses').insertOne({ expenseNo: 'EXP/2025-26/0091', date: d('2026-03-29'), createdAt: new Date('2026-05-03T10:00:00Z'), status: 'approved', fingerprints: [{ meta: { lockOverride: 'Auditor asked for it' } }] });
  // I-4: an opening balance imported twice.
  await db.collection('openingbalances').insertMany([1, 2].map((n) => ({ docNo: `OB/2026-27/000${n}`, status: 'posted', partyType: 'customer', customer, partyName: 'Sunrise', kind: 'due', date: d('2026-03-12'), refNo: 'INV-1182', amount: 48500 })));
  // Q-8: one challan entered twice.
  await db.collection('tdschallans').insertMany([1, 2].map(() => ({ month: '2026-09', section: '194C', bsrCode: '0510308', challanNo: '00412', depositedOn: d('2026-10-06'), amount: 1000 })));
  void supplier;

  const before = {};
  for (const c of await db.collections()) before[c.collectionName] = JSON.stringify(await c.find({}).sort({ _id: 1 }).toArray());

  const r = byKey(await checks(db));
  expect(r['due-dates'].rows).toEqual([expect.stringMatching(/^INV\/2026-27\/0001 .* the customer has 45 days$/)]);
  expect(r['journals-twice'].rows).toEqual([expect.stringContaining('depreciation 2025-26: JV/2025-26/0001, JV/2025-26/0002')]);
  expect(r['bank-line-twice'].rows).toEqual([expect.stringContaining('RCT/2026-27/0001, RCT/2026-27/0002')]);
  expect(r['voucher-two-lines'].rows).toEqual([expect.stringContaining('PAY/2026-27/0001')]);
  expect(r['notes-over-invoice'].rows).toEqual([expect.stringMatching(/INV\/2026-27\/0001 .*notes ₹16,800\.00/)]);
  expect(r['itc-part-reclaimed'].rows).toEqual([expect.stringMatching(/PB\/2026-27\/0001 .*₹9,000\.00 to re-claim/)]);
  expect(r['cancelled-bill-source'].count).toBe(2);
  expect(r['slip-contra-cancelled'].rows).toEqual([expect.stringContaining('DEP/2026-27/0001')]);
  expect(r['into-closed-period'].rows).toEqual([expect.stringContaining('EXP/2025-26/0090')]);   // the one with an override on record is not listed
  expect(r['opening-twice'].rows).toEqual([expect.stringContaining('OB/2026-27/0001, OB/2026-27/0002')]);
  expect(r['invoice-gaps'].rows).toEqual(['INV/2026-27/0002 was never issued']);
  expect(r['index-blockers'].rows).toEqual([expect.stringMatching(/^IRN a{16}… on more than one invoice {2}×2$/), expect.stringMatching(/^TDS challan 00412 of 2026-10-06 for 2026-09 194C, ₹1,000\.00 {2}×2$/)]);

  // Read-only: every collection is exactly as it was, and no collection was made.
  const after = {};
  for (const c of await db.collections()) after[c.collectionName] = JSON.stringify(await c.find({}).sort({ _id: 1 }).toArray());
  expect(after).toEqual(before);
});

it('shows only as many rows as asked, and still counts them all', async () => {
  await db.collection('tdschallans').insertMany(Array.from({ length: 8 }, (_, i) => ({ month: '2026-09', section: '194C', bsrCode: '0510308', challanNo: `0041${Math.floor(i / 2)}`, depositedOn: d('2026-10-06'), amount: 1000 })));
  const r = byKey(await checks(db, { limit: 2 }));
  expect(r['index-blockers']).toMatchObject({ count: 4 });
  expect(r['index-blockers'].rows).toHaveLength(2);
});
