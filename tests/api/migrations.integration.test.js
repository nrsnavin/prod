'use strict';
//
// The migration chain must run cleanly on a fresh database and do what
// it says: seed the numbering counters from existing data and create
// the unique poNo index — refusing (with a report) when duplicate PO
// numbers already exist.
//
// Runs the REAL migrate-mongo CLI in a child process (the same command
// `npm run migrate` executes on deploy), pointed at an in-memory Mongo
// via MONGO_URL — dotenv does not override pre-set env vars, so the
// config resolves to the test database, never config/.env.

const { execFileSync } = require("child_process");
const path = require("path");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

const ROOT = path.join(__dirname, "../..");
const CLI  = path.join(ROOT, "node_modules/.bin/migrate-mongo");

let mongo, client, db, uri;

function run(args) {
  return execFileSync(CLI, args, {
    cwd: ROOT,
    env: { ...process.env, MONGO_URL: uri },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeEach(async () => {
  mongo  = await MongoMemoryServer.create();
  uri    = `${mongo.getUri()}jarvis-test`;
  client = await MongoClient.connect(uri);
  db     = client.db();
});

afterEach(async () => {
  await client.close();
  await mongo.stop();
});

describe("migration chain (real CLI)", () => {
  it("applies cleanly on a fresh database", async () => {
    const out = run(["up"]);
    expect(out).toMatch(/MIGRATED UP/);

    const status = run(["status"]);
    expect(status).not.toMatch(/PENDING/);

    // Unique poNo index exists.
    const indexes = await db.collection("purchaseorders").indexes();
    expect(indexes.some((i) => i.name === "poNo_unique" && i.unique)).toBe(true);
    // Idempotency TTL index exists.
    const ttl = await db.collection("idempotencykeys").indexes();
    expect(ttl.some((i) => i.name === "createdAt_ttl")).toBe(true);
  }, 60_000);

  it("seeds the poNo counter from existing data", async () => {
    await db.collection("purchaseorders").insertMany([
      { poNo: 1001, status: "Open" },
      { poNo: 1042, status: "Completed" },
    ]);
    run(["up"]);

    // Counters live in "doc_counters": the shared "counters" collection is
    // owned by mongoose-sequence, whose unique { id, reference_value }
    // index rejected our rows (see 20260725000002-move-doc-counters).
    const counter = await db.collection("doc_counters").findOne({ _id: "poNo" });
    expect(counter.seq).toBeGreaterThanOrEqual(1042); // next allocation > 1042
    // …and nothing of ours is left behind in the plugin's collection.
    expect(await db.collection("counters").findOne({ _id: "poNo" })).toBeNull();
  }, 60_000);

  // The real database is not a fresh one: the app has been running for
  // months, so mongoose-sequence has already created "counters" and put
  // its unique { id, reference_value } index on it. Our rows carry
  // neither field, so they all index as (null, null) — the first row
  // inserts and every later one dies with E11000. A migration chain that
  // only ever runs against a virgin database never meets that index, and
  // that is exactly how it reached a production deploy and stopped it.
  it("runs on a database where mongoose-sequence already owns \"counters\"", async () => {
    await db.collection("counters").createIndex(
      { id: 1, reference_value: 1 },
      { unique: true, name: "id_1_reference_value_1" }
    );
    // A row belonging to the plugin — Order.orderNo's sequence.
    await db.collection("counters").insertOne({ id: "orderNo", reference_value: "", seq: 812 });

    // Two of OUR counters, which is what triggers it: one poNo and one
    // DC sequence both landing as (null, null).
    await db.collection("purchaseorders").insertOne({ poNo: 1042, status: "Open" });
    await db.collection("deliverychallans").insertMany([
      { type: "elastic", financialYear: "25/26", sequence: 7 },
      { type: "yarn", financialYear: "25/26", sequence: 3 },
    ]);

    run(["up"]); // must not throw

    const dc = db.collection("doc_counters");
    expect((await dc.findOne({ _id: "poNo" })).seq).toBeGreaterThanOrEqual(1042);
    expect((await dc.findOne({ _id: "dc:elastic:25/26" })).seq).toBe(7);
    expect((await dc.findOne({ _id: "dc:yarn:25/26" })).seq).toBe(3);

    // The plugin's own row is untouched.
    const plugin = await db.collection("counters").findOne({ id: "orderNo" });
    expect(plugin.seq).toBe(812);
  }, 60_000);

  // What the failed deploy actually left behind: the poNo row reached
  // "counters" before the DC row hit the index, and nothing was recorded
  // in the changelog. Re-running has to pick that up rather than leave a
  // second copy of a live sequence in the plugin's collection.
  it("clears a counter left in \"counters\" by an earlier failed run", async () => {
    await db.collection("counters").createIndex(
      { id: 1, reference_value: 1 },
      { unique: true, name: "id_1_reference_value_1" }
    );
    await db.collection("counters").insertOne({ _id: "poNo", seq: 1099 });
    await db.collection("purchaseorders").insertOne({ poNo: 1042, status: "Open" });

    run(["up"]);

    // The higher of the two wins, so no number can ever be re-issued.
    expect((await db.collection("doc_counters").findOne({ _id: "poNo" })).seq).toBe(1099);
    expect(await db.collection("counters").findOne({ _id: "poNo" })).toBeNull();
  }, 60_000);

  // The other half of "the real database is not a fresh one": mongoose
  // autoIndex has already built every index the schemas declare, under
  // ITS naming. createIndex refuses a key pattern it already knows under
  // a different name — "Index already exists with a different name" —
  // and takes the chain down with it. Every index the migrations create
  // has a mongoose-named twin, so this builds them all first.
  it("runs where mongoose autoIndex already built the same indexes under its own names", async () => {
    await db.collection("leaverequests")
      .createIndex({ employee: 1, date: 1, shift: 1 }, { unique: true }); // employee_1_date_1_shift_1
    await db.collection("leaverequests").createIndex({ date: 1 });
    await db.collection("purchaseorders").createIndex({ poNo: 1 }, { unique: true, sparse: true });
    await db.collection("packings").createIndex({ requestId: 1 }, { unique: true, sparse: true });
    await db.collection("suppliers").createIndex({ name: 1 }, { unique: true, sparse: true });
    await db.collection("shiftdetails").createIndex({ status: 1, date: 1 });

    run(["up"]); // must not throw

    const status = run(["status"]);
    expect(status).not.toMatch(/PENDING/);

    // The constraint is what matters, not the label: the existing index
    // is kept rather than rebuilt, so a live unique index is never
    // dropped just to rename it.
    const lr = await db.collection("leaverequests").indexes();
    const guard = lr.find((i) => i.key.employee === 1 && i.key.date === 1 && i.key.shift === 1);
    expect(guard.unique).toBe(true);
    // …and there is exactly one index on that key, not two.
    expect(lr.filter((i) => i.key.employee === 1 && i.key.date === 1 && i.key.shift === 1))
      .toHaveLength(1);
  }, 60_000);

  // An index that exists but does NOT do the job the migration needs has
  // to be replaced, or the migration silently leaves the constraint off.
  it("replaces an index whose keys match but whose behaviour does not", async () => {
    // Non-unique where the migration needs unique.
    await db.collection("purchaseorders").createIndex({ poNo: 1 }, { name: "poNo_1" });

    run(["up"]);

    const idx = await db.collection("purchaseorders").indexes();
    const poNo = idx.filter((i) => i.key.poNo === 1);
    expect(poNo).toHaveLength(1);
    expect(poNo[0].unique).toBe(true);
  }, 60_000);

  it("installs DB validators that reject negative stock", async () => {
    run(["up"]);

    // Insert must fail schema validation — the DB is the last line of
    // defense even if application code regresses.
    await expect(
      db.collection("rawmaterials").insertOne({ name: "Bad", stock: -5 })
    ).rejects.toThrow(/Document failed validation/i);

    // A valid insert still works.
    await db.collection("rawmaterials").insertOne({ name: "Good", stock: 5 });
  }, 60_000);

  it("skips (not aborts) the unique name index when master data has dupes", async () => {
    await db.collection("elastics").insertMany([
      { name: "40mm Woven" },
      { name: "40mm Woven" }, // duplicate master row
    ]);
    // Must complete — a master-data dupe must never block `npm start`.
    run(["up"]);

    const indexes = await db.collection("elastics").indexes();
    expect(indexes.some((i) => i.name === "name_unique")).toBe(false);
    // Clean collections still get the index.
    const supIdx = await db.collection("suppliers").indexes();
    expect(supIdx.some((i) => i.name === "name_unique" && i.unique)).toBe(true);
  }, 60_000);

  it("aborts with a report when duplicate PO numbers exist", async () => {
    await db.collection("purchaseorders").insertMany([
      { poNo: 1010, status: "Open" },
      { poNo: 1010, status: "Open" }, // the duplicate the index must refuse
    ]);
    let failed = false;
    try {
      run(["up"]);
    } catch (err) {
      failed = true;
      const text = `${err.stdout || ""}${err.stderr || ""}${err.message || ""}`;
      expect(text).toMatch(/duplicated PO number/i);
    }
    expect(failed).toBe(true);
  }, 60_000);
});
