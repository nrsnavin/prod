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

    const counter = await db.collection("counters").findOne({ _id: "poNo" });
    expect(counter.seq).toBeGreaterThanOrEqual(1042); // next allocation > 1042
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
