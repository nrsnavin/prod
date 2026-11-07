'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SHIFT HANDOVER — services/shiftHandover.js
//
//    • the note for a shift: metres entered, looms not entered, what the
//      operators wrote, machine issues still open (serious first), and
//      what to watch — by the model over those facts, or by rule
//    • off until turned on; then once, early in the next shift, for the
//      shift that just ended; "send now" any time
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mockSend = jest.fn(async () => ({ sent: true, providerId: 'wa1' }));
jest.mock('../../utils/whatsapp', () => ({ sendWhatsApp: (...a) => mockSend(...a), isConfigured: () => true, PROVIDER: 'twilio' }));
let mockModel = null;
jest.mock('../../utils/anthropicClient', () => ({
  anthropic: () => (mockModel ? { messages: { create: async () => ({ content: [{ type: 'text', text: mockModel }], usage: { input_tokens: 10, output_tokens: 10 } }) } } : null),
  TEXT_MODEL: 'test-text', VISION_MODEL: 'test-vision', isPinned: () => true,
}));

const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, M, admin, handover, s;
const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];
const at = (iso) => new Date(`${iso}+05:30`);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app = require('../../app.js');
  handover = require('../../services/shiftHandover');
  M = {};
  for (const n of ['User', 'Employee', 'Machine', 'JobOrder', 'ShiftDetail', 'Customer', 'Order', 'Elastic', 'MachineIssue', 'AiSuggestion', 'Notification']) M[n] = require(`../../models/${n}.js`);
  admin = await M.User.create({ name: 'Owner', email: 'ho@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
  const customer = await M.Customer.create({ name: 'Acme', contactName: 'R', phoneNumber: '9200000001' });
  const elastic = await M.Elastic.create({ name: '20mm', weaveType: '8', spandexEnds: 40, yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4 });
  const order = await M.Order.create({ orderNo: 3001, customer: customer._id, status: 'InProgress', po: 'PO-1', date: new Date(), supplyDate: new Date(), elasticOrdered: [{ elastic: elastic._id, quantity: 100000 }] });
  const job = await M.JobOrder.create({ date: new Date(), order: order._id, customer: customer._id, status: 'weaving', elastics: [{ elastic: elastic._id, quantity: 100000 }] });
  const make = (ID, status = 'running') => M.Machine.create({ ID, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status, orderRunning: status === 'running' ? job._id : undefined, elastics: status === 'running' ? [{ head: 0, elastic: elastic._id }] : [] });
  const ravi = await M.Employee.create({ name: 'Ravi', department: 'weaving' });
  s = { a: await make('A1'), b: await make('B1'), m: await make('M9', 'maintenance'), ravi };
  const { createShiftPlan } = require('../../services/shiftPlanCreate');
  const { shiftPlan } = await createShiftPlan({ date: '2026-10-21', shiftType: 'DAY', machines: [{ machine: s.a._id, operator: ravi._id }, { machine: s.b._id, operator: ravi._id }] });
  await M.ShiftDetail.updateOne({ shiftPlan: shiftPlan._id, machine: s.a._id }, { $set: { status: 'pending_verification', submittedProductionMeters: 410, submittedFeedback: 'yarn breaking on head 2' } });
  await M.MachineIssue.create({ machine: s.b._id, source: 'admin', title: 'Take-up roller slipping', description: 'slips', severity: 'high', status: 'open' });
  await M.MachineIssue.create({ machine: s.a._id, source: 'admin', title: 'Oil leak', description: 'drip', severity: 'low', status: 'open' });
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(() => { mockSend.mockClear(); mockModel = null; });

describe('the shift handover', () => {
  it('says what was made, what is missing, what is wrong, and what to watch — by rule without a model', async () => {
    const n = await handover.note({ dateKey: '2026-10-21', shift: 'DAY' });
    expect(n.figures).toMatchObject({ metres: { made: 410 }, notEntered: ['B1'], down: ['M9'], openIssues: 2 });
    expect(n.figures.issues.map((i) => i.title)).toEqual(['Take-up roller slipping', 'Oil leak']);
    expect(n.by).toBe('rules');
    expect(n.text).toContain('Metres: 410');
    expect(n.text).toContain('Not entered: B1');
    expect(n.text).toContain('Remarks: A1 — yarn breaking on head 2');
    expect(n.text).toContain('B1 Take-up roller slipping [high]');
    expect(n.watch[0]).toBe('Check B1 (Take-up roller slipping) before starting.');
  });

  it('takes what to watch from the model when there is one, and records it', async () => {
    mockModel = '- Look at A1 head 2 for yarn breaks\n- Fix the B1 take-up roller first';
    const n = await handover.note({ dateKey: '2026-10-21', shift: 'DAY' });
    expect(n.by).toBe('model');
    expect(n.watch).toEqual(['Look at A1 head 2 for yarn breaks', 'Fix the B1 take-up roller first']);
    expect(await M.AiSuggestion.countDocuments({ surface: 'shift-handover' })).toBe(1);
  });

  it('is off until turned on; then sends once, early in the next shift', async () => {
    const night = at('2026-10-21T20:20:00');
    expect(await handover.run({ now: night })).toMatchObject({ sent: false, why: 'off' });
    const on = await request(app).put('/api/v2/shift/production-settings').set('Cookie', cookie()).send({ shiftHandover: { enabled: true, withinMinutes: 60, phones: '98400 00001' } });
    expect(on.status).toBe(200);
    expect(await handover.run({ now: at('2026-10-21T22:00:00') })).toMatchObject({ sent: false, why: 'not now' });
    const out = await handover.run({ now: night });
    expect(out).toMatchObject({ sent: true, tag: '2026-10-21:DAY' });
    expect(mockSend).toHaveBeenCalledWith('+919840000001', expect.stringContaining('Handover — Day shift'));
    expect((await handover.run({ now: at('2026-10-21T20:40:00') })).why).toBe('already sent');
    // The preview, for any shift.
    const prev = await request(app).get('/api/v2/shift/handover?dateKey=2026-10-21&shift=DAY').set('Cookie', cookie());
    expect(prev.body.text).toContain('Not entered: B1');
  });
});
