'use strict';
//
// Step 2 tests — per-event recipients/tier/throttle, quiet hours,
// orderCompleted + orderProductionStarted formatters.

jest.mock("../../middleware/auth.js", () => ({
  isAuthenticated: (req, _res, next) => { req.user = { _id: "1", role: "admin" }; next(); },
  isAdmin:         () => (_req, _res, next) => next(),
}));

const express              = require("express");
const bodyParser           = require("body-parser");
const request              = require("supertest");
const mongoose             = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let app, mongo, NotificationSettings, Notification, notifyLib;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  NotificationSettings = require("../../models/NotificationSettings.js");
  Notification         = require("../../models/Notification.js");
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

// ─────────────────────────────────────────────────────────────────
// normalizeEventConfig (pure)
// ─────────────────────────────────────────────────────────────────
describe("normalizeEventConfig (legacy + new shapes)", () => {
  test("Boolean true → enabled object with defaults", () => {
    const cfg = NotificationSettings.normalizeEventConfig(true, "orderCreated");
    expect(cfg).toEqual({
      enabled: true, recipients: [], tier: "realtime", throttleSeconds: 0,
    });
  });

  test("Boolean false → disabled with defaults", () => {
    const cfg = NotificationSettings.normalizeEventConfig(false, "orderCreated");
    expect(cfg.enabled).toBe(false);
  });

  test("Object form is normalized verbatim", () => {
    const cfg = NotificationSettings.normalizeEventConfig({
      enabled: true, recipients: ["+91"], tier: "daily", throttleSeconds: 60,
    }, "orderCreated");
    expect(cfg.tier).toBe("daily");
    expect(cfg.recipients).toEqual(["+91"]);
    expect(cfg.throttleSeconds).toBe(60);
  });

  test("Undefined → enabled defaults using event's tier hint", () => {
    const cfg = NotificationSettings.normalizeEventConfig(undefined, "morningDigest");
    expect(cfg.enabled).toBe(true);
    expect(cfg.tier).toBe("daily"); // morningDigest's declared default
  });
});

