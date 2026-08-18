'use strict';
// ══════════════════════════════════════════════════════════════════
//  TWO MIGRATIONS BEHIND THE COMPLAINTS FEATURE
//
//  1. The field rename. Complaint.order referenced JobOrder while being
//     called `order`. The collection SHOULD be empty — the model had no
//     routes — but "should be" is not "is", and a row written directly
//     against Mongo would lose its job link and take the lot trail with
//     it. So the migration is tested against rows, not assumed to be a
//     no-op.
//
//  2. The permission grant. Fourth time. See the grantAiHealth suite
//     for why this trap keeps needing a test rather than a comment.
//     /complaints differs in one way worth covering: it is NOT
//     admin-only, so production and packing accounts are touched too,
//     and the department-default rule is what keeps that safe.
//
//  Standalone mongod: plain updateOne/updateMany work, no transactions.
// ══════════════════════════════════════════════════════════════════

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');

const rename = require('../../migrations/20260818000002-complaint-order-to-job');
const grant  = require('../../migrations/20260818000003-grant-complaints-feature');
const { featuresForDepartment } = require('../../utils/features');

let mongo, client, db;

beforeAll(async () => {
  mongo  = await MongoMemoryServer.create();
  client = await new MongoClient(mongo.getUri()).connect();
  db     = client.db('test');
}, 120_000);

afterAll(async () => { await client.close(); await mongo.stop(); });
afterEach(async () => {
  await db.collection('users').deleteMany({});
  await db.collection('complaints').deleteMany({});
});

// ══════════════════════════════════════════════════════════════════
describe('renaming Complaint.order to Complaint.job', () => {
  const complaints = () => db.collection('complaints');

  test('an existing row keeps its link under the new name', async () => {
    const job = new ObjectId();
    await complaints().insertOne({ customer: new ObjectId(), order: job, reason: 'x' });

    await rename.up(db);

    const row = await complaints().findOne({});
    expect(String(row.job)).toBe(String(job));
    expect(row.order).toBeUndefined();
  });

  test('an empty collection is a clean no-op', async () => {
    await expect(rename.up(db)).resolves.not.toThrow();
    expect(await complaints().countDocuments({})).toBe(0);
  });

  test('a row already using `job` is left alone', async () => {
    // Re-running must not clobber a correct value with a stale one.
    const correct = new ObjectId();
    const stale = new ObjectId();
    await complaints().insertOne({ job: correct, order: stale, reason: 'x' });

    await rename.up(db);

    const row = await complaints().findOne({});
    expect(String(row.job)).toBe(String(correct));
  });

  test('running it twice changes nothing the second time', async () => {
    const job = new ObjectId();
    await complaints().insertOne({ customer: new ObjectId(), order: job, reason: 'x' });

    await rename.up(db);
    await rename.up(db);

    const row = await complaints().findOne({});
    expect(String(row.job)).toBe(String(job));
  });

  test('down puts the field back', async () => {
    const job = new ObjectId();
    await complaints().insertOne({ customer: new ObjectId(), order: job, reason: 'x' });

    await rename.up(db);
    await rename.down(db);

    const row = await complaints().findOne({});
    expect(String(row.order)).toBe(String(job));
    expect(row.job).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
describe('granting /complaints', () => {
  const seed = (rows) => db.collection('users').insertMany(rows);
  const featuresOf = async (email) =>
    (await db.collection('users').findOne({ email })).features;

  test('an admin with an explicit list gets the key', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/', '/orders'] }]);
    await grant.up(db);
    expect(await featuresOf('a@t.co')).toContain('/complaints');
  });

  test('a production account gets it too — this feature is not admin-only', async () => {
    // The containment half of the report is only actionable by the
    // people who can stop a job on the floor.
    expect(featuresForDepartment('production')).toContain('/complaints');
    await seed([{ email: 'p@t.co', department: 'production', features: ['/', '/warping'] }]);
    await grant.up(db);
    expect(await featuresOf('p@t.co')).toContain('/complaints');
  });

  test('a finance account does not get it — its department default excludes it', async () => {
    expect(featuresForDepartment('finance')).not.toContain('/complaints');
    await seed([{ email: 'f@t.co', department: 'finance', features: ['/', '/orders'] }]);
    await grant.up(db);
    expect(await featuresOf('f@t.co')).not.toContain('/complaints');
  });

  test('an account with NO list is left without one', async () => {
    // Absent means "defer to the role gate". Writing a list here would
    // tighten access rather than restore it.
    await seed([{ email: 'legacy@t.co', department: 'admin' }]);
    await grant.up(db);
    const u = await db.collection('users').findOne({ email: 'legacy@t.co' });
    expect(u.features).toBeUndefined();
  });

  test('an account with an EMPTY list is left empty — that was a decision', async () => {
    await seed([{ email: 'none@t.co', department: 'admin', features: [] }]);
    await grant.up(db);
    expect(await featuresOf('none@t.co')).toEqual([]);
  });

  test('an old account carrying only a role is mapped to its department', async () => {
    await seed([{ email: 'old@t.co', role: 'production', features: ['/'] }]);
    await grant.up(db);
    expect(await featuresOf('old@t.co')).toContain('/complaints');
  });

  test('running it twice does not duplicate the key', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/'] }]);
    await grant.up(db);
    await grant.up(db);
    const f = await featuresOf('a@t.co');
    expect(f.filter((k) => k === '/complaints')).toHaveLength(1);
  });

  test('down removes it again', async () => {
    await seed([{ email: 'a@t.co', department: 'admin', features: ['/'] }]);
    await grant.up(db);
    await grant.down(db);
    expect(await featuresOf('a@t.co')).not.toContain('/complaints');
  });
});
