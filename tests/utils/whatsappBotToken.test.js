'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE WHATSAPP BOT'S OWN SESSION
//
//  "APPROVE 1042" sent on WhatsApp is carried out by the server calling
//  its own approve route as a bot account, with a token each process
//  keeps for a day. Held here:
//
//    • two server processes meeting their first approval at the same
//      moment both find no bot and both create it; the one that loses
//      uses the account the other made (it used to fail the approval
//      with a duplicate-email error);
//    • a kept token that has stopped being good — the bot's sessions
//      ended from the Users screen — can be dropped and asked for again
//      (it used to refuse every approval until the server restarted).
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, User, session, bot;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  User = require('../../models/User.js');
  session = require('../../utils/session');
  bot = require('../../utils/whatsappInbound.js');
  await User.init(); // the unique email index is what the loser runs into
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  jest.restoreAllMocks();
  bot.resetWhatsAppBotToken();
  await User.deleteMany({});
});

it('makes the bot once, and keeps its token', async () => {
  const first = await bot.getWhatsAppBotToken();
  const again = await bot.getWhatsAppBotToken();
  expect(again).toBe(first);
  expect(await User.countDocuments({ email: bot.BOT_EMAIL })).toBe(1);
  const { user } = await session.read(first);
  expect(user).toMatchObject({ email: bot.BOT_EMAIL, role: 'admin' });
});

it('the process that loses the race to create the bot uses the one that was made', async () => {
  await bot.getWhatsAppBotToken(); // the other process, a moment earlier
  bot.resetWhatsAppBotToken();     // this process has not got as far as a token
  // …and looked for the bot before the other had made it.
  jest.spyOn(User, 'findOne').mockImplementationOnce(() => Promise.resolve(null));

  const token = await bot.getWhatsAppBotToken();
  expect(await User.countDocuments({ email: bot.BOT_EMAIL })).toBe(1);
  expect((await session.read(token)).user.email).toBe(bot.BOT_EMAIL);
});

it('CONTROL: a failure that is not the race is still a failure', async () => {
  jest.spyOn(User, 'create').mockImplementationOnce(() => Promise.reject(new Error('disk full')));
  await expect(bot.getWhatsAppBotToken()).rejects.toThrow('disk full');
});

it('a kept token that has stopped being good is dropped and replaced', async () => {
  const kept = await bot.getWhatsAppBotToken();
  await session.endAll((await User.findOne({ email: bot.BOT_EMAIL }))._id); // "sign out everywhere"
  await expect(session.read(kept)).rejects.toMatchObject({ statusCode: 401 });
  // Still the one this process would hand out…
  expect(await bot.getWhatsAppBotToken()).toBe(kept);

  // …until it is told the token was refused.
  bot.resetWhatsAppBotToken();
  const fresh = await bot.getWhatsAppBotToken();
  expect(fresh).not.toBe(kept);
  expect((await session.read(fresh)).user.email).toBe(bot.BOT_EMAIL);
});
