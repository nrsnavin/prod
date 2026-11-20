'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE MONTH-END CHECKLIST, SENT BY A SCHEDULER
//
//  The route answered `sent: <the number of people it tried>`. A send
//  that did not go — WhatsApp not set up on this server, a number the
//  provider refused — was counted with the rest, so the scheduler's log
//  read "sent: 2" on a morning when nobody received anything.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.CRON_SECRET = 'cron-secret-for-this-test';

const mockSend = jest.fn();
jest.mock('../../utils/whatsapp', () => ({
  ...jest.requireActual('../../utils/whatsapp'),
  sendWhatsApp: (...a) => mockSend(...a),
}));

const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  const NotificationSettings = require('../../models/NotificationSettings');
  const s = await NotificationSettings.load();
  s.enabled = true;
  s.recipients = ['+919000000001', '+919000000002'];
  await s.save();
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

const fire = () => request(app).post('/api/v2/notify/cron/run-close-checklist').set('x-cron-secret', process.env.CRON_SECRET);

it('says how many were sent, not how many were tried', async () => {
  mockSend.mockReset();
  mockSend.mockResolvedValueOnce({ sent: false, error: 'provider refused the number' })
    .mockResolvedValueOnce({ sent: true, sid: 'SM1' });
  const res = await fire();
  expect(res.status).toBe(200);
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(res.body.sent).toBe(1);
  expect(res.body.tried).toBe(2);
  expect(res.body.notSent).toEqual([{ to: '+919000000001', reason: 'provider refused the number' }]);
});

it('says nothing went when WhatsApp is not set up', async () => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ sent: false, dryRun: true });
  const res = await fire();
  expect(res.status).toBe(200);
  expect(res.body.sent).toBe(0);
  expect(res.body.tried).toBe(2);
  expect(res.body.notSent).toHaveLength(2);
  expect(res.body.notSent[0].reason).toMatch(/not set up/i);
});

it('still refuses a wrong secret', async () => {
  const res = await request(app).post('/api/v2/notify/cron/run-close-checklist').set('x-cron-secret', 'nope');
  expect(res.status).toBe(401);
});
