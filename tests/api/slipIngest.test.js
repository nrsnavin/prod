'use strict';
// ══════════════════════════════════════════════════════════════════
//  A PRODUCTION SLIP FROM A PHOTO
//
//  The reading itself (Claude vision) is stubbed: these tests hold what
//  happens to what was read — which shift it lands on, which rows are
//  safe to save, what is held for a person, and that saving goes through
//  the same submit-for-verification path as a worker's own entry.
// ══════════════════════════════════════════════════════════════════

process.env.NODE_ENV = 'test';

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

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, svc, SlipIngest, SlipPhoto, ShiftPlan, ShiftDetail, Machine, Employee, User, Outbox;
let shortCode, admin;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  svc = require('../../services/slipIngest');
  SlipIngest = require('../../models/SlipIngest');
  SlipPhoto = require('../../models/SlipPhoto');
  ShiftPlan = require('../../models/ShiftPlan');
  ShiftDetail = require('../../models/ShiftDetail');
  Machine = require('../../models/Machine');
  Employee = require('../../models/Employee');
  User = require('../../models/User');
  Outbox = require('../../models/Outbox');
  ({ shortCode } = require('../../utils/shiftSheetPdf'));
  admin = await User.create({ name: 'Floor Lead', email: 'lead@t.co', password: 'pass1234', role: 'admin', department: 'admin' });
}, 120_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  mockRead.mockReset();
  mockSend.mockClear();
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const photo = { buffer: Buffer.from('jpeg-bytes'), mimetype: 'image/jpeg' };

/** A plan with looms M-01..M-0n, one operator each. */
async function plan({ dateKey = '2026-10-06', shift = 'DAY', looms = 3, finalized = false, prefix = 'M-0' } = {}) {
  const sp = await ShiftPlan.create({ date: new Date(dateKey), shift, finalized });
  const details = [];
  for (let i = 1; i <= looms; i++) {
    const machine = await Machine.create({
      ID: `${prefix}${i}`, manufacturer: 'Comez', NoOfHead: 2, NoOfHooks: 8, status: 'running', elastics: [],
    });
    const emp = await Employee.create({ name: `Op ${i}`, department: 'weaving' });
    details.push(await ShiftDetail.create({
      date: new Date(dateKey), shift, timer: '00:00:00', elastics: [],
      employee: emp._id, shiftPlan: sp._id, machine: machine._id, status: 'open',
    }));
  }
  await ShiftPlan.updateOne({ _id: sp._id }, { $set: { plan: details.map((d) => d._id) } });
  return { sp, details };
}

const row = (over) => ({
  code: null, machine: null, operator: null, production: 1200, timer: '7:30:00', remarks: '', confidence: 0.95, ...over,
});
const reading = (over) => ({
  format: 'slip', planNo: null, date: null, shift: null, rows: [], problem: null,
  model: 'test-model', usage: {}, latencyMs: 5, ...over,
});

async function uploadAndRead(over = {}, { caption = '', dateKey, shift } = {}) {
  mockRead.mockResolvedValueOnce(reading(over));
  const slip = await svc.receiveUpload({ files: [photo], caption, dateKey, shift, user: admin });
  await svc.readSlipJob(slip._id);
  return SlipIngest.findById(slip._id).lean();
}

