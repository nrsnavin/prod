'use strict';
// ══════════════════════════════════════════════════════════════════
//  ONE ALERT, TWO WORKERS
//
//  The throttle used to be a question ("sent in the last N seconds?")
//  followed by a send. Two outbox workers could both ask before either
//  had sent, and the customer got the same WhatsApp twice. The window
//  is now claimed atomically; whoever loses it is throttled.
// ══════════════════════════════════════════════════════════════════

const mockSend = jest.fn();
jest.mock("../../utils/whatsapp.js", () => ({ sendWhatsApp: (...a) => mockSend(...a) }));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let mongo, NotificationSettings, Notification, NotifyThrottle, notifyLib;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  NotificationSettings = require("../../models/NotificationSettings.js");
  Notification         = require("../../models/Notification.js");
  NotifyThrottle       = require("../../models/NotifyThrottle.js");
  notifyLib            = require("../../utils/notify.js");
  await NotifyThrottle.init(); // the unique key is what does the work
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  await Notification.deleteMany({});
  await NotifyThrottle.deleteMany({});
  await NotificationSettings.deleteMany({});
  mockSend.mockReset();
  const s = await NotificationSettings.load();
  s.recipients = ["+919876543210"];
  s.events.orderCreated = { enabled: true, recipients: [], tier: "realtime", throttleSeconds: 60 };
  s.markModified("events");
  await s.save();
});

const send = (entityId, orderNo = 1) =>
  notifyLib.notify("orderCreated", { orderNo, _entity: { type: "Order", id: entityId } });

test("two workers sending the same alert at once: it goes out once", async () => {
  // Both are inside the provider call before either writes "sent".
  mockSend.mockImplementation(async () => {
    await new Promise((r) => setTimeout(r, 50));
    return { sent: true, providerId: "SM1" };
  });
  const id = new mongoose.Types.ObjectId();

  const [a, b] = await Promise.all([send(id), send(id)]);

  expect(mockSend).toHaveBeenCalledTimes(1);
  expect([a.skipped, b.skipped].filter(Boolean)).toEqual(["throttled"]);
  expect(await Notification.countDocuments({ status: "sent" })).toBe(1);
});

test("a send that did not go out does not hold the window", async () => {
  mockSend.mockResolvedValueOnce({ sent: false, dryRun: true });
  mockSend.mockResolvedValueOnce({ sent: true, providerId: "SM2" });
  const id = new mongoose.Types.ObjectId();

  expect((await send(id)).skipped).toBeUndefined();
  const second = await send(id);
  expect(second.skipped).toBeUndefined();
  expect(second.sent).toBe(1);
});

test("a provider that throws does not hold the window either", async () => {
  mockSend.mockRejectedValueOnce(new Error("provider down"));
  mockSend.mockResolvedValueOnce({ sent: true, providerId: "SM3" });
  const id = new mongoose.Types.ObjectId();

  expect((await send(id)).error).toBe("provider down");
  expect((await send(id)).sent).toBe(1);
});

test("shortening the throttle in settings applies at once", async () => {
  mockSend.mockResolvedValue({ sent: true, providerId: "SM4" });
  const id = new mongoose.Types.ObjectId();
  expect((await send(id)).sent).toBe(1);

  // Window opened 30s ago under a 60s throttle; the throttle is now 10s.
  await NotifyThrottle.updateOne({}, { $set: { at: new Date(Date.now() - 30_000) } });
  // (raw: Mongoose will not let createdAt be rewritten)
  await Notification.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 30_000) } });
  const s = await NotificationSettings.load();
  s.events.orderCreated.throttleSeconds = 10;
  s.markModified("events");
  await s.save();

  expect((await send(id)).sent).toBe(1);
});

test("different orders do not throttle each other", async () => {
  mockSend.mockResolvedValue({ sent: true, providerId: "SM5" });
  const [a, b] = await Promise.all([
    send(new mongoose.Types.ObjectId(), 1),
    send(new mongoose.Types.ObjectId(), 2),
  ]);
  expect(a.sent).toBe(1);
  expect(b.sent).toBe(1);
});
