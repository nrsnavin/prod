'use strict';
// ══════════════════════════════════════════════════════════════════
//  A REMINDER THAT DID NOT GO, AND A NUMBER KEPT WITH A LEADING 0
//
//  Found reading api/accountsCollections.js, services/collections.js
//  and services/collectionReminders.js line by line.
//
//  1. A REMINDER THAT FAILED TO SEND COUNTED AS CONTACT. Every send is
//     kept in the customer's history with what it came back with. "Not
//     contacted this week" looked for any note at all — so a reminder
//     the provider refused stood the customer down for seven days: left
//     off tomorrow's run as "contacted in the last 7 days", and shown on
//     the office's list as "Last: reminder (whatsapp)… give them the
//     week". Nobody had reached them.
//
//  2. "098400 11111" BECAME "+09840011111". A number kept with its trunk
//     0 — how half of India writes one — was sent to as a number that
//     does not exist, and the customer's own reply from +91 98400 11111
//     was a stranger's.
//
//  3. A NOTE COULD BE LOGGED AGAINST NOBODY: any well-formed id, and a
//     promise of a negative amount.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
delete process.env.TWILIO_AUTH_TOKEN;

const mockSend = jest.fn(async () => ({ sent: true, providerId: 'wa1' }));
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true, PROVIDER: 'twilio' }));
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, reminders, collections;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const get  = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const put  = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const incoming = (from, Body) => request(app).post('/api/v2/notify/incoming').type('form').send({ From: `whatsapp:${from}`, Body });
const DAY = 86_400_000;
const refused = { sent: false, error: 'The number +910000000000 is not a valid WhatsApp number' };

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  reminders = require('../../services/collectionReminders');
  collections = require('../../services/collections');
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'CollectionNote', 'NotificationSettings', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'cf@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await M.NotificationSettings.create({ recipients: ['+919800000000'] }); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  mockSend.mockReset();
  mockSend.mockImplementation(async () => ({ sent: true, providerId: 'wa1' }));
});

