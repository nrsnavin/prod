'use strict';
// ══════════════════════════════════════════════════════════════════
//  "APPROVE 1042" ON WHATSAPP, AFTER THE BOT'S SESSIONS WERE ENDED
//
//  The reply is carried out by the server calling its own approve route
//  as a bot account, with a token each process keeps for a day. End that
//  account's sessions (the Users screen does it, so does a new password)
//  and the kept token is refused — and was sent again, and refused
//  again, for every approval until the server was restarted.
//
//  Held here: refused once, the process drops the token, asks for a new
//  one and tries again, once.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
delete process.env.TWILIO_AUTH_TOKEN; // no signature check outside production

const mongoose = require('mongoose');
const axios = require('axios');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, notify, bot, session, User, Order, NotificationSettings, no;
const OWNER = '+919000000001';
const says = (text) => ({
  body: { From: `whatsapp:${OWNER}`, Body: text },
  get: () => undefined, protocol: 'https', originalUrl: '/api/v2/notify/whatsapp/incoming',
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  notify = require('../../api/notify.js');
  bot = require('../../utils/whatsappInbound.js');
  session = require('../../utils/session');
  User = require('../../models/User.js');
  Order = require('../../models/Order');
  NotificationSettings = require('../../models/NotificationSettings.js');
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  jest.restoreAllMocks();
  bot.resetWhatsAppBotToken();
  await Promise.all([User.deleteMany({}), Order.deleteMany({}), NotificationSettings.deleteMany({})]);
  const settings = await NotificationSettings.load();
  settings.recipients = [OWNER];
  await settings.save();
  // Orders number themselves; `no` is the one this order was given.
  ({ orderNo: no } = await Order.create({
    customer: new mongoose.Types.ObjectId(), status: 'Open', po: 'PO-1',
    date: new Date(), supplyDate: new Date(), elasticOrdered: [],
  }));
});
const approve = () => notify.handleIncoming(says(`APPROVE ${no}`));

// The approve route, as far as this matters: it lets a good session in.
function approveRoute() {
  const seen = [];
  jest.spyOn(axios, 'post').mockImplementation(async (_url, _payload, opts) => {
    const token = String(opts.headers.Cookie).replace(/^token=/, '');
    seen.push(token);
    try {
      await session.read(token);
      return { status: 200, data: { success: true } };
    } catch (err) {
      return { status: 401, data: { success: false, message: err.message } };
    }
  });
  return seen;
}

it('a kept token that is refused is replaced, and the approval goes through', async () => {
  const kept = await bot.getWhatsAppBotToken();
  await session.endAll((await User.findOne({ email: bot.BOT_EMAIL }))._id);
  const seen = approveRoute();

  const out = await approve();
  expect(out.body).toContain(`Order #${no} approved`);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(kept);
  expect(seen[1]).not.toBe(kept);

  // The next approval uses the new one straight away.
  seen.length = 0;
  await approve();
  expect(seen).toHaveLength(1);
});

it('CONTROL: a good token is used once', async () => {
  const seen = approveRoute();
  const out = await approve();
  expect(out.body).toContain(`Order #${no} approved`);
  expect(seen).toHaveLength(1);
});

it('refused twice, it says so and stops — it does not go round again', async () => {
  jest.spyOn(axios, 'post').mockResolvedValue({ status: 401, data: { success: false, message: 'Please login again' } });
  const out = await approve();
  expect(axios.post).toHaveBeenCalledTimes(2);
  expect(out.body).toContain(`Could not approve #${no}: Please login again`);
});

it('CONTROL: a refusal that is not about the session is passed on as it is', async () => {
  jest.spyOn(axios, 'post').mockResolvedValue({ status: 400, data: { success: false, code: 'INSUFFICIENT_STOCK', message: 'Not enough stock' } });
  const out = await approve();
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(out.body).toMatch(/Not enough stock/);
  expect(out.body).toContain(`APPROVE ${no} force:`);
});
