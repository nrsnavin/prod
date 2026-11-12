'use strict';
// ══════════════════════════════════════════════════════════════════
//  SETTINGS SAVED BY AN OLDER SERVER — utils/settingsDoc.js
//
//  A database brought over from a long-running server holds settings
//  records written before some of their parts existed. The production
//  settings page opened on such a record and failed reading
//  `shiftEndNudge.phones.length`: the record had the reminder, but no
//  phone list, and lean() handed it over exactly as stored.
//
//    • the production and accounts settings answer with every part,
//      the stored values kept and the missing ones at their defaults
//    • the reminder, handover and PO chaser run on such a record
//    • reading writes nothing; saving stores what it sets
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, ProductionSettings, AccountsSettings, admin;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(admin));
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie(admin)).send(body);

// As an older server stored it: auto-verify, and a reminder with no
// phone list. No handover, no PO chaser.
const OLD_PRODUCTION = {
  key: 'production',
  autoVerify: { enabled: true, tolerancePct: 12, minShifts: 8 },
  shiftEndNudge: { enabled: false, minutesBefore: 45 },
};

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  ProductionSettings = require('../../models/ProductionSettings.js');
  AccountsSettings = require('../../models/AccountsSettings.js');
  const User = require('../../models/User.js');
  admin = await User.create({ name: 'Owner', email: 'settings-old@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  await ProductionSettings.init();
  await AccountsSettings.init();
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await ProductionSettings.collection.deleteMany({});
  await AccountsSettings.collection.deleteMany({});
});

describe('a production settings record from an older server', () => {
  beforeEach(async () => { await ProductionSettings.collection.insertOne({ ...OLD_PRODUCTION }); });

  test('the settings page gets every part: what was stored, and defaults for the rest', async () => {
    const res = await get('/shift/production-settings');
    expect(res.status).toBe(200);
    const s = res.body.settings;
    expect(s.autoVerify).toEqual({ enabled: true, tolerancePct: 12, minShifts: 8 });
    expect(s.shiftEndNudge).toEqual(expect.objectContaining({ enabled: false, minutesBefore: 45, phones: [] }));
    expect(s.shiftHandover).toEqual(expect.objectContaining({ enabled: false, withinMinutes: 60, phones: [] }));
    expect(s.poChase).toEqual(expect.objectContaining({ auto: false, hour: 10, gapDays: 2 }));
  });

  test('reading it writes nothing', async () => {
    await get('/shift/production-settings');
    const stored = await ProductionSettings.collection.findOne({ key: 'production' });
    expect(stored.shiftHandover).toBeUndefined();
    expect(stored.shiftEndNudge.phones).toBeUndefined();
  });

  test('saving on it keeps what it had and stores what was set', async () => {
    const res = await put('/shift/production-settings', { shiftEndNudge: { enabled: true, phones: '9876543210' } });
    expect(res.status).toBe(200);
    const s = (await get('/shift/production-settings')).body.settings;
    expect(s.shiftEndNudge.enabled).toBe(true);
    expect(s.shiftEndNudge.phones).toHaveLength(1);
    expect(s.autoVerify.tolerancePct).toBe(12);
  });

  test('the shift-end reminder, the handover and the PO chaser run on it', async () => {
    await expect(require('../../services/shiftEndNudge').run()).resolves.toEqual(expect.objectContaining({ sent: false, why: 'off' }));
    await expect(require('../../services/shiftHandover').run()).resolves.toEqual(expect.objectContaining({ sent: false }));
    await expect(require('../../services/poChaser').settings()).resolves.toEqual(expect.objectContaining({ auto: false, hour: 10 }));
    await expect(require('../../services/autoVerify').settings()).resolves.toEqual(expect.objectContaining({ shiftHandover: expect.objectContaining({ phones: [] }) }));
  });
});

describe('an accounts settings record from an older server', () => {
  beforeEach(async () => { await AccountsSettings.collection.insertOne({ key: 'accounts', lockDate: null, lockedBy: '' }); });

  test('the accounts settings answer with every part', async () => {
    const res = await get('/accounts/settings');
    expect(res.status).toBe(200);
    const s = res.body.settings;
    expect(s.journals).toEqual(expect.objectContaining({ approvalAbove: 0 }));
    expect(s.tds.purchase194q).toEqual(expect.objectContaining({ enabled: false }));
    expect(s.connector).toEqual({ configured: false, lastSeenAt: null });
    expect(s.openingOnboarding).toEqual(expect.objectContaining({ asOn: null, completedAt: null }));
  });

  test('the books lock and the opening-balance card read it', async () => {
    await expect(require('../../services/booksLock').getSettings()).resolves.toEqual(expect.objectContaining({ bills: expect.objectContaining({ rateVariancePercent: 2 }) }));
    expect((await get('/accounts/settings')).status).toBe(200);
  });
});

test('a fresh install still makes the record with every default', async () => {
  const s = (await get('/shift/production-settings')).body.settings;
  expect(s.autoVerify.enabled).toBe(false);
  expect(s.shiftEndNudge.phones).toEqual([]);
  const stored = await ProductionSettings.collection.findOne({ key: 'production' });
  expect(stored.shiftHandover).toEqual(expect.objectContaining({ withinMinutes: 60 }));
});
