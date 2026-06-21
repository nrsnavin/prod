'use strict';
//
// Step — daily anomaly stream. Pins the gating thresholds for each
// helper. buildDigestData (large) is mocked, and notify() is mocked
// so we assert exactly which event fired with which payload.

jest.mock("../../utils/notify.js", () => ({
  notify: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../../utils/digest.js", () => ({
  buildDigestData: jest.fn(),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo, Wastage, EtaRatePosterior, alerts, notifyMock, buildDigestData;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Wastage          = require("../../models/Wastage.js");
  EtaRatePosterior = require("../../models/EtaRatePosterior.js");
  alerts           = require("../../utils/dailyAnomalyAlerts.js");
  notifyMock       = require("../../utils/notify.js").notify;
  buildDigestData  = require("../../utils/digest.js").buildDigestData;
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
  notifyMock.mockClear();
  buildDigestData.mockReset();
});

// ─────────────────────────────────────────────────────────────────
// projectedStockoutAlert
// ─────────────────────────────────────────────────────────────────
describe("checkProjectedStockouts", () => {
  test("fires when ≥1 material projects out within 3 days", async () => {
    buildDigestData.mockResolvedValue({
      stockouts: [
        { name: "Latex",    stock:  3, daysToStockout: 1 },
        { name: "Yarn-20s", stock: 12, daysToStockout: 2 },
        { name: "Hooks",    stock: 30, daysToStockout: 6 },  // out of horizon
      ],
    });
    await alerts.checkProjectedStockouts();
    expect(notifyMock).toHaveBeenCalledWith(
      "projectedStockoutAlert",
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ name: "Latex" }),
          expect.objectContaining({ name: "Yarn-20s" }),
        ]),
      }),
    );
    // Out-of-horizon material excluded
    const payload = notifyMock.mock.calls[0][1];
    expect(payload.items.find((i) => i.name === "Hooks")).toBeUndefined();
  });

  test("stays silent when nothing is within horizon", async () => {
    buildDigestData.mockResolvedValue({
      stockouts: [{ name: "Hooks", stock: 30, daysToStockout: 6 }],
    });
    await alerts.checkProjectedStockouts();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// posteriorDriftDetected
// ─────────────────────────────────────────────────────────────────
describe("checkPosteriorDrifts", () => {
  test("fires one event per drifted pair", async () => {
    buildDigestData.mockResolvedValue({
      posteriorDrift: [
        { machine: "m1", elastic: "e1",
          machineLabel: "M1", elasticName: "ElasticA",
          dropPct: 32, recentAvg: 1800, olderAvg: 2650 },
        { machine: "m2", elastic: "e2",
          machineLabel: "M2", elasticName: "ElasticB",
          dropPct: 27, recentAvg: 1500, olderAvg: 2050 },
      ],
    });
    await alerts.checkPosteriorDrifts();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledWith(
      "posteriorDriftDetected",
      expect.objectContaining({ machineLabel: "M1", dropPct: 32 }),
    );
  });

  test("stays silent when nothing drifted", async () => {
    buildDigestData.mockResolvedValue({ posteriorDrift: [] });
    await alerts.checkPosteriorDrifts();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// wastageAnomalyDay
// ─────────────────────────────────────────────────────────────────
async function seedWastage(when, quantity, reason = "Yarn break") {
  // Bypass schema validation — we only need the fields the helper
  // reads (createdAt, quantity, reason).
  return Wastage.collection.insertOne({
    quantity, reason, createdAt: when,
  });
}

describe("checkWastageAnomalyDay", () => {
  test("fires when yesterday ≥ 2× the trailing 30d baseline", async () => {
    const today = new Date("2026-06-20T08:00:00Z");
    today.setHours(0,0,0,0);
    const yday = new Date(today.getTime() - 86_400_000);
    // Baseline: 10 days * 100 m = 100 m/day baseline
    for (let i = 2; i <= 11; i++) {
      const day = new Date(today.getTime() - i * 86_400_000);
      await seedWastage(day, 100);
    }
    // Yesterday: 300 m → 3× baseline
    await seedWastage(yday, 300, "Operator change");
    await alerts.checkWastageAnomalyDay(today);
    expect(notifyMock).toHaveBeenCalledWith(
      "wastageAnomalyDay",
      expect.objectContaining({
        metersYesterday: 300,
        topReason:       "Operator change",
      }),
    );
    const p = notifyMock.mock.calls[0][1];
    expect(p.multiplier).toBeGreaterThanOrEqual(2);
  });

  test("stays silent on a normal day", async () => {
    const today = new Date("2026-06-20T08:00:00Z");
    today.setHours(0,0,0,0);
    const yday = new Date(today.getTime() - 86_400_000);
    for (let i = 2; i <= 11; i++) {
      await seedWastage(new Date(today.getTime() - i * 86_400_000), 100);
    }
    await seedWastage(yday, 110);
    await alerts.checkWastageAnomalyDay(today);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("ignores spikes when the baseline is below noise floor", async () => {
    const today = new Date("2026-06-20T08:00:00Z");
    today.setHours(0,0,0,0);
    const yday = new Date(today.getTime() - 86_400_000);
    // Baseline ~4 m/day → below WASTAGE_MIN_BASELINE (50)
    for (let i = 2; i <= 6; i++) {
      await seedWastage(new Date(today.getTime() - i * 86_400_000), 4);
    }
    await seedWastage(yday, 40);  // 10× the baseline but baseline is noise
    await alerts.checkWastageAnomalyDay(today);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// mlPosteriorStale
// ─────────────────────────────────────────────────────────────────
describe("checkMlPosteriorStale", () => {
  async function seedPair(daysAgo) {
    return EtaRatePosterior.create({
      elastic: new mongoose.Types.ObjectId(),
      machine: new mongoose.Types.ObjectId(),
      shape: 100, rate: 5, observations: 5,
      lastUpdatedAt: new Date(Date.now() - daysAgo * 86_400_000),
    });
  }

  test("fires when ≥50% of pairs haven't been updated in 3d", async () => {
    for (let i = 0; i < 8; i++) await seedPair(5);   // stale
    for (let i = 0; i < 2; i++) await seedPair(0.5); // fresh
    await alerts.checkMlPosteriorStale();
    expect(notifyMock).toHaveBeenCalledWith(
      "mlPosteriorStale",
      expect.objectContaining({ activePairs: 10, stalePairs: 8 }),
    );
  });

  test("stays silent when most pairs are fresh", async () => {
    for (let i = 0; i < 2; i++) await seedPair(5);
    for (let i = 0; i < 8; i++) await seedPair(0.5);
    await alerts.checkMlPosteriorStale();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("stays silent on tiny plants (below pair-count floor)", async () => {
    for (let i = 0; i < 3; i++) await seedPair(5);
    await alerts.checkMlPosteriorStale();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
