'use strict';
// ══════════════════════════════════════════════════════════════════
//  GOVERNMENT NOTICES AND THEIR REPLY DEADLINE
//
//    • a GST notice read into form, reference, amount and the date to
//      reply; with no date printed, ASMT-10's 30 days, marked assumed;
//      what the reply needs listed; nothing saved by reading
//    • kept in the register, soonest first; the same reference twice is
//      refused; replied only with the reply's reference
//    • reminders at 7, 3, 1 days, on the day and once overdue, each once;
//      a new deadline starts them again
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

let mockReply = {};
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => ({ messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify(mockReply) }], usage: { input_tokens: 10, output_tokens: 10 } }) } }),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const pdf = Buffer.from('%PDF-1.4 notice');
const day = (offset, from = new Date()) => new Date(from.getTime() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  M = { User: require('../../models/User.js'), Notice: require('../../models/StatutoryNotice.js'), Notification: require('../../models/Notification.js') };
  admin = await M.User.create({ name: 'Owner', email: 'notice@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe('a government notice', () => {
  it('reads the notice, works out ASMT-10\'s 30 days when none is printed, and lists what the reply needs', async () => {
    mockReply = { problem: null, authority: 'gst', form: 'FORM GST ASMT-10', reference: 'ZD331124001', subject: 'Scrutiny — ITC mismatch', periodText: 'Apr 2024 – Mar 2025', financialYear: '2024-25', amount: '1,84,500', issuedOn: '2026-10-28', replyBy: '', summary: 'ITC is more than 2B.', asks: ['Copies of supplier invoices'] };
    const res = await request(app).post('/api/v2/accounts/notices/read').set('Cookie', cookie()).attach('files', pdf, { filename: 'n.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.read).toMatchObject({ authority: 'gst', reference: 'ZD331124001', amount: 184500, issuedOn: '2026-10-28', replyBy: '2026-11-27', replyByAssumed: true });
    expect(res.body.read.documents[0]).toMatch(/GSTR-1 vs GSTR-3B/);
    expect(res.body.read.documents).toContain('Copies of supplier invoices');
    expect(await M.Notice.countDocuments()).toBe(0);

    mockReply = { problem: 'not_a_notice' };
    expect((await request(app).post('/api/v2/accounts/notices/read').set('Cookie', cookie()).attach('files', pdf, { filename: 'n.pdf', contentType: 'application/pdf' })).body.read.problem).toBe('not_a_notice');
  });

  it('keeps it in the register soonest first, refuses the same one twice, and is replied with a reference', async () => {
    const post = (b) => request(app).post('/api/v2/accounts/notices').set('Cookie', cookie()).send(b);
    const a = await post({ authority: 'gst', form: 'DRC-01', reference: 'R-1', replyBy: day(20), amount: 50000 });
    expect(a.status).toBe(201);
    await post({ authority: 'pf', subject: 'Late remittance', reference: 'R-2', replyBy: day(2) });
    await post({ authority: 'income_tax', form: '143(2)', reference: 'R-3' });
    expect((await post({ form: 'DRC-01', reference: 'R-1' })).status).toBe(409);
    const list = (await request(app).get('/api/v2/accounts/notices').set('Cookie', cookie())).body;
    expect(list.data.map((n) => n.reference)).toEqual(['R-2', 'R-1', 'R-3']);
    expect(list.data[0]).toMatchObject({ daysLeft: 2, urgency: 'urgent' });
    expect(list.counts).toEqual({ open: 3, overdue: 0, dueThisWeek: 1 });

    const patch = (b) => request(app).patch(`/api/v2/accounts/notices/${a.body.data._id}`).set('Cookie', cookie()).send(b);
    expect((await patch({ status: 'replied' })).status).toBe(400);
    const done = await patch({ status: 'replied', replyRef: 'ARN AA331124009' });
    expect(done.body.data).toMatchObject({ status: 'replied', replyRef: 'ARN AA331124009', daysLeft: null });
  });

  it('reminds at 7, 3, 1 days, on the day and once overdue — each once', async () => {
    const { run, dueKey } = require('../../services/noticeReminders');
    await M.Notice.deleteMany({});
    const n = await M.Notice.create({ authority: 'gst', form: 'ASMT-10', reference: 'R-9', replyBy: new Date(`${day(6)}T12:00:00+05:30`), amount: 184500 });
    const at = (offset) => new Date(Date.now() + offset * 86_400_000);
    expect(dueKey(n, at(0))).toBe('7');
    expect(dueKey(n, at(-2))).toBe(null);
    let r = await run({ now: at(0) });
    expect(r.sent.map((s) => s.key)).toEqual(['7']);
    expect(r.sent[0].body).toMatch(/Reply due in 7 days.*ASMT-10/);
    expect(r.sent[0].body).toMatch(/amount ₹1,84,500/);
    expect((await run({ now: at(1) })).sent).toEqual([]);
    expect((await run({ now: at(4) })).sent.map((s) => s.key)).toEqual(['3']);
    expect((await run({ now: at(5) })).sent.map((s) => s.key)).toEqual(['1']);
    expect((await run({ now: at(6) })).sent.map((s) => s.key)).toEqual(['0']);
    expect((await run({ now: at(8) })).sent.map((s) => s.key)).toEqual(['overdue']);
    expect((await run({ now: at(9) })).sent).toEqual([]);
    expect(await M.Notification.countDocuments({ event: 'statutoryNotice' })).toBe(5);

    // A new date (an extension): the countdown starts again.
    await request(app).patch(`/api/v2/accounts/notices/${n._id}`).set('Cookie', cookie()).send({ replyBy: day(3) });
    expect((await M.Notice.findById(n._id).lean()).reminded).toEqual([]);
  });
});
