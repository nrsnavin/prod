'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE DAILY REPORTS, ON THE SERVER'S OWN CLOCK
//
//  They only ever ran when an outside crontab called the cron route, and
//  nothing set one up. Now the server sends them — once a day, however
//  many processes run, and never twice if an old crontab still fires.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, svc, ScheduledRun, app;
const at = (iso) => new Date(iso);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  svc = require('../../services/scheduledReports');
  ScheduledRun = require('../../models/ScheduledRun');
  await ScheduledRun.init();
  app = require('../../app.js');
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let digest, evening;
beforeEach(async () => {
  await ScheduledRun.deleteMany({});
  digest = jest.fn().mockResolvedValue({ sent: true });
  evening = jest.fn().mockResolvedValue({ sent: true });
  svc.JOBS.morningDigest.run = digest;
  svc.JOBS.eveningReport.run = evening;
  svc.JOBS.auditWatch.run = jest.fn().mockResolvedValue({ sent: true });
  delete process.env.DIGEST_AT; delete process.env.EVENING_REPORT_AT;
  delete process.env.CRON_SECRET;
});

describe('the morning digest', () => {
  it('goes at nine in India, once', async () => {
    // 09:05 IST = 03:35 UTC
    await svc.tick(at('2026-11-09T03:35:00Z'));
    await svc.tick(at('2026-11-09T03:40:00Z'));
    expect(digest).toHaveBeenCalledTimes(1);
    expect(evening).not.toHaveBeenCalled();
  });

  it('does not go before its time', async () => {
    await svc.tick(at('2026-11-09T03:25:00Z')); // 08:55 IST
    expect(digest).not.toHaveBeenCalled();
  });

  it('still goes after a late restart, but not a stale one at teatime', async () => {
    await svc.tick(at('2026-11-09T05:00:00Z')); // 10:30 IST — within three hours
    expect(digest).toHaveBeenCalledTimes(1);
    await ScheduledRun.deleteMany({});
    await svc.tick(at('2026-11-09T10:00:00Z')); // 15:30 IST
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('goes again the next day', async () => {
    await svc.tick(at('2026-11-09T03:35:00Z'));
    await svc.tick(at('2026-11-10T03:35:00Z'));
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it('follows DIGEST_AT', async () => {
    process.env.DIGEST_AT = '07:30';
    await svc.tick(at('2026-11-09T02:05:00Z')); // 07:35 IST
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('records a failure so the settings page can say so', async () => {
    digest.mockRejectedValueOnce(new Error('provider down'));
    const out = await svc.tick(at('2026-11-09T03:35:00Z'));
    expect(out.morningDigest.why).toBe('failed');
    const st = await svc.status();
    expect(st.morningDigest.last).toMatchObject({ ok: false, error: 'provider down', day: '2026-11-09' });
  });
});

describe('the weekly audit summary', () => {
  it('goes on Monday mornings only', async () => {
    await svc.tick(at('2026-11-09T04:05:00Z')); // Monday 09:35 IST
    await svc.tick(at('2026-11-10T04:05:00Z')); // Tuesday
    expect(svc.JOBS.auditWatch.run).toHaveBeenCalledTimes(1);
  });
});

describe('the evening report', () => {
  it('goes at nine at night in India', async () => {
    await svc.tick(at('2026-11-09T15:35:00Z')); // 21:05 IST
    expect(evening).toHaveBeenCalledTimes(1);
  });
});

describe('an old crontab still calling the cron route', () => {
  it('does not send what the timer already sent', async () => {
    process.env.CRON_SECRET = 'shh';
    await svc.runOnce('morningDigest');
    const res = await request(app).post('/api/v2/notify/cron/run-digest').set('x-cron-secret', 'shh');
    expect(res.status).toBe(200);
    expect(res.body.ran).toBe(false);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('sends it when the timer has not', async () => {
    process.env.CRON_SECRET = 'shh';
    const res = await request(app).post('/api/v2/notify/cron/run-evening-report').set('x-cron-secret', 'shh');
    expect(res.body.ran).toBe(true);
    expect(evening).toHaveBeenCalledTimes(1);
  });
});
