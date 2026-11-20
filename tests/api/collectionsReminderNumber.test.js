'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHOSE PHONE A PAYMENT REMINDER GOES TO
//
//  Found reading api/accountsCollections.js and
//  services/collectionReminders.js line by line.
//
//  A customer's record has the customer's own number and, where they
//  gave one, their accountant's. Everything about money goes to the
//  accountant's first: the reminder the office drafts by hand, a
//  receipt or note shared on WhatsApp, the statement, a balance
//  confirmation.
//
//  The reminder sent on a schedule was the one exception — the
//  customer's own number first. So the same customer was reminded at
//  one number by the office and at another by the timer, and nothing on
//  the screen said which number the timer would use.
//
//  And "first" was the first one written down, not the first one that
//  is a number: an accountant's mobile kept as "NA" gave the office's
//  draft no number at all, with the customer's own sitting beside it.
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
const DAY = 86_400_000;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  reminders = require('../../services/collectionReminders');
  collections = require('../../services/collections');
  M = {};
  for (const n of ['User', 'Customer', 'Invoice', 'CollectionNote', 'AccountsSettings']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'crn@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters', 'documentsettings'].includes(c.collectionName)) await c.deleteMany({});
  mockSend.mockClear();
});

let n = 0;
async function owing({ phone = '9841012345', accountant } = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Kaveri Knits ${n}`, contactName: 'Ravi', phoneNumber: phone, paymentTerms: '30', ...(accountant ? { accountant } : {}) });
  const due = new Date(Date.now() - 10 * DAY);
  await M.Invoice.create({
    invoiceNumber: `INV/2026-27/${String(n).padStart(4, '0')}`, financialYear: '2026-27', sequence: n, invoiceDate: new Date(due.getTime() - 30 * DAY), dueDate: due,
    order: new mongoose.Types.ObjectId(), orderNo: n, customer: customer._id, seller: { name: 'Balu', gstin: '33AAECB1234F1Z5', stateCode: '33' }, buyer: { name: customer.name, stateCode: '33' },
    supplyType: 'intra', placeOfSupply: '33', lines: [], totals: { taxable: 50000, grand: 52500 }, status: 'issued',
  });
  return customer;
}
const remindersOn = () => put('/accounts/settings', { collections: { autoRemind: { enabled: true, hour: 11, everyDays: 7, minOverdueDays: 3 } } });
const preview = async () => (await get('/accounts/collections/auto-remind')).body;
const draftTo = async (customer) => (await post('/accounts/collections/draft', { customer: String(customer._id) })).body.to;
let runDay = 0;
const runOn = () => { runDay += 1; return reminders.run({ now: new Date(`2027-01-${String(runDay).padStart(2, '0')}T11:05:00+05:30`) }); };

describe('a payment reminder goes to the accountant when the customer gave one', () => {
  it('the scheduled reminder, as the office\'s own does', async () => {
    const customer = await owing({ accountant: { name: 'Meena', mobile: '90000 11111' } });
    await remindersOn();

    // The office's draft: the accountant (unchanged).
    expect(await draftTo(customer)).toBe('+919000011111');

    // Before: the timer's list and its send both used +919841012345.
    const list = await preview();
    expect(list.send).toEqual([expect.objectContaining({ party: String(customer._id), phone: '+919000011111' })]);

    const out = await runOn();
    expect(out).toMatchObject({ sent: 1 });
    expect(out.reminders[0].to).toBe('+919000011111');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBe('+919000011111');
    expect(await M.CollectionNote.findOne({ customer: customer._id }).lean()).toMatchObject({ kind: 'reminder', to: '+919000011111', result: 'sent' });
  });

  it('the customer\'s own number when there is no accountant (unchanged)', async () => {
    const customer = await owing();
    await remindersOn();
    expect(await draftTo(customer)).toBe('+919841012345');
    expect((await preview()).send[0].phone).toBe('+919841012345');
    expect((await runOn()).reminders[0].to).toBe('+919841012345');
  });
});

describe('an accountant\'s "number" that is not one', () => {
  it('falls back to the customer\'s own, for the office\'s draft and the timer alike', async () => {
    const customer = await owing({ accountant: { name: 'Meena', mobile: 'NA' } });
    await remindersOn();
    // Before: the draft came back with no number at all.
    expect(await draftTo(customer)).toBe('+919841012345');
    expect((await preview()).send[0].phone).toBe('+919841012345');
    expect((await runOn()).reminders[0].to).toBe('+919841012345');
  });

  it('with no usable number anywhere the timer leaves them to a person (unchanged)', async () => {
    const customer = await owing({ phone: '-', accountant: { name: 'Meena', mobile: 'NA' } });
    await remindersOn();
    const list = await preview();
    expect(list.send).toEqual([]);
    expect(list.skip).toEqual([expect.objectContaining({ party: String(customer._id), why: 'no phone on file' })]);
    expect(await runOn()).toMatchObject({ sent: 0 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  // The promise's date goes through the accounts date reader, as every
  // document date does (tests/utils/realDays.test.js has the readers).
  it('a promise for a day that does not exist is refused, not kept for another day', async () => {
    const customer = await owing();
    // Before: 201, and a promise for the 2nd of March.
    const res = await post('/accounts/collections/log', { customer: String(customer._id), kind: 'promise', promiseDate: '2027-02-30', promiseAmount: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('promiseDate is not a date');
    expect(await M.CollectionNote.countDocuments({ customer: customer._id })).toBe(0);
    expect((await post('/accounts/collections/log', { customer: String(customer._id), kind: 'promise', promiseDate: '2027-02-28', promiseAmount: 1000 })).status).toBe(201);
  });

  it('one rule, in one place', () => {
    expect(collections.reminderPhone({ phone: '9841012345', accountantPhone: '090000 11111' })).toBe('+919000011111');
    expect(collections.reminderPhone({ phone: '9841012345', accountantPhone: '' })).toBe('+919841012345');
    expect(collections.reminderPhone({ phone: '9841012345', accountantPhone: 'ask Ravi' })).toBe('+919841012345');
    expect(collections.reminderPhone({ phone: '', accountantPhone: '' })).toBe('');
    expect(collections.reminderPhone(undefined)).toBe('');
  });
});
