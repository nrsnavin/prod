'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE NOTICES REGISTER, ONCE IT IS LONG
//
//  Found reading api/accountsNotices.js line by line.
//
//  The register was one query: sorted by status, cut at 200 rows, and
//  the counts ("3 open, 1 overdue") added up from what was listed. Sorted
//  by status, "closed" comes before "open". With two hundred notices
//  closed over the years, the list was two hundred closed notices — and
//  the open one with a reply due on Friday was not on it, under a count
//  that said nothing was open.
//
//  A notice's deadline is the most expensive date in the books to miss.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, Notice, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const list = (q = '') => request(app).get(`/api/v2/accounts/notices${q}`).set('Cookie', cookie());
const DAY = 86_400_000;
/** Noon in India on the day `n` days from today — how a notice's dates are kept. */
const noon = (n) => new Date(`${new Date(Date.now() + n * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}T12:00:00+05:30`);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  Notice = require('../../models/StatutoryNotice.js');
  admin = await require('../../models/User.js').create({ name: 'Owner', email: 'nrf@t.co', password: 'pass1234', role: 'admin', department: 'admin' });

  const at = new Date();
  const row = (over) => ({ authority: 'gst', form: 'DRC-01', documents: [], reminded: [], attachments: [], createdAt: at, updatedAt: at, ...over });
  await Notice.collection.insertMany([
    // Years of notices, answered and closed: 205 of them.
    ...Array.from({ length: 205 }, (_, i) => row({ reference: `CLOSED-${String(i + 1).padStart(3, '0')}`, status: 'closed', replyBy: noon(-400 + i) })),
    row({ reference: 'REPLIED-1', status: 'replied', replyBy: noon(-10), replyRef: 'ARN 1' }),
    row({ reference: 'REPLIED-2', status: 'replied', replyBy: noon(-5), replyRef: 'ARN 2' }),
    // What is waiting now.
    row({ reference: 'OPEN-NO-DATE', status: 'open' }),
    row({ reference: 'OPEN-IN-2', status: 'open', replyBy: noon(2) }),
    row({ reference: 'OPEN-LATE', status: 'open', replyBy: noon(-2) }),
  ]);
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('the notices register with years of closed notices in it', () => {
  it('still lists what is open, first, soonest deadline first', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    // Before: two hundred closed notices, and none of these.
    expect(res.body.data.slice(0, 3).map((n) => n.reference)).toEqual(['OPEN-LATE', 'OPEN-IN-2', 'OPEN-NO-DATE']);
    expect(res.body.data[0]).toMatchObject({ daysLeft: -2, urgency: 'overdue' });
    expect(res.body.data[1]).toMatchObject({ daysLeft: 2, urgency: 'urgent' });
  });

  it('counts what is open, however long the register is', async () => {
    const res = await list();
    // Before: { open: 0, overdue: 0, dueThisWeek: 0 }.
    expect(res.body.counts).toEqual({ open: 3, overdue: 1, dueThisWeek: 1 });
  });

  it('keeps the newest of the answered and closed ones when they do not all fit', async () => {
    const refs = (await list()).body.data.map((n) => n.reference);
    expect(refs).toHaveLength(203);                       // the 3 open, and 200 of the other 207
    expect(refs).toContain('REPLIED-1');
    expect(refs).toContain('REPLIED-2');
    expect(refs).toContain('CLOSED-205');                 // the latest
    // Before: the oldest two hundred — the latest ones were what fell off.
    expect(refs).not.toContain('CLOSED-001');
  });

  it('says what is open beside a list of closed ones too', async () => {
    const res = await list('?status=closed');
    expect(res.body.data).toHaveLength(200);
    expect(res.body.data.every((n) => n.status === 'closed')).toBe(true);
    expect(res.body.data[0].reference).toBe('CLOSED-205');
    // Before: all zero — the counts were of the rows listed.
    expect(res.body.counts).toEqual({ open: 3, overdue: 1, dueThisWeek: 1 });
  });

  it('lists only the open ones when asked for them (unchanged)', async () => {
    const res = await list('?status=open');
    expect(res.body.data.map((n) => n.reference)).toEqual(['OPEN-LATE', 'OPEN-IN-2', 'OPEN-NO-DATE']);
    expect(res.body.counts).toEqual({ open: 3, overdue: 1, dueThisWeek: 1 });
  });
});
