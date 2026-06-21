'use strict';
//
// Step 8 — pins the gating thresholds for the three notification
// self-health checks. notify() is mocked so we just assert which
// helper fired with which payload.

jest.mock("../../utils/notify.js", () => ({
  notify: jest.fn().mockResolvedValue({ ok: true }),
}));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo, Notification, health, notifyMock;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Notification = require("../../models/Notification.js");
  health       = require("../../utils/systemHealth.js");
  notifyMock   = require("../../utils/notify.js").notify;
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
  notifyMock.mockClear();
});

async function seedRow(over = {}) {
  return Notification.create({
    event: "orderCreated", recipient: "+91", channel: "whatsapp",
    status: "sent", body: "x", ...over,
  });
}

// ─────────────────────────────────────────────────────────────────
// notificationDeliveryFailed
// ─────────────────────────────────────────────────────────────────
describe("checkNotificationDeliveryFailed", () => {
  test("fires when errors ≥ floor AND error ratio ≥ 20%", async () => {
    // 5 errors out of 20 attempts → 25% error rate
    for (let i = 0; i < 15; i++) await seedRow({ status: "sent" });
    for (let i = 0; i < 5; i++)  await seedRow({ status: "error", reason: "Twilio: 21610" });

    await health.checkNotificationDeliveryFailed();
    expect(notifyMock).toHaveBeenCalledWith(
      "notificationDeliveryFailed",
      expect.objectContaining({
        errorCount: 5, totalAttempts: 20, topReason: "Twilio: 21610",
      }),
    );
  });

  test("stays silent when error ratio is below 20%", async () => {
    for (let i = 0; i < 19; i++) await seedRow({ status: "sent" });
    for (let i = 0; i < 3; i++)  await seedRow({ status: "error" });

    await health.checkNotificationDeliveryFailed();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("stays silent when error count is below floor", async () => {
    for (let i = 0; i < 3; i++) await seedRow({ status: "sent" });
    for (let i = 0; i < 2; i++) await seedRow({ status: "error" });
    await health.checkNotificationDeliveryFailed();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("ignores rows older than the 24h window", async () => {
    const old = new Date(Date.now() - 48 * 3600_000);
    for (let i = 0; i < 10; i++) await seedRow({ status: "error", createdAt: old });
    await health.checkNotificationDeliveryFailed();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// cronDigestSkipped
// ─────────────────────────────────────────────────────────────────
describe("checkCronDigestSkipped", () => {
  test("fires when last morningDigest is older than 25h", async () => {
    const old = new Date(Date.now() - 48 * 3600_000);
    await seedRow({ event: "morningDigest", status: "sent", createdAt: old });
    await health.checkCronDigestSkipped();
    expect(notifyMock).toHaveBeenCalledWith(
      "cronDigestSkipped",
      expect.objectContaining({ lastSentLabel: expect.any(String) }),
    );
  });

  test("stays silent when a recent morningDigest exists", async () => {
    await seedRow({ event: "morningDigest", status: "sent" });
    await health.checkCronDigestSkipped();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  test("stays silent on fresh installs (no digest history at all)", async () => {
    await health.checkCronDigestSkipped();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// notifyDryRunStillActive
// ─────────────────────────────────────────────────────────────────
describe("checkDryRunStillActive", () => {
  test("fires when ≥5 dry-run rows in last 24h", async () => {
    for (let i = 0; i < 6; i++) await seedRow({ status: "dry_run" });
    await health.checkDryRunStillActive();
    expect(notifyMock).toHaveBeenCalledWith(
      "notifyDryRunStillActive",
      expect.objectContaining({ dryRunCount: 6 }),
    );
  });

  test("stays silent below the floor", async () => {
    for (let i = 0; i < 3; i++) await seedRow({ status: "dry_run" });
    await health.checkDryRunStillActive();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
