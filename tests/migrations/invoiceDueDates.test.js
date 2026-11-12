'use strict';
// ══════════════════════════════════════════════════════════════════
//  INVOICES GIVEN THE DUE DATE THEIR CUSTOMER'S CREDIT DAYS SET
//
//  Every invoice raised in the app fell due on its own date, because
//  the customer's payment terms were never read. The migration:
//
//    • moves the due date of an invoice that falls due on its own date
//      (or has none) to its date + the customer's credit days;
//    • leaves alone a cancelled invoice, one whose due date was already
//      something else, and one for a customer with no credit days;
//    • keeps what it changed, so `down` puts each one back — unless the
//      due date was changed again since;
//    • does nothing the second time.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');

const migration = require('../../migrations/20261112000001-invoice-due-dates');

let mongo, client, db;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db = client.db('test');
}, 120_000);
afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => { for (const c of ['invoices', 'customers', 'migration_notes']) await db.collection(c).deleteMany({}); });

const day = (s) => new Date(`${s}T00:00:00Z`);
const due = async (no) => (await db.collection('invoices').findOne({ invoiceNumber: no })).dueDate;

async function seed() {
  const c45 = new ObjectId(), c0 = new ObjectId(), cWords = new ObjectId();
  await db.collection('customers').insertMany([
    { _id: c45, name: 'Sunrise', paymentTerms: '45' },
    { _id: c0, name: 'Cash buyer', paymentTerms: '0' },
    { _id: cWords, name: 'Kongu', paymentTerms: '30 days' },
  ]);
  await db.collection('invoices').insertMany([
    { invoiceNumber: 'A', customer: c45, status: 'issued', invoiceDate: day('2026-10-01'), dueDate: day('2026-10-01') },
    { invoiceNumber: 'B', customer: c45, status: 'issued', invoiceDate: day('2026-10-05') },                              // no due date at all
    { invoiceNumber: 'C', customer: c45, status: 'issued', invoiceDate: day('2026-10-01'), dueDate: day('2026-10-20') },  // already set to something else
    { invoiceNumber: 'D', customer: c45, status: 'cancelled', invoiceDate: day('2026-10-01'), dueDate: day('2026-10-01') },
    { invoiceNumber: 'E', customer: c0, status: 'issued', invoiceDate: day('2026-10-01'), dueDate: day('2026-10-01') },
    { invoiceNumber: 'F', customer: cWords, status: 'issued', invoiceDate: day('2026-10-01'), dueDate: day('2026-10-01') },
  ]);
}

describe('up', () => {
  it('moves the due date by the customer\'s credit days, only where it was the invoice date or missing', async () => {
    await seed();
    await migration.up(db);
    expect(await due('A')).toEqual(day('2026-11-15'));
    expect(await due('B')).toEqual(day('2026-11-19'));
    expect(await due('C')).toEqual(day('2026-10-20'));
    expect(await due('D')).toEqual(day('2026-10-01'));
    expect(await due('E')).toEqual(day('2026-10-01'));
    expect(await due('F')).toEqual(day('2026-10-31'));
    const note = await db.collection('migration_notes').findOne({ _id: '20261112000001-invoice-due-dates' });
    expect(note.changed.map((c) => [c.invoiceNumber, c.days]).sort()).toEqual([['A', 45], ['B', 45], ['F', 30]]);
  });

  it('does nothing the second time', async () => {
    await seed();
    await migration.up(db);
    const before = await db.collection('invoices').find().sort({ invoiceNumber: 1 }).toArray();
    await migration.up(db);
    expect(await db.collection('invoices').find().sort({ invoiceNumber: 1 }).toArray()).toEqual(before);
    expect((await db.collection('migration_notes').findOne({})).changed).toHaveLength(3);
  });

  it('is fine with nothing to correct', async () => {
    await migration.up(db);
    expect(await db.collection('migration_notes').countDocuments()).toBe(0);
  });
});

describe('down', () => {
  it('puts each one back, except where the due date was changed again since', async () => {
    await seed();
    await migration.up(db);
    await db.collection('invoices').updateOne({ invoiceNumber: 'F' }, { $set: { dueDate: day('2026-12-25') } });
    await migration.down(db);
    expect(await due('A')).toEqual(day('2026-10-01'));
    expect(await due('B')).toBeUndefined();
    expect(await due('F')).toEqual(day('2026-12-25'));
    expect(await db.collection('migration_notes').countDocuments()).toBe(0);
  });
});
