'use strict';
//
// Pins the per-event recipients flow the Flutter NotifySettings page
// drives. The page lets each recipient toggle which WhatsApp events
// they receive; under the hood that PUTs `events.<ev>.recipients` and
// `events.<ev>.enabled`. These tests prove the contract end-to-end:
//
//   1. A non-empty events.<ev>.recipients overrides the global list.
//   2. An empty events.<ev>.recipients falls through to the global list.
//   3. When the UI unsubscribes the last recipient, it sets
//      events.<ev>.enabled = false (recipients:[] alone would
//      silently widen the audience back to global). The orchestrator
//      then skips the event with reason "event ... muted".

jest.mock("../../middleware/auth.js", () => ({
  isAuthenticated: (req, _res, next) => { req.user = { _id: "1", role: "admin" }; next(); },
  isAdmin:         () => (_req, _res, next) => next(),
  requireFeature:  () => (_req, _res, next) => next(),
}));

const express  = require("express");
const bodyParser = require("body-parser");
const request  = require("supertest");
const mongoose = require("mongoose");
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

async function seedGlobals(recipients) {
  const s = await NotificationSettings.load();
  s.enabled = true;
  s.recipients = recipients;
  await s.save();
}

// ─────────────────────────────────────────────────────────────────
// 1. Per-event override wins over global
// ─────────────────────────────────────────────────────────────────
describe("per-event recipients[] overrides the global list", () => {
  test("only the recipient in events.orderCreated.recipients receives the ping", async () => {
    await seedGlobals(["+91111111111", "+91222222222"]);

    // Page state: only recipient A is subscribed to orderCreated.
    const put = await request(app).put("/api/v2/notify/settings").send({
      events: {
        orderCreated: {
          enabled: true,
          recipients: ["+91111111111"],
          throttleSeconds: 0,
        },
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.settings.events.orderCreated.recipients)
      .toEqual(["+91111111111"]);

    await notifyLib.notify("orderCreated", { orderNo: 1 });
    const audit = await Notification.find({ event: "orderCreated" }).lean();
    const sentTo = audit
      .filter((r) => ["sent", "dry_run"].includes(r.status))
      .map((r) => r.recipient);
    expect(sentTo).toEqual(["+91111111111"]);
    expect(sentTo).not.toContain("+91222222222");
  });

  test("empty events.<ev>.recipients falls back to the global list", async () => {
    await seedGlobals(["+91111111111", "+91222222222"]);

    // No per-event override at all → global recipients apply.
    await notifyLib.notify("orderApproved", { orderNo: 7 });
    const audit = await Notification.find({ event: "orderApproved" }).lean();
    const sentTo = audit
      .filter((r) => ["sent", "dry_run"].includes(r.status))
      .map((r) => r.recipient)
      .sort();
    expect(sentTo).toEqual(["+91111111111", "+91222222222"]);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Page-style toggle round-trip
// ─────────────────────────────────────────────────────────────────
describe("page-style subscription toggles", () => {
  test("unsubscribing one recipient narrows the explicit list, others stay", async () => {
    await seedGlobals(["+91111111111", "+91222222222", "+91333333333"]);

    // The page computes the new explicit list as (global ∖ A) and
    // PUTs it back. This is what setEventSubscription does in
    // notify_settings_controller.dart when flipping a recipient off
    // from an event that was previously global-fallback.
    const put = await request(app).put("/api/v2/notify/settings").send({
      events: {
        orderCreated: {
          enabled: true,
          recipients: ["+91222222222", "+91333333333"],
        },
      },
    });
    expect(put.status).toBe(200);

    await notifyLib.notify("orderCreated", { orderNo: 99 });
    const sentTo = (await Notification.find({ event: "orderCreated" }).lean())
      .filter((r) => ["sent", "dry_run"].includes(r.status))
      .map((r) => r.recipient)
      .sort();
    expect(sentTo).toEqual(["+91222222222", "+91333333333"]);
  });

  test("toggling the LAST recipient off disables the event entirely", async () => {
    await seedGlobals(["+91111111111", "+91222222222"]);

    // The Flutter controller turns "nobody subscribed" into
    // enabled:false + recipients:[] so the orchestrator doesn't fall
    // back to global. This test pins that behaviour at the API layer.
    const put = await request(app).put("/api/v2/notify/settings").send({
      events: {
        orderCreated: {
          enabled: false,
          recipients: [],
        },
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.settings.events.orderCreated.enabled).toBe(false);

    await notifyLib.notify("orderCreated", { orderNo: 1 });
    const audit = await Notification.find({ event: "orderCreated" }).lean();
    // Exactly one skipped row, no sent/dry_run rows.
    expect(audit.length).toBe(1);
    expect(audit[0].status).toBe("skipped");
    expect(audit[0].reason).toMatch(/muted/);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. PUT validation matches Flutter's client-side validation
// ─────────────────────────────────────────────────────────────────
describe("PUT /settings validation", () => {
  test("rejects a non-E.164 recipient with a 400", async () => {
    const res = await request(app).put("/api/v2/notify/settings").send({
      recipients: ["not-a-number"],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid number/i);
  });

  test("accepts an empty recipients list (no recipients)", async () => {
    const res = await request(app).put("/api/v2/notify/settings").send({
      recipients: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.recipients).toEqual([]);
  });

  test("partial events patch leaves other events untouched", async () => {
    await seedGlobals(["+91111111111"]);
    // First PATCH: orderCreated explicit
    await request(app).put("/api/v2/notify/settings").send({
      events: {
        orderCreated: { enabled: true, recipients: ["+91111111111"] },
      },
    });
    // Second PATCH: orderApproved only — orderCreated should survive
    const res = await request(app).put("/api/v2/notify/settings").send({
      events: {
        orderApproved: { enabled: true, recipients: ["+91111111111"] },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.settings.events.orderCreated.recipients)
      .toEqual(["+91111111111"]);
    expect(res.body.settings.events.orderApproved.recipients)
      .toEqual(["+91111111111"]);
  });
});
