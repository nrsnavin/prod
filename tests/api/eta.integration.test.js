'use strict';
//
// End-to-end integration tests for the ETA stack.
//
// Runs the real express routers against an in-memory Mongo, with
// seeded shifts / orders / jobs / machines. Catches the bugs that
// pure-math unit tests can't:
//   - aggregation pipeline syntax
//   - mongoose populate paths
//   - schema field mismatches
//   - the cold-start → plant → posterior fallback chain
//   - end-to-end shape of the API response

const request = require("supertest");
const mongoose = require("mongoose");
const {
  boot, oid, seedCustomer, seedOrder, seedMachine, seedJob, seedClosedShift,
} = require("../helpers/etaTestHarness.js");

let H;     // harness
let M;     // models

beforeAll(async () => {
  H = await boot();
  M = H.models;
}, 60_000);

afterAll(async () => {
  if (H) await H.stop();
});

afterEach(async () => {
  // Clear every collection between tests so order-state and
  // posterior accumulation can't leak across cases.
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v2/order/estimate-completion
// ─────────────────────────────────────────────────────────────────
describe("POST /api/v2/order/estimate-completion", () => {
  test("returns 400 when elasticOrdered is missing or empty", async () => {
    const r1 = await request(H.app).post("/api/v2/order/estimate-completion").send({});
    expect(r1.status).toBe(400);
    expect(r1.body.message).toMatch(/elasticOrdered/);

    const r2 = await request(H.app)
      .post("/api/v2/order/estimate-completion")
      .send({ elasticOrdered: [] });
    expect(r2.status).toBe(400);
  });

  test("returns an estimate with cold-start fallback when plant has no shift history", async () => {
    // Seed one machine so machineNoOfHeadAvg is defined.
    await seedMachine(M, { id: "M1", NoOfHead: 4, elastics: [{ head: 1, elastic: oid(10) }] });

    const res = await request(H.app)
      .post("/api/v2/order/estimate-completion")
      .send({
        elasticOrdered: [{ elastic: oid(10).toString(), quantity: 2000 }],
        machines: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(res.body.expectedDate).toBeDefined();
    expect(res.body.workingDays).toBeGreaterThan(0);
    expect(res.body.usedColdStart).toBe(true);
    expect(res.body.assumptions.join(" ")).toMatch(/cold-start/i);
    expect(res.body.whatIf.length).toBeGreaterThan(0);
  });

  test("uses plant rate when shift history exists", async () => {
    const machine = await seedMachine(M, {
      id: "M1", NoOfHead: 4, elastics: [{ head: 1, elastic: oid(10) }],
    });
    // Seed 10 closed shifts in the last 30 days — gives the plant rate aggregator
    // data to compute against.
    const today = new Date();
    for (let i = 0; i < 10; i++) {
      const d = new Date(today.getTime() - i * 86_400_000);
      await seedClosedShift(M, {
        date: d, machine: machine._id,
        elastics: [{ head: 1, elastic: oid(10) }],
        productionMeters: 400,
      });
    }

    const res = await request(H.app)
      .post("/api/v2/order/estimate-completion")
      .send({
        elasticOrdered: [{ elastic: oid(10).toString(), quantity: 2000 }],
        machines: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.aggregates.plantRate).toBeGreaterThan(0);
    expect(res.body.usedColdStart).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// GET /api/v2/order/:id/running-eta
// ─────────────────────────────────────────────────────────────────
describe("GET /api/v2/order/:id/running-eta", () => {
  test("400 on invalid order id", async () => {
    const res = await request(H.app).get("/api/v2/order/not-an-id/running-eta");
    expect(res.status).toBe(400);
  });

  test("404 when order does not exist", async () => {
    const res = await request(H.app)
      .get(`/api/v2/order/${oid(999)}/running-eta`);
    expect(res.status).toBe(404);
  });

  test("returns NO_ACTIVE_JOBS for an order with no jobs", async () => {
    const cust = await seedCustomer(M);
    const order = await seedOrder(M, {
      customer: cust._id,
      supplyDate: new Date(Date.now() + 7 * 86_400_000),
      status: "Approved",
      elasticOrdered: [{ elastic: oid(10), quantity: 1000 }],
    });

    const res = await request(H.app)
      .get(`/api/v2/order/${order._id}/running-eta`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe("NO_ACTIVE_JOBS");
  });

  test("returns full ETA with perJob breakdown for an in-flight order", async () => {
    const cust    = await seedCustomer(M);
    const machine = await seedMachine(M, {
      id: "M1", NoOfHead: 4,
      elastics: [
        { head: 1, elastic: oid(10) },
        { head: 2, elastic: oid(10) },
        { head: 3, elastic: oid(10) },
        { head: 4, elastic: oid(10) },
      ],
    });
    const order = await seedOrder(M, {
      customer: cust._id,
      supplyDate: new Date(Date.now() + 30 * 86_400_000),
      status: "InProgress",
      elasticOrdered: [{ elastic: oid(10), quantity: 8000 }],
      producedElastic: [{ elastic: oid(10), quantity: 2000 }],
    });
    await seedJob(M, {
      order: order._id, customer: cust._id, machine: machine._id,
      elastics:        [{ elastic: oid(10), quantity: 8000 }],
      producedElastic: [{ elastic: oid(10), quantity: 2000 }],
      status: "weaving",
    });

    const res = await request(H.app).get(`/api/v2/order/${order._id}/running-eta`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.expectedDate).toBeDefined();
    expect(res.body.workingDays).toBeGreaterThan(0);
    expect(Array.isArray(res.body.perJob)).toBe(true);
    expect(res.body.perJob.length).toBe(1);
    expect(res.body.perJob[0].machineLabel).toBe("M1");
    expect(res.body.perJob[0].perElastic[0].remainingMeters).toBe(6000);
    expect(res.body.rateSources).toBeDefined();
    // No posterior, no shifts → cold-start fallback.
    expect(res.body.rateSources.coldstart).toBeGreaterThan(0);
  });

  test("uses posterior when ≥ INFORMATIVE_THRESHOLD observations exist", async () => {
    const cust    = await seedCustomer(M);
    const machine = await seedMachine(M, {
      id: "M1", NoOfHead: 2,
      elastics: [
        { head: 1, elastic: oid(10) },
        { head: 2, elastic: oid(10) },
      ],
    });

    // Seed 6 posterior observations for (elastic 10, machine M1) — past threshold.
    await M.EtaRatePosterior.create({
      elastic: oid(10), machine: machine._id,
      shape: 6 * 400, rate: 6, observations: 6, lastUpdatedAt: new Date(),
    });

    const order = await seedOrder(M, {
      customer: cust._id,
      supplyDate: new Date(Date.now() + 30 * 86_400_000),
      status: "InProgress",
      elasticOrdered: [{ elastic: oid(10), quantity: 4000 }],
    });
    await seedJob(M, {
      order: order._id, customer: cust._id, machine: machine._id,
      elastics: [{ elastic: oid(10), quantity: 4000 }],
      status:   "weaving",
    });

    const res = await request(H.app).get(`/api/v2/order/${order._id}/running-eta`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rateSources.posterior).toBeGreaterThan(0);
    expect(res.body.rateSources.coldstart).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v2/order/running-eta-bulk
// ─────────────────────────────────────────────────────────────────
describe("POST /api/v2/order/running-eta-bulk", () => {
  test("400 on empty orderIds", async () => {
    const r = await request(H.app)
      .post("/api/v2/order/running-eta-bulk").send({ orderIds: [] });
    expect(r.status).toBe(400);
  });

  test("400 when more than 50 orderIds", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => oid(i + 1).toString());
    const r = await request(H.app)
      .post("/api/v2/order/running-eta-bulk").send({ orderIds: ids });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/50/);
  });

  test("returns NOT_RUNNING for non-in-flight statuses and OK for in-flight", async () => {
    const cust    = await seedCustomer(M);
    const machine = await seedMachine(M, {
      id: "M1", NoOfHead: 2,
      elastics: [
        { head: 1, elastic: oid(10) },
        { head: 2, elastic: oid(10) },
      ],
    });

    const openOrder = await seedOrder(M, {
      customer: cust._id, supplyDate: new Date(Date.now() + 30 * 86_400_000),
      status: "Open", elasticOrdered: [{ elastic: oid(10), quantity: 1000 }],
    });
    const runningOrder = await seedOrder(M, {
      customer: cust._id, supplyDate: new Date(Date.now() + 30 * 86_400_000),
      status: "InProgress", elasticOrdered: [{ elastic: oid(10), quantity: 2000 }],
    });
    await seedJob(M, {
      order: runningOrder._id, customer: cust._id, machine: machine._id,
      elastics: [{ elastic: oid(10), quantity: 2000 }],
      status:   "weaving",
    });

    const r = await request(H.app)
      .post("/api/v2/order/running-eta-bulk")
      .send({ orderIds: [openOrder._id.toString(), runningOrder._id.toString()] });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const etas = r.body.etas;
    expect(etas[openOrder._id.toString()].ok).toBe(false);
    expect(etas[openOrder._id.toString()].reason).toBe("NOT_RUNNING");
    expect(etas[runningOrder._id.toString()].ok).toBe(true);
    expect(etas[runningOrder._id.toString()].expectedDate).toBeDefined();
    expect(etas[runningOrder._id.toString()].workingDays).toBeGreaterThan(0);
    expect(etas[runningOrder._id.toString()].rateSources).toBeDefined();
  });

  test("marks NOT_FOUND for ids that don't exist", async () => {
    const ghost = oid(9999).toString();
    const r = await request(H.app)
      .post("/api/v2/order/running-eta-bulk").send({ orderIds: [ghost] });
    expect(r.status).toBe(200);
    expect(r.body.etas[ghost].ok).toBe(false);
    expect(r.body.etas[ghost].reason).toBe("NOT_FOUND");
  });
});
