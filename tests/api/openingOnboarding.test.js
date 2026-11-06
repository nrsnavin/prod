'use strict';
// ══════════════════════════════════════════════════════════════════
//  OPENING BALANCES, SET ONCE FROM THE DASHBOARD
//
//    • lists every customer and supplier with no opening balance yet
//    • a party drops off when a balance is posted, or "nothing owed"
//    • when none is left it is done for good: a party added later does
//      not bring it back
//    • an admin may stop it early; no one else
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, clerk;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  get: (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie(u)),
  post: (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body),
  put: (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie(u)).send(body),
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'AccountsSettings', 'OpeningNone']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ob@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  clerk = await M.User.create({ name: 'Meena', email: 'ob2@t.co', password: 'pass1234', role: 'accounts', department: 'finance' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
});

let n = 0;
const customer = (name, over = {}) => { n += 1; return M.Customer.create({ name, contactName: 'R', gstin: `33AAEPS${String(1000 + n)}F1Z2`, paymentTerms: '30', phoneNumber: '9200000000', ...over }); };
const supplier = (name, over = {}) => { n += 1; return M.Supplier.create({ name, gstin: `33AAAPS${String(n).padStart(4, '0')}F1Z5`, address: 'Erode', phoneNumber: '9840000000', ...over }); };
const status = async (u = clerk, q = '') => (await as(u).get(`/accounts/opening-onboarding${q}`)).body;

describe('opening balances from the dashboard', () => {
  it('lists who is left; each drops off when set; done for good when none is left', async () => {
    const sunrise = await customer('Sunrise Garments');
    const kumar = await customer('Kumar Knits');
    await customer('Old Buyer', { archived: true });
    await customer('Our stock', { houseStock: true });
    const yarn = await supplier('Sri Yarn Traders');
    await supplier('Closed Mills', { isActive: false });

    let s = await status();
    expect(s.active).toBe(true);
    expect(s.asOn).toMatch(/^\d{4}-03-31$/);
    expect(s.customers).toEqual({ total: 2, left: 2 });
    expect(s.suppliers).toEqual({ total: 1, left: 1 });
    expect(s.left.map((x) => x.name)).toEqual(['Kumar Knits', 'Sunrise Garments', 'Sri Yarn Traders']);
    expect((await status(clerk, '?partyType=supplier')).left.map((x) => x.name)).toEqual(['Sri Yarn Traders']);
    expect((await status(clerk, '?search=kum')).left.map((x) => x.name)).toEqual(['Kumar Knits']);

    // The day they are as on, kept.
    expect((await as(clerk).put('/accounts/opening-onboarding', { asOn: '2026-03-31' })).status).toBe(200);
    expect((await as(clerk).put('/accounts/opening-onboarding', { asOn: '2999-01-01' })).status).toBe(400);
    s = await status();
    expect(s).toMatchObject({ asOn: '2026-03-31', asOnSaved: true });

    // A balance posted: off the list.
    expect((await as(clerk).post('/accounts/opening-balances', { partyType: 'customer', party: String(sunrise._id), kind: 'due', date: '2026-03-31', amount: 48500 })).status).toBe(201);
    s = await status();
    expect(s.customers).toEqual({ total: 2, left: 1 });
    expect(s.left.map((x) => x.name)).toEqual(['Kumar Knits', 'Sri Yarn Traders']);

    // Nothing owed: off the list too, and saying it twice is fine.
    expect((await as(clerk).post('/accounts/opening-onboarding/none', { partyType: 'customer', party: String(kumar._id) })).status).toBe(200);
    expect((await as(clerk).post('/accounts/opening-onboarding/none', { partyType: 'customer', party: String(kumar._id) })).status).toBe(200);
    expect(await M.OpeningNone.countDocuments()).toBe(1);
    expect((await M.OpeningNone.findOne().lean()).byName).toBe('Meena');
    expect((await as(clerk).post('/accounts/opening-onboarding/none', { partyType: 'vendor', party: String(kumar._id) })).status).toBe(400);

    // The last one: done.
    expect((await as(clerk).post('/accounts/opening-balances', { partyType: 'supplier', party: String(yarn._id), kind: 'due', date: '2026-03-31', amount: 32150 })).status).toBe(201);
    s = await status();
    expect(s).toMatchObject({ active: false, justFinished: true });
    expect(s.completedAt).toBeTruthy();
    expect((await M.AccountsSettings.findOne({ key: 'accounts' }).lean()).openingOnboarding.completedBy).toBe('Meena');

    // A customer added afterwards is a new customer, not onboarding.
    await customer('New Buyer');
    s = await status();
    expect(s.active).toBe(false);
    expect(s.justFinished).toBeUndefined();
  });

  it('a cancelled balance puts the party back', async () => {
    const c = await customer('Sunrise Garments');
    await customer('Kumar Knits');
    const ob = (await as(admin).post('/accounts/opening-balances', { partyType: 'customer', party: String(c._id), kind: 'due', date: '2026-03-31', amount: 1000 })).body.row;
    expect((await status()).customers.left).toBe(1);
    expect((await as(admin).post(`/accounts/opening-balances/${ob._id}/cancel`, { reason: 'Wrong amount entered' })).status).toBe(200);
    expect((await status()).customers.left).toBe(2);
  });

  it('an admin may stop it with parties still left; no one else', async () => {
    await customer('Sunrise Garments');
    await supplier('Sri Yarn Traders');
    expect((await as(clerk).post('/accounts/opening-onboarding/close', {})).status).toBe(403);
    const r = await as(admin).post('/accounts/opening-onboarding/close', {});
    expect(r.status).toBe(200);
    expect(r.body.left).toBe(2);
    expect(await status()).toMatchObject({ active: false, leftWhenClosed: 2 });
  });

  it('nothing to show with no parties at all', async () => {
    expect(await status()).toMatchObject({ active: false, completedAt: null });
  });
});
