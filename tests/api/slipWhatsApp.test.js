'use strict';
// ══════════════════════════════════════════════════════════════════
//  PRODUCTION SLIPS OVER WHATSAPP — through the real webhook
//
//  Twilio's POST, signed with the account token, from a phone that may
//  or may not belong to someone allowed to send slips.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.PUBLIC_BASE_URL = 'https://erp.example.com';
process.env.WEB_URL = 'https://web.example.com';

const mockRead = jest.fn();
jest.mock('../../utils/slipOcr', () => ({
  readSlip: (...a) => mockRead(...a),
  SUPPORTED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
}));
const mockSend = jest.fn().mockResolvedValue({ sent: true });
jest.mock('../../utils/whatsapp', () => ({
  sendWhatsApp: (...a) => mockSend(...a),
  isConfigured: () => true,
  PROVIDER: 'twilio',
}));

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, User, Employee, ShiftPlan, ShiftDetail, Machine, SlipIngest, SlipPhoto, NotificationSettings, svc;
let lead;
const { verifyTwilioSignature } = require('../../utils/whatsappInbound');

function sign(params) {
  const crypto = require('crypto');
  const url = 'https://erp.example.com/api/v2/notify/incoming';
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', 'tok').update(data, 'utf8').digest('base64');
}
const send = (params) => request(app).post('/api/v2/notify/incoming')
  .set('X-Twilio-Signature', sign(params)).type('form').send(params);
const replyOf = (res) => res.text.replace(/^.*<Message>|<\/Message>.*$/gs, '');

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  User = require('../../models/User');
  Employee = require('../../models/Employee');
  ShiftPlan = require('../../models/ShiftPlan');
  ShiftDetail = require('../../models/ShiftDetail');
  Machine = require('../../models/Machine');
  SlipIngest = require('../../models/SlipIngest');
  SlipPhoto = require('../../models/SlipPhoto');
  NotificationSettings = require('../../models/NotificationSettings');
  svc = require('../../services/slipIngest');

  const emp = await Employee.create({ name: 'Floor Lead', phoneNumber: '9100000001', department: 'weaving' });
  lead = await User.create({
    name: 'Floor Lead', email: 'lead@t.co', password: 'pass1234', role: 'production', department: 'production', employee: emp._id,
  });
  const worker = await Employee.create({ name: 'Weaver', phoneNumber: '9100000002', department: 'weaving' });
  await User.create({
    name: 'Weaver', email: 'weaver@t.co', password: 'pass1234', role: 'production', department: 'production',
    employee: worker._id, features: [],
  });

  const sp = await ShiftPlan.create({ date: new Date('2026-10-06'), shift: 'DAY' });
  const machine = await Machine.create({ ID: 'M-01', manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'running', elastics: [] });
  const op = await Employee.create({ name: 'Op', department: 'weaving' });
  const sd = await ShiftDetail.create({
    date: new Date('2026-10-06'), shift: 'DAY', timer: '00:00:00', elastics: [],
    employee: op._id, shiftPlan: sp._id, machine: machine._id, status: 'open',
  });
  await ShiftPlan.updateOne({ _id: sp._id }, { $set: { plan: [sd._id] } });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

it('the signature helper agrees with the test signer', () => {
  const params = { From: 'whatsapp:+919100000001', Body: 'x' };
  expect(verifyTwilioSignature({
    url: 'https://erp.example.com/api/v2/notify/incoming', body: params, signature: sign(params), authToken: 'tok',
  })).toBe(true);
});

it('a photo from a production login is taken, and read in the background', async () => {
  const params = {
    From: 'whatsapp:+919100000001', Body: 'DAY 06-10-2026', NumMedia: '1', MessageSid: 'SM-A',
    MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/SM-A/Media/ME1', MediaContentType0: 'image/jpeg',
  };
  const res = await send(params);
  expect(res.status).toBe(200);
  const slip = await SlipIngest.findOne({ messageSid: 'SM-A' }).lean();
  expect(replyOf(res)).toBe(`Got it, reading slip ${slip.confirmCode}. I&apos;ll reply with what I read in a minute or two.`);
  expect(String(slip.sentBy)).toBe(String(lead._id));

  // Twilio retries: still one slip.
  await send(params);
  expect(await SlipIngest.countDocuments({ messageSid: 'SM-A' })).toBe(1);
});