describe('working out the shift', () => {
  it('a printed sheet: from its plan number, and every row by its code', async () => {
    const { sp, details } = await plan();
    const slip = await uploadAndRead({
      format: 'sheet', planNo: 'SP-20261006-D',
      rows: details.map((d, i) => row({ code: shortCode(d._id), machine: `M-0${i + 1}` })),
    });
    expect(slip.status).toBe('ready');
    expect(String(slip.shiftPlan)).toBe(String(sp._id));
    expect(slip.dateFrom).toBe('plan');
    expect(slip.rows.map((r) => String(r.shiftDetail))).toEqual(details.map((d) => String(d._id)));
    expect(slip.rows.every((r) => r.state === 'ready')).toBe(true);
  });

  it('a printed sheet with no readable plan number: from its codes', async () => {
    const { sp, details } = await plan({ dateKey: '2026-10-05', shift: 'NIGHT' });
    await plan({ dateKey: '2026-10-06', shift: 'DAY', prefix: 'N-0' }); // another, more recent plan
    const slip = await uploadAndRead({ format: 'sheet', rows: [row({ code: shortCode(details[1]._id) })] });
    expect(String(slip.shiftPlan)).toBe(String(sp._id));
    expect(slip).toMatchObject({ dateKey: '2026-10-05', shift: 'NIGHT', dateFrom: 'codes' });
  });

  it("the factory's own slip: the caption wins over what is written on it", async () => {
    const { sp } = await plan({ dateKey: '2026-10-06', shift: 'NIGHT' });
    const slip = await uploadAndRead(
      { date: '2026-10-07', shift: 'DAY', rows: [row({ machine: '1' }), row({ machine: 'm2' })] },
      { caption: 'night 6/10/26' }
    );
    expect(String(slip.shiftPlan)).toBe(String(sp._id));
    expect(slip.dateFrom).toBe('caption');
    expect(slip.rows.map((r) => r.machineID)).toEqual(['M-01', 'M-02']);
  });

  it("the factory's own slip: the date and shift written on it", async () => {
    const { sp } = await plan();
    const slip = await uploadAndRead({ date: '2026-10-06', shift: 'DAY', rows: [row({ machine: 'M-03' })] });
    expect(String(slip.shiftPlan)).toBe(String(sp._id));
    expect(slip.dateFrom).toBe('slip');
  });

  it('never guesses: no date or shift anywhere asks for it, and a reply fixes it', async () => {
    const { sp } = await plan();
    const slip = await uploadAndRead({ rows: [row({ machine: 'M-01' })] });
    expect(slip.status).toBe('failed');
    expect(slip.problem).toMatch(/date and shift could not be told/);

    const fixed = await svc.setShift(slip._id, { dateKey: '2026-10-06', shift: 'DAY' });
    expect(fixed.status).toBe('ready');
    expect(String(fixed.shiftPlan)).toBe(String(sp._id));
    expect(fixed.dateFrom).toBe('person');
  });

  it('says so when there is no plan for that shift', async () => {
    await plan({ shift: 'DAY' });
    const slip = await uploadAndRead({ date: '2026-10-06', shift: 'NIGHT', rows: [row({ machine: 'M-01' })] });
    expect(slip.status).toBe('failed');
    expect(slip.problem).toMatch(/no night shift plan for 6 Oct 2026/);
  });

  it('a photo that is not a slip is failed, with the reason', async () => {
    const slip = await uploadAndRead({ rows: [], problem: 'not_a_slip' });
    expect(slip.status).toBe('failed');
    expect(slip.problem).toMatch(/does not look like a production slip/);
  });
});

describe('what is held for a person', () => {
  it('marks unclear, unreadable, impossible and conflicting rows; skips verified ones', async () => {
    const { details } = await plan({ looms: 5 });
    await ShiftDetail.updateOne({ _id: details[3]._id }, { $set: { status: 'pending_verification', submittedProductionMeters: 900 } });
    await ShiftDetail.updateOne({ _id: details[4]._id }, { $set: { status: 'closed' } });
    const slip = await uploadAndRead({
      date: '2026-10-06', shift: 'DAY',
      rows: [
        row({ machine: 'M-01', confidence: 0.4 }),
        row({ machine: 'M-02', production: null }),
        row({ machine: 'M-03', timer: '13:10:00' }),
        row({ machine: 'M-04', production: 1100 }),
        row({ machine: 'M-05' }),
        row({ machine: 'M-99' }),
      ],
    });
    const by = Object.fromEntries(slip.rows.map((r) => [r.machineID, r]));
    expect(by['M-01']).toMatchObject({ state: 'check', notes: ['Handwriting unclear'] });
    expect(by['M-02']).toMatchObject({ state: 'check', notes: ['Metres not readable'] });
    expect(by['M-03']).toMatchObject({ state: 'check', notes: ['Run time over 12 hours'] });
    expect(by['M-04']).toMatchObject({ state: 'check', notes: ['Already entered as 900 m'] });
    expect(by['M-05']).toMatchObject({ state: 'skip', notes: ['Already verified'] });
    expect(slip.unmatched.map((u) => u.machineRead)).toEqual(['M-99']);
  });

  it('a finalised shift is skipped whole', async () => {
    await plan({ finalized: true });
    const slip = await uploadAndRead({ date: '2026-10-06', shift: 'DAY', rows: [row({ machine: 'M-01' })] });
    expect(slip.rows[0]).toMatchObject({ state: 'skip', notes: ['Shift is finalised'] });
  });
});

