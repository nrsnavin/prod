'use strict';
// ══════════════════════════════════════════════════════════════════
//  BEFORE THE SHIFT ENDS — services/shiftEndNudge.js
//
//    • off until an admin turns it on; then, within `minutesBefore` of
//      the shift's end, one WhatsApp message naming the looms still to
//      enter — once a shift, whoever asks
//    • nothing when every loom is entered
//    • to the setting's numbers, else the notification recipients
//    • "Send now" for the admin, any time
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockSend = jest.fn(async () => ({ sent: true, providerId: 'wa1' }));
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true, PROVIDER: 'twilio' }));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, supervisor, nudge;
const cookie = (u) => [`token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`];
const as = (u) => ({
  put: (url, body) => request(app).put(`/api/v2${url}`).set('Cookie', cookie(u)).send(body),
  post: (url, body) => request(app).post(`/api/v2${url}`).set('Cookie', cookie(u)).send(body),
});
// 21 Oct 2026, factory time (IST, UTC+5:30).
const at = (hhmm) => new Date(`2026-10-21T${hhmm}:00+05:30`);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  nudge = require('../../services/shiftEndNudge');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftPlan', 'ShiftDetail', 'Customer', 'Order', 'Elastic', 'ProductionSettings', 'NotificationSettings', 'Notification']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'sn@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  supervisor = await M.User.create({ name: 'Sup', email: 'sn2@t.co', password: 'pass1234', role: 'production', department: 'production' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) if (!['users', 'counters'].includes(c.collectionName)) await c.deleteMany({});
  mockSend.mockClear();
});

let n = 0;
async function looms() {
  n += 1;
  const customer = await M.Customer.create({ name: `Acme ${n}`, contactName: 'R', phoneNumber: `92000000${String(n).padStart(2, '0')}` });
  const elastic = await M.Elastic.create({ name: `20mm ${n}`, weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({ orderNo: 3000 + n, customer: customer._id, status: 'InProgress', po: `PO-${n}`, date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }] });
  const job = await M.JobOrder.create({ date: new Date(), order: order._id, customer: customer._id, status: 'weaving', elastics: [{ elastic: elastic._id, quantity: 100000 }] });
  const make = (ID) => M.Machine.create({ ID, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'running', orderRunning: job._id, elastics: [{ head: 0, elastic: elastic._id }] });
  const ravi = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  return { a: await make(`A${n}`), b: await make(`B${n}`), free: await M.Machine.create({ ID: `F${n}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'free', elastics: [] }), ravi };
}
const turnOn = (over = {}) => as(admin).put('/shift/production-settings', { shiftEndNudge: { enabled: true, minutesBefore: 30, phones: '98400 00001', ...over } });

describe('the shift-end reminder', () => {
  it('counts down to the end of the running shift, factory time', () => {
    expect(nudge.minutesLeft(at('19:40'))).toMatchObject({ dateKey: '2026-10-21', shift: 'DAY', left: 20 });
    expect(nudge.minutesLeft(at('08:00'))).toMatchObject({ shift: 'DAY', left: 720 });
    expect(nudge.minutesLeft(at('21:00'))).toMatchObject({ dateKey: '2026-10-21', shift: 'NIGHT', left: 660 });
    expect(nudge.minutesLeft(new Date('2026-10-22T07:45:00+05:30'))).toMatchObject({ dateKey: '2026-10-21', shift: 'NIGHT', left: 15 });
  });

  it('is off until turned on; then, once in the last half hour, names the looms still to enter', async () => {
    const s = await looms();
    expect(await nudge.run({ now: at('19:40') })).toMatchObject({ sent: false, why: 'off' });
    expect((await turnOn()).status).toBe(200);
    expect(await nudge.run({ now: at('19:00') })).toMatchObject({ sent: false, why: 'not yet' });

    const out = await nudge.run({ now: at('19:40') });
    expect(out).toMatchObject({ sent: true, tag: '2026-10-21:DAY', looms: [s.a.ID, s.b.ID] });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [to, body] = mockSend.mock.calls[0];
    expect(to).toBe('+919840000001');
    expect(body).toContain('Day shift ends at 8:00 PM');
    expect(body).toContain('2 looms not entered yet');
    expect(body).toContain(`${s.a.ID}, ${s.b.ID}`);
    expect(body).not.toContain(s.free.ID);
    expect(await M.Notification.countDocuments({ event: 'shiftEndNudge', status: 'sent' })).toBe(1);

    // Once a shift, however many times it is asked — and two at once send one.
    const again = await Promise.all([nudge.run({ now: at('19:45') }), nudge.run({ now: at('19:46') })]);
    expect(again.every((r) => r.why === 'already sent')).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when every loom is entered', async () => {
    const s = await looms();
    await turnOn();
    const { createShiftPlan } = require('../../services/shiftPlanCreate');
    const { shiftPlan } = await createShiftPlan({ date: '2026-10-21', shiftType: 'DAY', machines: [{ machine: s.a._id, operator: s.ravi._id }, { machine: s.b._id, operator: s.ravi._id }] });
    await M.ShiftDetail.updateMany({ shiftPlan: shiftPlan._id }, { $set: { status: 'pending_verification', submittedProductionMeters: 300 } });
    expect(await nudge.run({ now: at('19:40') })).toMatchObject({ sent: false, why: 'every loom is entered' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('with no numbers set, goes to the notification recipients', async () => {
    await looms();
    await turnOn({ phones: [] });
    await M.NotificationSettings.create({ recipients: ['+919840000009'] });
    expect(await nudge.run({ now: at('19:40') })).toMatchObject({ sent: true });
    expect(mockSend).toHaveBeenCalledWith('+919840000009', expect.stringContaining('not entered yet'), expect.anything());
  });

  it('"Send now" is the admin\'s, any time, and does not use up the timed one', async () => {
    await looms();
    await turnOn();
    expect((await as(supervisor).post('/shift/shift-end-nudge/send')).status).toBe(403);
    const res = await as(admin).post('/shift/shift-end-nudge/send');
    expect(res.status).toBe(200);
    expect(res.body.text).toMatch(/not entered yet/);
    expect((await M.ProductionSettings.findOne({ key: 'production' }).lean()).shiftEndNudge.lastSent).toBe('');
  });
});
