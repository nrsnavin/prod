'use strict';
// ══════════════════════════════════════════════════════════════════
//  A BALANCE CONFIRMATION ON WHATSAPP GOES TO A NUMBER ON FILE
//
//  Found reading services/confirmations.js line by line, beside
//  api/accountsCollections.js.
//
//  "The company's WhatsApp line speaks to the parties on file, not to
//  any number typed in" — the rule a payment reminder is held to. The
//  balance confirmation letter — a party's name, GSTIN and what they
//  owe — was sent to whatever number was typed. It is held to the same
//  rule now.
//
//  And two dates written off the server's own clock, a day early from
//  midnight to half past five in India: the date on the confirmation
//  letter, and the day a supplier's bank account "changed on" in the
//  payment run's warning.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockSend = jest.fn(async () => ({ sent: true, providerId: 'wa1' }));
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true, PROVIDER: 'twilio' }));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const post = (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie()).send(body);
const get = (url) => request(app).get(`/api/v2${url}`).set('Cookie', cookie());
const REAL = ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = {};
  for (const n of ['User', 'Customer', 'Supplier', 'BalanceConfirmation']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'conf@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  jest.useRealTimers();
  for (const c of Object.values(mongoose.connection.collections)) if (!['users'].includes(c.collectionName)) await c.deleteMany({});
  mockSend.mockClear();
});

let n = 0;
async function confirmation(over = {}) {
  n += 1;
  const customer = await M.Customer.create({ name: `Apex Garments ${n}`, contactName: 'R', phoneNumber: '93000 00111', gstin: `33AAEPC${String(n).padStart(4, '0')}F1Z2`, paymentTerms: '30', accountant: { name: 'Meena', mobile: '090000 22222' }, ...over });
  await require('../../services/partyLedger').post({ partyType: 'customer', party: customer._id, date: new Date('2026-10-05'), docType: 'Invoice', doc: new mongoose.Types.ObjectId(), docNo: `INV/${n}`, debit: 105000, narration: 'Sales' });
  const made = await post('/accounts/confirmations', { asOf: '2026-10-31', partyType: 'customer', parties: [String(customer._id)] });
  if (made.status !== 201 && made.status !== 200) throw new Error(`${made.status} ${made.body?.message}`);
  return { customer, c: made.body.made[0] };
}
const send = (c, to) => post(`/accounts/confirmations/${c._id}/send`, { channel: 'whatsapp', to });

describe('a balance confirmation sent on WhatsApp', () => {
  it('is refused for a number that is on no customer or supplier', async () => {
    const { c } = await confirmation();
    const res = await send(c, '99999 00000');
    // Before: sent, to whoever that is.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not on any customer or supplier on file/);
    expect(mockSend).not.toHaveBeenCalled();
    expect((await M.BalanceConfirmation.findById(c._id).lean()).status).toBe('draft');
  });

  it('goes to the party\'s own number, their accountant\'s, or a supplier\'s on file', async () => {
    await M.Supplier.create({ name: 'Sri Yarn Traders', gstin: '33AAAPS0001F1Z5', address: 'Erode', phoneNumber: '9444400000' });
    for (const [to, as] of [['9300000111', '+919300000111'], ['+91 90000 22222', '+919000022222'], ['094444 00000', '+919444400000']]) {
      const { c } = await confirmation();
      const res = await send(c, to);
      expect([to, res.status]).toEqual([to, 200]);
      expect(res.body.confirmation.sent).toMatchObject({ channel: 'whatsapp', to: as });
      expect(mockSend).toHaveBeenLastCalledWith(as, expect.stringContaining('Confirmation of balance as on 31-10-2026'));
    }
  });

  it('no number at all is still asked for; printing needs none (unchanged)', async () => {
    const { c } = await confirmation();
    expect((await send(c, '')).status).toBe(400);
    expect((await post(`/accounts/confirmations/${c._id}/send`, { channel: 'print' })).status).toBe(200);
  });
});

describe('dates written for a person', () => {
  it('the letter is dated the day it is in India, also before half past five in the morning', async () => {
    const { c } = await confirmation();
    // 00:30 on 21 November in India; 19:00 on the 20th by the server's clock.
    jest.useFakeTimers({ now: new Date('2026-11-20T19:00:00Z'), doNotFake: REAL });
    const letter = (await get(`/accounts/confirmations/${c._id}/letter`)).body;
    // Before: "Date: 20-11-2026".
    expect(letter.text).toMatch(/^Date: 21-11-2026$/m);
  });

  it('the payment run says a supplier\'s bank changed on the day it did, in India', () => {
    const { holdsFor } = require('../../services/paymentRun');
    jest.useFakeTimers({ now: new Date('2026-11-21T06:00:00Z'), doNotFake: REAL });
    // Changed at 02:00 on 20 November in India (20:30 on the 19th, UTC).
    const holds = holdsFor({ name: 'Sri Yarn Traders', isActive: true, bank: { accountNo: '50100123456789', ifsc: 'HDFC0000123', previousAccountNo: '50100999999999', changedAt: new Date('2026-11-19T20:30:00Z'), changedByName: 'Clerk' } }, new Map());
    // Before: "changed on 19 Nov".
    expect(holds).toEqual([expect.objectContaining({ code: 'BANK_CHANGED', message: expect.stringMatching(/changed on 20 Nov \(by Clerk\)/) })]);
  });
});
