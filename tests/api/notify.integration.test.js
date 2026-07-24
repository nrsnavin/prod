'use strict';
//
// Integration tests for the notification management routes +
// orchestrator, against an in-memory Mongo. Auth middleware is
// stubbed (same pattern as the other integration suites) so we can
// hit the admin-gated routes directly. The WhatsApp provider is
// never configured in tests → everything runs dry-run, so no real
// messages are attempted.

jest.mock("../../middleware/auth.js", () => ({
  isAuthenticated: (req, _res, next) => { req.user = { _id: "1", role: "admin" }; next(); },
  isAdmin:         () => (_req, _res, next) => next(),
  requireFeature:  () => (_req, _res, next) => next(),
}));

const express              = require("express");
const bodyParser           = require("body-parser");
const request              = require("supertest");
const mongoose             = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let app, mongo, NotificationSettings, notifyLib;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  NotificationSettings = require("../../models/NotificationSettings.js");
  notifyLib            = require("../../utils/notify.js");
  const notifyRouter   = require("../../api/notify.js");

  app = express();
  app.use(bodyParser.json());
  app.use("/api/v2/notify", notifyRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
}, 60_000);

afterAll(async () => {
  if (mongo) { await mongoose.disconnect(); await mongo.stop(); }
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    await c.deleteMany({});
  }
});

describe("GET /api/v2/notify/settings", () => {
  test("creates + returns default settings, reports dry-run provider", async () => {
    const r = await request(app).get("/api/v2/notify/settings");
    expect(r.status).toBe(200);
    expect(r.body.settings.enabled).toBe(true);
    expect(r.body.settings.recipients).toEqual([]);
    expect(r.body.settings.events.orderCreated).toEqual({
      enabled: true, recipients: [], tier: "realtime", throttleSeconds: 0,
    });
    // No Twilio env in tests → not configured.
    expect(r.body.provider.configured).toBe(false);
  });
});

describe("PUT /api/v2/notify/settings", () => {
  test("updates recipients + toggles", async () => {
    const r = await request(app)
      .put("/api/v2/notify/settings")
      .send({
        recipients: ["+919876543210"],
        events: { orderCreated: false },
      });
    expect(r.status).toBe(200);
    expect(r.body.settings.recipients).toEqual(["+919876543210"]);
    expect(r.body.settings.events.orderCreated.enabled).toBe(false);
    // Persisted.
    const s = await NotificationSettings.load();
    expect(s.recipients).toEqual(["+919876543210"]);
  });

  test("rejects a malformed number", async () => {
    const r = await request(app)
      .put("/api/v2/notify/settings")
      .send({ recipients: ["98765"] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/invalid number/i);
  });

  test("rejects out-of-range quiet hours", async () => {
    const r = await request(app)
      .put("/api/v2/notify/settings")
      .send({ quietHours: { start: 25, end: 7 } });
    expect(r.status).toBe(400);
  });
});

describe("POST /api/v2/notify/test", () => {
  test("dry-runs when provider unconfigured + no recipients", async () => {
    const r = await request(app).post("/api/v2/notify/test").send({});
    expect(r.status).toBe(200);
    // No recipients yet → orchestrator skips.
    expect(r.body.result.skipped).toMatch(/no recipients/);
  });

  test("dry-runs a preview once a recipient exists", async () => {
    await request(app)
      .put("/api/v2/notify/settings")
      .send({ recipients: ["+919876543210"] });
    const r = await request(app)
      .post("/api/v2/notify/test")
      .send({ message: "ping" });
    expect(r.status).toBe(200);
    // One dry-run "send" attempted.
    expect(r.body.result.results[0].dryRun).toBe(true);
    expect(r.body.result.results[0].preview.body).toBe("ping");
    expect(r.body.hint).toMatch(/dry-run/i);
  });
});

describe("notify() orchestrator gating", () => {
  test("skips when master switch is off", async () => {
    await request(app).put("/api/v2/notify/settings").send({
      recipients: ["+919876543210"], enabled: false,
    });
    const res = await notifyLib.notify("orderCreated", { orderNo: 1 });
    expect(res.skipped).toBe("disabled");
  });

  test("skips a muted event", async () => {
    await request(app).put("/api/v2/notify/settings").send({
      recipients: ["+919876543210"], events: { orderCreated: false },
    });
    const res = await notifyLib.notify("orderCreated", { orderNo: 1 });
    expect(res.skipped).toMatch(/muted/);
  });

  test("dry-run sends to each recipient when enabled + unmuted", async () => {
    await request(app).put("/api/v2/notify/settings").send({
      recipients: ["+919876543210", "+919999999999"],
    });
    const res = await notifyLib.notify("orderCreated", {
      orderNo: 42, customerName: "Acme", totalMeters: 5000, lineCount: 1,
    });
    expect(res.results).toHaveLength(2);
    expect(res.results.every((x) => x.dryRun)).toBe(true);
  });
});
