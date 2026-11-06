'use strict';
// ══════════════════════════════════════════════════════════════════
//  CUSTOMERS' WHATSAPP REPLIES, AND REMINDERS ON A SCHEDULE
//    services/collectionReply.js, services/collectionReminders.js
//
//    • a reply from a customer's number is kept; a promise with a day is
//      recorded as one (the list holds them till then); the office told;
//      an acknowledgement only when that is on
//    • a stranger's message is refused as before
//    • the day's reminders go to whoever is due one — not a promise, not
//      one contacted this week, not one for a call — once a day
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
delete process.env.TWILIO_AUTH_TOKEN;

const mockSend = jest.fn(async () => ({ sent: true, providerId: 'wa1' }));
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true, PROVIDER: 'twilio' }));
jest.mock('../../utils/anthropicClient', () => ({ anthropic: () => null, TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, reply, reminders;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const put = (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const incoming = (from, Body) => request(app).post('/api/v2/notify/incoming').type('form').send({ From: `whatsapp:${from}`, Body });
const OFFICE = '+919800000000';

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  reply = require('../../services/collectionReply');
  reminders = require('../../services/collectionReminders');
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'CollectionNote', 'NotificationSettings', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'cr@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await M.NotificationSettings.create({ recipients: [OFFICE] }); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  mockSend.mockClear();
});

let n = 0;
async function owing({ phone, daysPast = 10, grand = 52500 } = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Sunrise ${n}`, contactName: 'Ravi', phoneNumber: phone || `98400${String(10000 + n)}`, paymentTerms: '30' });
  const due = new Date(Date.now() - daysPast * 86_400_000);
  const inv = await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(due.getTime() - 30 * 86_400_000), dueDate: due,
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu', gstin: '33AAECB1234F1Z5', stateCode: '33' }, buyer: { name: customer.name, stateCode: '33' },
    supplyType: 'intra', placeOfSupply: '33', lines: [], totals: { taxable: grand / 1.05, grand }, status: 'issued',
  });
  return { customer, inv };
}

describe('reading a reply', () => {
  const today = new Date(2026, 10, 5); // Thu 5 Nov 2026
  it.each([
    ['Will pay Rs 50,000 on 15th', { kind: 'promise', date: '2026-11-15', amount: 50000 }],
    ['payment by monday sir', { kind: 'promise', date: '2026-11-09' }],
    ['will transfer 1.5 lakh tomorrow', { kind: 'promise', date: '2026-11-06', amount: 150000 }],
    ['Paid yesterday UTR HDFC000123456789', { kind: 'paid', reference: 'HDFC000123456789' }],
    ['rate on invoice 702 is wrong', { kind: 'dispute' }],
    ['pls send statement', { kind: 'statement' }],
    ['ok', { kind: 'other' }],
  ])('%s', (text, want) => {
    expect(reply.keywordRead(text, today)).toMatchObject(want);
  });
  it('a date like 3/11 that has gone is next year\'s, and a day of the month gone is next month\'s', () => {
    expect(reply.dateIn('on 3/11', today).getFullYear()).toBe(2027);
    expect(reply.dateIn('by 2nd', today).getMonth()).toBe(11);
  });
});

describe('a reply on WhatsApp', () => {
  it('from a customer: kept, a promise recorded, the office told; no acknowledgement unless it is on', async () => {
    const { customer } = await owing({ phone: '98400 11111' });
    const res = await incoming('+919840011111', 'Will pay Rs 50,000 by 15th');
    expect(res.status).toBe(200);
    expect(res.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    const notes = await M.CollectionNote.find({ customer: customer._id }).sort({ createdAt: 1 }).lean();
    expect(notes.map((x) => x.kind)).toEqual(['reply', 'promise']);
    expect(notes[0]).toMatchObject({ channel: 'whatsapp', message: 'Will pay Rs 50,000 by 15th', byName: 'WhatsApp (customer)' });
    expect(notes[1]).toMatchObject({ promiseAmount: 50000 });
    expect(new Date(notes[1].promiseDate).getDate()).toBe(15);
    expect(mockSend).toHaveBeenCalledWith(OFFICE, expect.stringMatching(new RegExp(`${customer.name}\\* promises to pay ₹50,000 by 15`)), expect.anything());
    // The promise holds them off the list.
    expect((await get('/accounts/collections')).body.rows.map((r) => String(r.party))).not.toContain(String(customer._id));

    await put('/accounts/settings', { collections: { acknowledgeReplies: true } });
    const paid = await incoming('+919840011111', 'Paid today, UTR HDFC000123456789');
    expect(paid.text).toMatch(/<Message>Thank you — we will match it with our bank and confirm\.<\/Message>/);
    expect(mockSend).toHaveBeenLastCalledWith(OFFICE, expect.stringMatching(/says it is paid \(ref HDFC000123456789\)/), expect.anything());
  });

  it('from a stranger: refused, as before', async () => {
    const res = await incoming('+919999999999', 'hello');
    expect(res.text).toMatch(/not authorized/);
    expect(await M.CollectionNote.countDocuments({})).toBe(0);
  });
});

describe('reminders on a schedule', () => {
  it('go once a day at the hour to whoever is due one, and say why the rest are left', async () => {
    const due = await owing({ daysPast: 10 });
    const promised = await owing({ daysPast: 10 });
    const recent = await owing({ daysPast: 10 });
    const forCall = await owing({ daysPast: 60 });
    const fresh = await owing({ daysPast: 1 });
    await M.CollectionNote.create({ customer: promised.customer._id, kind: 'promise', promiseDate: new Date(Date.now() + 5 * 86_400_000), promiseAmount: 1000 });
    await M.CollectionNote.create({ customer: recent.customer._id, kind: 'call', note: 'spoke to Ravi' });

    expect(await reminders.run({ force: true })).toMatchObject({ sent: 0, why: 'off' });
    expect((await put('/accounts/settings', { collections: { autoRemind: { enabled: true, hour: 11, everyDays: 7, minOverdueDays: 3 } } })).status).toBe(200);

    const preview = (await get('/accounts/collections/auto-remind')).body;
    expect(preview.send.map((r) => String(r.party))).toEqual([String(due.customer._id)]);
    const why = Object.fromEntries(preview.skip.map((s) => [String(s.party), s.why]));
    expect(why[String(promised.customer._id)]).toMatch(/promised to pay by/);
    expect(why[String(recent.customer._id)]).toMatch(/contacted in the last 7 days/);
    expect(why[String(forCall.customer._id)]).toMatch(/call them — for a person/);
    expect(why[String(fresh.customer._id)]).toMatch(/only 1 days past due/);

    const at10 = new Date('2026-11-05T10:00:00+05:30');
    expect(await reminders.run({ now: at10 })).toMatchObject({ sent: 0, why: 'not yet' });
    const at11 = new Date('2026-11-05T11:05:00+05:30');
    const out = await reminders.run({ now: at11 });
    expect(out).toMatchObject({ sent: 1, dateKey: '2026-11-05' });
    expect(mockSend).toHaveBeenCalledWith(`+91${due.customer.phoneNumber}`, expect.stringMatching(/Dear Ravi,[\s\S]*INV\/2026-27/));
    const note = await M.CollectionNote.findOne({ customer: due.customer._id, kind: 'reminder' }).lean();
    expect(note).toMatchObject({ channel: 'whatsapp', result: 'sent', byName: 'Scheduled reminder', tone: 'gentle' });
    // Once a day, however often asked.
    expect(await reminders.run({ now: new Date('2026-11-05T15:00:00+05:30') })).toMatchObject({ sent: 0, why: 'sent today already' });
    // The route runs on the real clock: claim the real today first.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.FACTORY_TZ || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    await M.AccountsSettings.updateOne({ key: 'accounts' }, { $set: { 'collections.autoRemind.lastRunDate': today } });
    expect((await request(app).post('/api/v2/accounts/collections/auto-remind/run').set('Cookie', cookie())).body).toMatchObject({ why: 'sent today already' });
  });
});
