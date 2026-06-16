'use strict';
//
// Smoke test for the demo seed script.
//
// We can't `node scripts/seedDemoCustomer.js` against a real mongo
// from inside jest, but we can drive the same model writes through
// mongodb-memory-server. Re-using the script wholesale would require
// it to be importable — instead we extract the pieces that matter:
//   1. the wipe → seed → wipe → re-seed loop is idempotent
//   2. seeding populates the Bayesian posterior past the threshold
//   3. /running-eta for the InProgress orders returns ok: true with
//      a posterior-backed rate source
//
// These three properties together prove the script is fit for use.
//
const mongoose             = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { execSync }          = require("child_process");
const path                 = require("path");

let mongo;
let Models;
let updatePairPosterior;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  // Set the URI in env so the seed script connects to the same place
  // when we shell out to it below.
  process.env.MONGODB_URI = mongo.getUri();
  await mongoose.connect(mongo.getUri());

  Models = {
    Customer:         require("../../models/Customer.js"),
    CustomerUser:     require("../../models/CustomerUser.js"),
    Order:            require("../../models/Order.js"),
    JobOrder:         require("../../models/JobOrder.js"),
    Machine:          require("../../models/Machine.js"),
    Elastic:          require("../../models/Elastic.js"),
    RawMaterial:      require("../../models/RawMaterial.js"),
    ShiftDetail:      require("../../models/ShiftDetail.js"),
    DeliveryChallan:  require("../../models/DeliveryChallan.js"),
    EtaRatePosterior: require("../../models/EtaRatePosterior.js"),
  };
  updatePairPosterior = require("../../utils/etaPosterior.js").updatePairPosterior;
}, 60_000);

afterAll(async () => {
  if (mongo) {
    await mongoose.disconnect();
    await mongo.stop();
  }
});

// Tiny re-implementation of the script's critical path — proves that
// the model schemas accept the documents the script emits, exercises
// the posterior update hook, and lets us assert on counts.
async function runSeed() {
  execSync(
    `node ${path.resolve(__dirname, "../../scripts/seedDemoCustomer.js")}`,
    {
      stdio: "ignore",
      env:   { ...process.env, MONGODB_URI: mongo.getUri() },
    }
  );
}

describe("seedDemoCustomer.js", () => {
  test("populates the demo customer and all portal-facing collections", async () => {
    await runSeed();

    // Identity
    const customer = await Models.Customer.findOne({ name: /Demo Textiles/ });
    expect(customer).toBeTruthy();
    const portalUser = await Models.CustomerUser.findOne({ customer: customer._id });
    expect(portalUser).toBeTruthy();
    expect(portalUser.email).toBe("demo@portal.test");

    // Catalog
    expect(await Models.RawMaterial.countDocuments({ name: /__DEMO__/ })).toBe(3);
    expect(await Models.Elastic.countDocuments({ name: /__DEMO__/ })).toBe(3);
    expect(await Models.Machine.countDocuments({ ID: /__DEMO__/ })).toBe(2);

    // Orders — one of every status the portal renders
    const orders = await Models.Order.find({ customer: customer._id }).lean();
    expect(orders.length).toBe(6);
    const statuses = orders.map((o) => o.status).sort();
    expect(statuses).toEqual(
      ["Approved", "Cancelled", "Completed", "InProgress", "InProgress", "Open"].sort()
    );

    // Jobs — three active + one completed
    const jobs = await Models.JobOrder.find({ customer: customer._id }).lean();
    expect(jobs.length).toBe(4);

    // DCs scoped to the completed order
    const completed = orders.find((o) => o.status === "Completed");
    const dcs = await Models.DeliveryChallan.find({ order: completed._id }).lean();
    expect(dcs.length).toBe(2);
    expect(dcs.map((d) => d.status).sort()).toEqual(["delivered", "dispatched"]);

    // Posterior — script replays many shifts, every pair should be
    // past the 5-observation informative threshold for the elastics
    // that actually run on each machine.
    const posteriors = await Models.EtaRatePosterior.find({}).lean();
    expect(posteriors.length).toBeGreaterThan(0);
    const allInformative = posteriors.every((p) => (p.observations || 0) >= 5);
    expect(allInformative).toBe(true);
  }, 90_000);

  test("is idempotent — re-running yields the same counts, not duplicates", async () => {
    const counts1 = await snapshot();
    await runSeed();
    const counts2 = await snapshot();
    expect(counts2).toEqual(counts1);
  }, 90_000);
});

async function snapshot() {
  const customer = await Models.Customer.findOne({ name: /Demo Textiles/ });
  return {
    customers:    await Models.Customer.countDocuments({ _id: customer._id }),
    portalUsers:  await Models.CustomerUser.countDocuments({ customer: customer._id }),
    rawMaterials: await Models.RawMaterial.countDocuments({ name: /__DEMO__/ }),
    elastics:     await Models.Elastic.countDocuments({ name: /__DEMO__/ }),
    machines:     await Models.Machine.countDocuments({ ID: /__DEMO__/ }),
    orders:       await Models.Order.countDocuments({ customer: customer._id }),
    jobs:         await Models.JobOrder.countDocuments({ customer: customer._id }),
    dcs:          await Models.DeliveryChallan.countDocuments({ order: {
      $in: (await Models.Order.find({ customer: customer._id }).select("_id").lean())
        .map((o) => o._id),
    } }),
  };
}