describe('saving', () => {
  it('"OK" saves the clear rows as submitted, and leaves the rest for the web', async () => {
    const { details } = await plan();
    const slip = await uploadAndRead({
      date: '2026-10-06', shift: 'DAY',
      rows: [row({ machine: 'M-01', production: 1250 }), row({ machine: 'M-02', confidence: 0.3 })],
    });

    const out = await svc.applySlip(slip._id, { user: admin });
    expect(out).toMatchObject({ saved: 1, remaining: 1 });
    const d1 = await ShiftDetail.findById(details[0]._id).lean();
    expect(d1).toMatchObject({ status: 'pending_verification', submittedProductionMeters: 1250, submittedTimer: '7:30:00' });
    expect((await ShiftDetail.findById(details[1]._id).lean()).status).toBe('open');
    expect(out.slip.status).toBe('ready');

    // The web saves the held row with a corrected figure; then it is done.
    const done = await svc.applySlip(slip._id, {
      user: admin, edits: [{ index: 1, include: true, production: 1180, timer: '7:20:00' }],
    });
    expect(done).toMatchObject({ saved: 1, remaining: 0 });
    expect(done.slip.status).toBe('applied');
    expect((await ShiftDetail.findById(details[1]._id).lean()).submittedProductionMeters).toBe(1180);
  });

  it('two "OK"s at once save once', async () => {
    await plan();
    const slip = await uploadAndRead({ date: '2026-10-06', shift: 'DAY', rows: [row({ machine: 'M-01' })] });
    const results = await Promise.allSettled([
      svc.applySlip(slip._id, { user: admin }),
      svc.applySlip(slip._id, { user: admin }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.statusCode).toBe(409);
  });

  it('a row verified after the slip was read is not reopened', async () => {
    const { details } = await plan();
    const slip = await uploadAndRead({ date: '2026-10-06', shift: 'DAY', rows: [row({ machine: 'M-01' })] });
    await ShiftDetail.updateOne({ _id: details[0]._id }, { $set: { status: 'closed' } });
    const out = await svc.applySlip(slip._id, { user: admin });
    expect(out.saved).toBe(0);
    expect((await ShiftDetail.findById(details[0]._id).lean()).status).toBe('closed');
    expect(out.slip.rows[0].state).toBe('skip');
  });

  it('a dropped slip saves nothing, and a saved one cannot be dropped', async () => {
    await plan();
    const a = await uploadAndRead({ date: '2026-10-06', shift: 'DAY', rows: [row({ machine: 'M-01' })] });
    await svc.discardSlip(a._id, { user: admin });
    await expect(svc.applySlip(a._id, { user: admin })).rejects.toMatchObject({ statusCode: 409 });

    const b = await uploadAndRead({ date: '2026-10-06', shift: 'DAY', rows: [row({ machine: 'M-02' })] });
    await svc.applySlip(b._id, { user: admin });
    await expect(svc.discardSlip(b._id, { user: admin })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('reading in the background', () => {
  it('keeps the photos and queues the read', async () => {
    const slip = await svc.receiveUpload({ files: [photo, photo], user: admin });
    expect(await SlipPhoto.countDocuments({ slip: slip._id })).toBe(2);
    expect(await Outbox.countDocuments({ kind: 'slip.read' })).toBe(1);
    expect(slip.confirmCode).toMatch(/^\d{4}$/);
  });

  it('a WhatsApp retry of the same message is the same slip', async () => {
    const sender = { userId: admin._id, name: 'Floor Lead' };
    const media = [{ url: 'https://api.twilio.com/x/Media/ME1', contentType: 'image/jpeg' }];
    const a = await svc.receiveFromWhatsApp({ messageSid: 'SM1', from: '+919100000001', media, sender });
    const b = await svc.receiveFromWhatsApp({ messageSid: 'SM1', from: '+919100000001', media, sender });
    expect(String(b.slip._id)).toBe(String(a.slip._id));
    expect(b.duplicate).toBe(true);
    expect(await SlipIngest.countDocuments()).toBe(1);
  });

  it('a transient failure is retried, then given up on with a message', async () => {
    const slip = await svc.receiveUpload({ files: [photo], user: admin });
    mockRead.mockRejectedValue(new Error('overloaded'));
    await expect(svc.readSlipJob(slip._id)).rejects.toThrow('overloaded');
    await expect(svc.readSlipJob(slip._id)).rejects.toThrow('overloaded');
    await svc.readSlipJob(slip._id);
    const after = await SlipIngest.findById(slip._id).lean();
    expect(after.status).toBe('failed');
    expect(after.problem).toMatch(/could not be fetched or read/);
  });

  it('tells a WhatsApp sender what it read', async () => {
    await plan();
    const sender = { userId: admin._id, name: 'Floor Lead' };
    const { slip } = await svc.receiveFromWhatsApp({ messageSid: 'SM2', from: '+919100000001', media: [], sender, caption: 'DAY 06-10-2026' });
    await SlipPhoto.create({ slip: slip._id, page: 0, contentType: 'image/jpeg', size: 4, data: 'AAAA' });
    mockRead.mockResolvedValueOnce(reading({ rows: [row({ machine: 'M-01' }), row({ machine: 'M-02', confidence: 0.2 })] }));
    await svc.readSlipJob(slip._id);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [to, text] = mockSend.mock.calls[0];
    expect(to).toBe('+919100000001');
    expect(text).toMatch(new RegExp(`Slip ${slip.confirmCode}: Day shift, 6 Oct 2026`));
    expect(text).toMatch(/1 ready, 1 to check/);
    expect(text).toMatch(/M-02 \(Handwriting unclear\)/);
    expect(text).toMatch(new RegExp(`Reply OK ${slip.confirmCode}`));
  });
});

describe('reading what people type', () => {
  it('understands OK / NO / a corrected date and shift', () => {
    expect(svc.parseSlipCommand('ok 4821')).toEqual({ action: 'ok', code: '4821' });
    expect(svc.parseSlipCommand('NO 4821')).toEqual({ action: 'no', code: '4821' });
    expect(svc.parseSlipCommand('4821 night 6/10')).toMatchObject({ action: 'set', code: '4821', shift: 'NIGHT' });
    expect(svc.parseSlipCommand('APPROVE 1042')).toBeNull();
    expect(svc.parseSlipCommand('4821 hello')).toBeNull();
  });

  it('reads dates day first', () => {
    const now = new Date(2026, 9, 7);
    expect(svc.parseDateShift('DAY 06-10', now)).toEqual({ dateKey: '2026-10-06', shift: 'DAY' });
    expect(svc.parseDateShift('n 6/10/26', now)).toEqual({ dateKey: '2026-10-06', shift: 'NIGHT' });
    expect(svc.parseDateShift('31-02', now).dateKey).toBeNull();
    // A date that would be in the future without a year is last year's.
    expect(svc.parseDateShift('day 25-12', now).dateKey).toBe('2025-12-25');
  });
});