// ─────────────────────────────────────────────────────────────────
// Per-event recipient override
// ─────────────────────────────────────────────────────────────────
describe("per-event recipient override", () => {
  test("uses per-event recipients[] when set, falls back to global otherwise", async () => {
    const s = await NotificationSettings.load();
    s.recipients = ["+91GLOBAL000000"];
    s.events.orderApproved = {
      enabled: true,
      recipients: ["+91PEREVT000000"],
      tier: "realtime",
      throttleSeconds: 0,
    };
    s.markModified("events");
    await s.save();

    // orderCreated has no override → uses global
    await notifyLib.notify("orderCreated", { orderNo: 1 });
    let rows = await Notification.find({ event: "orderCreated" });
    expect(rows.map((r) => r.recipient)).toEqual(["+91GLOBAL000000"]);

    // orderApproved has override → uses per-event
    await notifyLib.notify("orderApproved", { orderNo: 2 });
    rows = await Notification.find({ event: "orderApproved" });
    expect(rows.map((r) => r.recipient)).toEqual(["+91PEREVT000000"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Quiet hours
// ─────────────────────────────────────────────────────────────────
describe("quiet hours", () => {
  test("isInQuietHours handles wrap-around (22-7)", async () => {
    const s = await NotificationSettings.load();
    s.quietHours = { start: 22, end: 7 };
    s.timezone = "UTC";
    await s.save();

    // 23:30 UTC → inside
    expect(s.isInQuietHours(new Date("2026-06-20T23:30:00Z"))).toBe(true);
    // 03:00 UTC → inside (wrap)
    expect(s.isInQuietHours(new Date("2026-06-20T03:00:00Z"))).toBe(true);
    // 10:00 UTC → outside
    expect(s.isInQuietHours(new Date("2026-06-20T10:00:00Z"))).toBe(false);
  });

  test("realtime events ignore quiet hours; daily events defer", async () => {
    // Force "now" to land inside quiet hours by forcing wrap-around 0-23.
    const s = await NotificationSettings.load();
    s.recipients = ["+919876543210"];
    s.quietHours = { start: 0, end: 23 };
    s.timezone = "UTC";
    // orderCreated stays realtime by default
    s.events.morningDigest = { enabled: true, recipients: [], tier: "daily", throttleSeconds: 0 };
    s.markModified("events");
    await s.save();

    const r1 = await notifyLib.notify("orderCreated", { orderNo: 1 });
    expect(r1.skipped).toBeUndefined(); // realtime got through (dry_run, but no skip)

    const r2 = await notifyLib.notify("morningDigest", { body: "hello" });
    expect(r2.skipped).toBe("quiet hours");
  });
});

// ─────────────────────────────────────────────────────────────────
// Throttling
// ─────────────────────────────────────────────────────────────────
describe("throttling by (event, entity.id)", () => {
  test("second send within window is skipped; outside the window goes through", async () => {
    const s = await NotificationSettings.load();
    s.recipients = ["+919876543210"];
    s.events.orderCreated = {
      enabled: true, recipients: [],
      tier: "realtime", throttleSeconds: 60,
    };
    s.markModified("events");
    await s.save();

    const entityId = new mongoose.Types.ObjectId();
    // Manually seed a "sent" row to simulate a recent send.
    await Notification.create({
      event: "orderCreated",
      recipient: "+919876543210",
      status: "sent",
      body: "test",
      entity: { type: "Order", id: entityId },
    });

    const r = await notifyLib.notify("orderCreated", {
      orderNo: 1,
      _entity: { type: "Order", id: entityId },
    });
    expect(r.skipped).toBe("throttled");

    // Now seed an old sent row (older than the window) and a new
    // notify — different entity ids guarantee no throttle.
    const r2 = await notifyLib.notify("orderCreated", {
      orderNo: 2,
      _entity: { type: "Order", id: new mongoose.Types.ObjectId() },
    });
    expect(r2.skipped).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────
// PUT /settings — accepts rich event config
// ─────────────────────────────────────────────────────────────────
describe("PUT /settings accepts rich event config", () => {
  test("accepts Object form for per-event recipients + throttle", async () => {
    const r = await request(app).put("/api/v2/notify/settings").send({
      events: {
        orderCreated: { recipients: ["+919876543210"], throttleSeconds: 30 },
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.events.orderCreated).toMatchObject({
      enabled: true, recipients: ["+919876543210"], throttleSeconds: 30,
    });
  });

  test("Boolean shortcut still works (mute event)", async () => {
    const r = await request(app).put("/api/v2/notify/settings").send({
      events: { orderApproved: false },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.events.orderApproved.enabled).toBe(false);
  });

  test("rejects bad per-event tier", async () => {
    const r = await request(app).put("/api/v2/notify/settings").send({
      events: { orderCreated: { tier: "instant" } },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/tier/);
  });

  test("rejects bad recipient in per-event recipients", async () => {
    const r = await request(app).put("/api/v2/notify/settings").send({
      events: { orderCreated: { recipients: ["12345"] } },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/invalid number/);
  });
});

// ─────────────────────────────────────────────────────────────────
// New formatters
// ─────────────────────────────────────────────────────────────────
describe("new event formatters", () => {
  const { formatMessage } = require("../../utils/notify.js");

  test("orderCompleted renders on-time + counts", () => {
    const body = formatMessage("orderCompleted", {
      orderNo: 1042, customerName: "Acme", totalMeters: 12000,
      releasedReservations: 1, onTime: true, by: "Navin", via: "Admin app",
    });
    expect(body).toMatch(/Order completed/);
    expect(body).toMatch(/Order #1042/);
    expect(body).toMatch(/12,000 m/);
    expect(body).toMatch(/Reservations released: 1/);
    expect(body).toMatch(/On time/);
  });

  test("orderCompleted shows late warning when onTime is false", () => {
    const body = formatMessage("orderCompleted", { orderNo: 7, onTime: false });
    expect(body).toMatch(/Late vs supply/);
  });

  test("orderProductionStarted renders compact card", () => {
    const body = formatMessage("orderProductionStarted", {
      orderNo: 9, customerName: "Beta", totalMeters: 5000, by: "Navin", via: "Admin app",
    });
    expect(body).toMatch(/Production started/);
    expect(body).toMatch(/Order #9/);
    expect(body).toMatch(/5,000 m/);
  });
});
