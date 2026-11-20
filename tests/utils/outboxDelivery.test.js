'use strict';
// ══════════════════════════════════════════════════════════════════
//  A QUEUED ALERT THAT REACHED NOBODY IS TRIED AGAIN
//
//  Alerts are queued (utils/outbox.js) so that one is not lost when the
//  server stops mid-send: the dispatcher retries a handler that throws.
//  But notify() never throws — it SAYS what happened — and the handlers
//  did not listen. WhatsApp down for a minute, and the high-wastage or
//  late-despatch alert was marked "sent" having reached no one.
//
//    • nothing delivered, provider error → the event is retried
//    • delivered to at least one person → sent (never a second copy)
//    • muted, no recipients, provider not set up → sent: nothing to retry
//
//  Found reading utils/outbox.js and outboxHandlers.js line by line.
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const mockSend = jest.fn();
jest.mock('../../utils/whatsapp.js', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true }));

let mongo, Outbox, Settings, enqueue, processDueEvents;
const HOUR = 3_600_000;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  Outbox = require('../../models/Outbox.js');
  Settings = require('../../models/NotificationSettings.js');
  ({ enqueue, processDueEvents } = require('../../utils/outbox.js'));
  const s = await Settings.load();
  s.enabled = true;
  s.recipients = ['+919000000001', '+919000000002'];
  await s.save();
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { mockSend.mockReset(); await Outbox.deleteMany({}); });

const queue = () => enqueue(null, 'notify', { event: 'test', payload: { body: 'Loom 4: wastage 14% today' } });

describe('a queued alert', () => {
  it('is tried again when it reached nobody, and goes once the provider is back', async () => {
    mockSend.mockResolvedValue({ sent: false, error: 'provider down' });
    const event = await queue();
    expect(await processDueEvents()).toMatchObject({ sent: 0, retried: 1 });
    expect(await Outbox.findById(event._id).lean()).toMatchObject({ status: 'pending', lastError: expect.stringMatching(/provider down/) });

    mockSend.mockResolvedValue({ sent: true, providerId: 'SM1' });
    expect(await processDueEvents(new Date(Date.now() + HOUR))).toMatchObject({ sent: 1 });
    expect((await Outbox.findById(event._id).lean()).status).toBe('sent');
  });

  it('is not sent a second time when it reached one of two people', async () => {
    mockSend.mockResolvedValueOnce({ sent: true, providerId: 'SM2' }).mockResolvedValueOnce({ sent: false, error: 'bad number' });
    const event = await queue();
    expect(await processDueEvents()).toMatchObject({ sent: 1, retried: 0 });
    expect((await Outbox.findById(event._id).lean()).status).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('is done with when there was nothing to try again: not set up, or switched off', async () => {
    mockSend.mockResolvedValue({ sent: false, dryRun: true });
    await queue();
    expect(await processDueEvents()).toMatchObject({ sent: 1, retried: 0 });
    await Settings.updateOne({}, { $set: { enabled: false } });
    try {
      await queue();
      expect(await processDueEvents()).toMatchObject({ sent: 1, retried: 0 });
    } finally {
      await Settings.updateOne({}, { $set: { enabled: true } });
    }
  });

  it('the checks that send an alert of their own are tried again too', async () => {
    // A challan sent four days after the order's promised day.
    const order = (await mongoose.connection.collection('orders').insertOne({ orderNo: 77, supplyDate: new Date('2026-11-10T00:00:00Z') })).insertedId;
    const dc = (await mongoose.connection.collection('deliverychallans').insertOne({ dcNumber: 'E-77', dispatchDate: new Date('2026-11-14T06:00:00Z'), customerName: 'Aravind' })).insertedId;
    mockSend.mockResolvedValue({ sent: false, error: 'provider down' });
    const event = await enqueue(null, 'dc.delayedDeliveryCheck', { dcId: String(dc), orderId: String(order) });
    expect(await processDueEvents()).toMatchObject({ sent: 0, retried: 1 });
    mockSend.mockResolvedValue({ sent: true, providerId: 'SM3' });
    expect(await processDueEvents(new Date(Date.now() + HOUR))).toMatchObject({ sent: 1 });
    expect((await Outbox.findById(event._id).lean()).status).toBe('sent');
    expect(mockSend.mock.calls.at(-1)[1]).toMatch(/late vs promise/);
  });
});