let n = 0;
async function owing({ phone, daysPast = 10, grand = 52500 } = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Meenakshi Garments ${n}`, contactName: 'Ravi', phoneNumber: phone || `98410${String(10000 + n)}`, paymentTerms: '30' });
  const due = new Date(Date.now() - daysPast * DAY);
  await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(due.getTime() - 30 * DAY), dueDate: due,
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu', gstin: '33AAECB1234F1Z5', stateCode: '33' }, buyer: { name: customer.name, stateCode: '33' },
    supplyType: 'intra', placeOfSupply: '33', lines: [], totals: { taxable: grand / 1.05, grand }, status: 'issued',
  });
  return customer;
}
const remindersOn = () => put('/accounts/settings', { collections: { autoRemind: { enabled: true, hour: 11, everyDays: 7, minOverdueDays: 3 } } });
const row = async (customer) => (await get('/accounts/collections?held=true')).body.rows.find((r) => String(r.party) === String(customer._id));
const preview = async () => (await get('/accounts/collections/auto-remind')).body;
/** A scheduled run on a day of its own (each claims its day once). */
let runDay = 0;
const runOn = () => { runDay += 1; return reminders.run({ now: new Date(`2026-12-${String(runDay).padStart(2, '0')}T11:05:00+05:30`) }); };

// ══════════════════════════════════════════════════════════════════
describe('a scheduled reminder the provider refused', () => {
  it('is tried again on the next run, not written off as "contacted this week"', async () => {
    const customer = await owing();
    await remindersOn();

    mockSend.mockResolvedValueOnce(refused);
    expect(await runOn()).toMatchObject({ sent: 0 });
    const kept = await M.CollectionNote.findOne({ customer: customer._id }).lean();
    expect(kept).toMatchObject({ kind: 'reminder', channel: 'whatsapp' });
    expect(kept.result).toMatch(/^error: The number/);

    // Before: left out, "contacted in the last 7 days".
    const next = await preview();
    expect(next.send.map((r) => String(r.party))).toEqual([String(customer._id)]);
    expect(next.skip).toEqual([]);

    // The next day's run sends it.
    expect(await runOn()).toMatchObject({ sent: 1 });
    // …and now they have been contacted (unchanged).
    const after = await preview();
    expect(after.send).toEqual([]);
    expect(after.skip[0].why).toMatch(/contacted in the last 7 days/);
  });

  it('does not show on the office list as a contact made', async () => {
    const customer = await owing();
    await remindersOn();
    mockSend.mockResolvedValueOnce(refused);
    await runOn();

    const r = await row(customer);
    // Before: recentlyContacted, "Last: reminder (whatsapp)".
    expect(r.recentlyContacted).toBe(false);
    expect(r.lastContact).toBeNull();
    expect(r.failedSend).toMatchObject({ to: `+91${customer.phoneNumber}` });
    expect(r.failedSend.result).toMatch(/not a valid WhatsApp number/);
    expect(r.failedSend.at).toBeTruthy();
  });

  it('leaves the contact that did reach them as the last one', async () => {
    const customer = await owing();
    await M.CollectionNote.collection.insertOne({ customer: customer._id, kind: 'call', channel: 'phone', note: 'Spoke to Ravi', byName: 'Owner', result: '', createdAt: new Date(Date.now() - 20 * DAY), updatedAt: new Date(Date.now() - 20 * DAY) });
    await remindersOn();
    mockSend.mockResolvedValueOnce(refused);
    await runOn();

    const r = await row(customer);
    expect(r.lastContact).toMatchObject({ kind: 'call', note: 'Spoke to Ravi' });
    expect(r.recentlyContacted).toBe(false);
    expect(r.failedSend.result).toMatch(/not a valid WhatsApp number/);
  });

  it('is forgotten once a reminder goes', async () => {
    const customer = await owing();
    await remindersOn();
    mockSend.mockResolvedValueOnce(refused);
    await runOn();
    await runOn();

    const r = await row(customer);
    expect(r.failedSend).toBeNull();
    expect(r.lastContact).toMatchObject({ kind: 'reminder', channel: 'whatsapp' });
    expect(r.recentlyContacted).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a reminder sent by hand that did not go', () => {
  it('is kept as one that failed, the same way a scheduled one is', async () => {
    const customer = await owing();
    mockSend.mockResolvedValueOnce(refused);

    const res = await post('/accounts/collections/send', { to: customer.phoneNumber, message: 'A gentle reminder: INV/2026-27/0001 is past due.', customer: String(customer._id), tone: 'gentle' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: false, error: refused.error });
    const kept = await M.CollectionNote.findOne({ customer: customer._id }).lean();
    // Before: the provider's sentence alone — nothing to tell it from a result that is not a failure.
    expect(kept.result).toBe(`error: ${refused.error}`);

    const r = await row(customer);
    expect(r.recentlyContacted).toBe(false);
    expect(r.failedSend.result).toMatch(/not a valid WhatsApp number/);
  });

  it('counts as contact when it goes, and when WhatsApp is not connected at all (unchanged)', async () => {
    const sent = await owing();
    const dry = await owing();
    await post('/accounts/collections/send', { to: sent.phoneNumber, message: 'A gentle reminder: your invoice is past due.', customer: String(sent._id) });
    mockSend.mockResolvedValueOnce({ sent: false, dryRun: true });
    await post('/accounts/collections/send', { to: dry.phoneNumber, message: 'A gentle reminder: your invoice is past due.', customer: String(dry._id) });

    expect(await row(sent)).toMatchObject({ recentlyContacted: true, failedSend: null });
    // Not connected: the office copies the message and sends it itself.
    expect(await row(dry)).toMatchObject({ recentlyContacted: true, failedSend: null });
  });
});

// ══════════════════════════════════════════════════════════════════
describe('a number kept with its trunk 0', () => {
  it('is the same phone, written to and heard from', async () => {
    expect(collections.e164('098410 55555')).toBe('+919841055555');
    expect(collections.e164('0 98410-55555')).toBe('+919841055555');
    // Unchanged.
    expect(collections.e164('98410 55555')).toBe('+919841055555');
    expect(collections.e164('+91 98410 55555')).toBe('+919841055555');
    expect(collections.e164('919841055555')).toBe('+919841055555');
    expect(collections.e164('+44 20 7946 0958')).toBe('+442079460958');
    expect(collections.e164('')).toBe('');
    expect(collections.e164(null)).toBe('');
  });

  it('gets its reminder', async () => {
    const customer = await owing({ phone: '098410 55555' });
    await remindersOn();
    expect(await runOn()).toMatchObject({ sent: 1 });
    // Before: "+09841055555".
    expect(mockSend).toHaveBeenCalledWith('+919841055555', expect.stringMatching(/Dear Ravi/));
    expect((await M.CollectionNote.findOne({ customer: customer._id }).lean()).to).toBe('+919841055555');
  });

  it('is recognised when the customer replies', async () => {
    const customer = await owing({ phone: '098410 66666' });
    const res = await incoming('+919841066666', 'Will pay Rs 50,000 by 15th');
    // Before: "not authorized" — a stranger.
    expect(res.text).not.toMatch(/not authorized/);
    const notes = await M.CollectionNote.find({ customer: customer._id }).lean();
    expect(notes.map((x) => x.kind).sort()).toEqual(['promise', 'reply']);
  });
});

// ══════════════════════════════════════════════════════════════════
describe('noting a contact by hand', () => {
  it('is against a customer on file', async () => {
    const res = await post('/accounts/collections/log', { customer: String(new mongoose.Types.ObjectId()), kind: 'call', note: 'Spoke to the accountant' });
    // Before: 201, and a note belonging to nobody.
    expect(res.status).toBe(404);
    expect(await M.CollectionNote.countDocuments({})).toBe(0);
  });

  it('refuses a promise of less than nothing', async () => {
    const customer = await owing();
    const when = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    for (const promiseAmount of [-500, 'lots']) {
      const res = await post('/accounts/collections/log', { customer: String(customer._id), kind: 'promise', promiseDate: when, promiseAmount });
      expect(res.status).toBe(400);
    }
    expect(await M.CollectionNote.countDocuments({})).toBe(0);
  });

  it('keeps a call, and a promise with or without an amount (unchanged)', async () => {
    const customer = await owing();
    const when = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
    expect((await post('/accounts/collections/log', { customer: String(customer._id), kind: 'call', note: 'Spoke to Ravi' })).status).toBe(201);
    expect((await post('/accounts/collections/log', { customer: String(customer._id), kind: 'promise', promiseDate: when, promiseAmount: 25000 })).status).toBe(201);
    expect((await post('/accounts/collections/log', { customer: String(customer._id), kind: 'promise', promiseDate: when })).status).toBe(201);
    const r = await row(customer);
    expect(r).toMatchObject({ held: true, recentlyContacted: true });
    expect(r.promise).toMatchObject({ live: true });
  });
});
