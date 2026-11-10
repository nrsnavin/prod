'use strict';
// ══════════════════════════════════════════════════════════════════
//  ALERTS ABOUT THINGS THAT ARE NOT RECORDS
//
//  The alert log files each alert under an entity id — an ObjectId — and
//  throttles on it. The alerts about a day, a shift, or the alert system
//  itself name their subject with a string ("2026-11-09:DAY",
//  "delivery"). The throttle lookup threw a cast error on that string
//  before anything was sent, and notify() never throws, so nothing said
//  so: every throttled alert of that kind had never once gone out.
//
//  The checks that raise these alerts are tested with notify() mocked
//  (tests/utils/systemHealth.test.js), which is how it stayed hidden.
//  Here the REAL notify() runs, with only the provider replaced.
// ══════════════════════════════════════════════════════════════════

jest.mock('../../utils/whatsapp.js', () => ({
  sendWhatsApp: jest.fn().mockResolvedValue({ sent: true, providerId: 'SM1' }),
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongo, Notification, NotificationSettings, notify, send;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  Notification = require('../../models/Notification.js');
  NotificationSettings = require('../../models/NotificationSettings.js');
  ({ notify } = require('../../utils/notify.js'));
  send = require('../../utils/whatsapp.js').sendWhatsApp;
}, 60_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  send.mockClear();
  const s = await NotificationSettings.load();
  s.enabled = true;
  s.recipients = ['+919000000001'];
  await s.save();
});

// Every alert that names its subject with something other than a record,
// with the shape of name it uses (utils/systemHealth.js,
// utils/dailyAnomalyAlerts.js, utils/attendanceAlerts.js).
const NAMED = [
  ['notificationDeliveryFailed', { type: 'NotificationHealth', id: 'delivery' }, { errorCount: 5, totalAttempts: 9 }],
  ['notifyDryRunStillActive', { type: 'NotificationHealth', id: 'dryRun' }, { dryRunCount: 9 }],
  ['cronDigestSkipped', { type: 'NotificationHealth', id: 'cron' }, {}],
  ['configAtRisk', { type: 'SystemHealth', id: 'config' }, { risks: ['JWT_SECRET_KEY is a value that is public.'] }],
  ['projectedStockoutAlert', { type: 'ProjectedStockout', id: 'Nylon 70D,Rubber 40s' }, { items: [{ name: 'Nylon 70D', daysLeft: 3 }] }],
  ['wastageAnomalyDay', { type: 'WastageDay', id: '2026-11-08' }, { dateLabel: '8 Nov', totalKg: 40 }],
  ['mlPosteriorStale', { type: 'MlHealth', id: 'posterior' }, { hoursStale: 80 }],
  ['attendanceCrashedToday', { type: 'AttendanceShift', id: '2026-11-09:DAY' }, { present: 4, expected: 20 }],
];

describe('an alert named by a string', () => {
  it.each(NAMED)('%s is sent, and logged under its name', async (event, entity, payload) => {
    const out = await notify(event, { ...payload, _entity: entity });
    expect(out.error).toBeUndefined();
    expect(out.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);

    const row = await Notification.findOne({ event, status: 'sent' }).lean();
    expect(row).toBeTruthy();
    expect(row.entity.type).toBe(entity.type);
    expect(row.entity.key).toBe(entity.id);
    expect(row.entity.id).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  it('is throttled the second time, and not the first time for a different name', async () => {
    const day = (id) => notify('attendanceCrashedToday', { present: 4, expected: 20, _entity: { type: 'AttendanceShift', id } });
    expect((await day('2026-11-09:DAY')).sent).toBe(1);
    expect((await day('2026-11-09:DAY')).skipped).toBe('throttled');
    expect((await day('2026-11-09:NIGHT')).sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('the same name under another type is a different subject', async () => {
    const stale = (type) => notify('mlPosteriorStale', { hoursStale: 80, _entity: { type, id: 'posterior' } });
    expect((await stale('MlHealth')).sent).toBe(1);
    expect((await stale('SomethingElse')).sent).toBe(1);
  });
});

describe('CONTROL: an alert about a record', () => {
  it('is filed under the record\'s own id, given as an id or as its text', async () => {
    const id = new mongoose.Types.ObjectId();
    await notify('criticalStockout', { name: 'Nylon', _entity: { type: 'RawMaterial', id: String(id) } });
    const row = await Notification.findOne({ event: 'criticalStockout', status: 'sent' }).lean();
    expect(String(row.entity.id)).toBe(String(id));
    expect(row.entity.key).toBeUndefined();
    // …and the throttle sees the id and its text as the same subject.
    expect((await notify('criticalStockout', { name: 'Nylon', _entity: { type: 'RawMaterial', id } })).skipped).toBe('throttled');
  });

  it('an alert with no subject at all still goes', async () => {
    expect((await notify('cronDigestSkipped', {})).sent).toBe(1);
  });
});
