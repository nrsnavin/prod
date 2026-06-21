'use strict';
//
// Verifies that notify() writes a Notification audit row for every
// outcome and that the new GET /log + GET /stats surfaces work
// against real Mongo.

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

describe("notify() audit log", () => {
  test("writes a 'skipped' row when no recipients", async () => {
    const res = await notifyLib.notify("orderCreated", { orderNo: 1 });
    expect(res.skipped).toBe("no recipients");
    const rows = await Notification.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe("orderCreated");
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].reason).toBe("no recipients");
  });

  test("writes a 'skipped' row when event is muted", async () => {
    const s = await NotificationSettings.load();
    s.recipients = ["+919876543210"];
    s.events.orderCreated = false;
    await s.save();

    const res = await notifyLib.notify("orderCreated", { orderNo: 2 });
    expect(res.skipped).toMatch(/muted/);
    const rows = await Notification.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].reason).toMatch(/muted/);
  });

  test("writes one 'dry_run' row per recipient when provider unconfigured", async () => {
    const s = await NotificationSettings.load();
    s.recipients = ["+919876543210", "+918888888888"];
    await s.save();

    await notifyLib.notify("orderCreated", {
      orderNo: 3, customerName: "Acme", totalMeters: 100, lineCount: 1,
      _entity: { type: "Order", id: new mongoose.Types.ObjectId() },
    });
    const rows = await Notification.find();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "dry_run")).toBe(true);
    expect(rows.every((r) => r.body.includes("Order #3"))).toBe(true);
    // entity gets stamped
    expect(rows[0].entity.type).toBe("Order");
  });

  test("stamps the actor when provided", async () => {
    const s = await NotificationSettings.load();
    s.recipients = ["+919876543210"];
    await s.save();

    await notifyLib.notify("orderCancelled", {
      orderNo: 4,
      _actor: { id: "user-1", name: "Owner", role: "admin" },
    });
    const row = await Notification.findOne();
    expect(row.actor.name).toBe("Owner");
  });
});

describe("GET /api/v2/notify/log", () => {
  beforeEach(async () => {
    const s = await NotificationSettings.load();
    s.recipients = ["+919876543210"];
    await s.save();
    await notifyLib.notify("orderCreated",  { orderNo: 1 });
    await notifyLib.notify("orderApproved", { orderNo: 2 });
    await notifyLib.notify("orderCancelled",{ orderNo: 3 });
  });

  test("returns most-recent rows by default", async () => {
    const r = await request(app).get("/api/v2/notify/log");
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(3);
    // Sorted newest-first.
    expect(r.body.rows[0].event).toBe("orderCancelled");
  });

  test("filters by event", async () => {
    const r = await request(app).get("/api/v2/notify/log?event=orderApproved");
    expect(r.body.count).toBe(1);
    expect(r.body.rows[0].event).toBe("orderApproved");
  });

  test("limit param caps the result count", async () => {
    const r = await request(app).get("/api/v2/notify/log?limit=2");
    expect(r.body.count).toBe(2);
  });
});

describe("GET /api/v2/notify/stats", () => {
  test("pivots counts per (event, status)", async () => {
    const s = await NotificationSettings.load();
    s.recipients = ["+919876543210"];
    await s.save();
    await notifyLib.notify("orderCreated", { orderNo: 1 });
    await notifyLib.notify("orderCreated", { orderNo: 2 });
    await notifyLib.notify("orderApproved", { orderNo: 3 });

    const r = await request(app).get("/api/v2/notify/stats?days=7");
    expect(r.status).toBe(200);
    const byEvent = Object.fromEntries(r.body.events.map((e) => [e.event, e]));
    expect(byEvent.orderCreated.dry_run).toBe(2);
    expect(byEvent.orderApproved.dry_run).toBe(1);
    expect(byEvent.orderCreated.total).toBe(2);
  });
});