it('a worker login, or a stranger, cannot send slips', async () => {
  for (const from of ['whatsapp:+919100000002', 'whatsapp:+919999999999']) {
    const params = { From: from, Body: '', NumMedia: '1', MessageSid: `SM-${from.slice(-4)}`, MediaUrl0: 'https://api.twilio.com/m', MediaContentType0: 'image/jpeg' };
    const res = await send(params);
    expect(replyOf(res)).toMatch(/not set up to send production slips/);
  }
  expect(await SlipIngest.countDocuments({ messageSid: { $in: ['SM-0002', 'SM-9999'] } })).toBe(0);
});

it('a bad signature is refused before anything happens', async () => {
  const res = await request(app).post('/api/v2/notify/incoming')
    .set('X-Twilio-Signature', 'forged').type('form')
    .send({ From: 'whatsapp:+919100000001', NumMedia: '1', MessageSid: 'SM-F', MediaUrl0: 'https://api.twilio.com/m' });
  expect(res.status).toBe(403);
  expect(await SlipIngest.exists({ messageSid: 'SM-F' })).toBeNull();
});

it('OK saves the clear rows; NO drops a slip', async () => {
  const slip = await SlipIngest.findOne({ messageSid: 'SM-A' });
  await SlipPhoto.create({ slip: slip._id, page: 0, contentType: 'image/jpeg', size: 4, data: 'AAAA' });
  await SlipIngest.updateOne({ _id: slip._id }, { $set: { media: [] } });
  mockRead.mockResolvedValueOnce({
    format: 'slip', planNo: null, date: null, shift: null, problem: null, model: 'm', usage: {}, latencyMs: 1,
    rows: [{ code: null, machine: 'M1', operator: null, production: 1300, timer: '8:00:00', remarks: '', confidence: 0.95 }],
  });
  await svc.readSlipJob(slip._id);
  expect(mockSend.mock.calls.at(-1)[1]).toMatch(/1 ready, 0 to check/);

  const ok = await send({ From: 'whatsapp:+919100000001', Body: `ok ${slip.confirmCode}`, NumMedia: '0', MessageSid: 'SM-OK' });
  expect(replyOf(ok)).toMatch(/Saved 1 loom from slip \d{4} as submitted/);
  const sd = await ShiftDetail.findOne({}).lean();
  expect(sd).toMatchObject({ status: 'pending_verification', submittedProductionMeters: 1300 });
  expect(String(sd.submittedBy)).toBe(String(lead._id));

  const again = await send({ From: 'whatsapp:+919100000001', Body: `OK ${slip.confirmCode}`, NumMedia: '0', MessageSid: 'SM-OK2' });
  expect(replyOf(again)).toMatch(/no open slip numbered/);

  const other = await svc.receiveUpload({ files: [{ buffer: Buffer.from('x'), mimetype: 'image/jpeg' }], user: lead });
  const no = await send({ From: 'whatsapp:+919100000001', Body: `NO ${other.confirmCode}`, NumMedia: '0', MessageSid: 'SM-NO' });
  expect(replyOf(no)).toMatch(/dropped/);
  expect((await SlipIngest.findById(other._id).lean()).status).toBe('discarded');
});

it('order approval replies still work as before', async () => {
  const s = await NotificationSettings.load();
  s.recipients = ['+919800000000'];
  await s.save();
  const res = await send({ From: 'whatsapp:+919800000000', Body: 'APPROVE 999999', NumMedia: '0', MessageSid: 'SM-AP' });
  expect(replyOf(res)).toMatch(/Order #999999 not found/);
});
