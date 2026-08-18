'use strict';
// ══════════════════════════════════════════════════════════════════
//  "IS OUR AI WORKING?" — NOW A QUESTION WITH AN ANSWER
//
//  Five surfaces in this system call a model. Before this endpoint
//  existed there was no way to answer any of the following without
//  reading the source and then guessing:
//
//    • is an API key even configured on this server?
//    • which model is each surface actually calling today?
//    • is that model string PINNED, or an alias that can be re-pointed
//      upstream with no deploy on our side?
//    • which prompt version produced last month's results?
//    • how often does a human accept what the model said?
//
//  GET /api/v2/health/ai answers all five. These tests hold it to the
//  two properties that make it trustworthy: it is admin-only (it
//  reports spend and internals), and a broken ledger degrades it rather
//  than taking it down — a health endpoint that dies with the thing it
//  monitors is the least useful kind.
//
//  The second half covers the shift-plan lock, because the OCR feeds
//  it: /bulk-enter-production writes production figures 200 at a time
//  and was the one door into a finalised plan that never checked the
//  lock.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, app, ledger;
let AiSuggestion, ShiftPlan, ShiftDetail, Machine, Employee, User;
let admin, operator, machine, employee;

const cookieFor = (u) => [
  `token=${jwt.sign({ id: u._id, role: u.role }, process.env.JWT_SECRET_KEY)}`,
];

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app          = require('../../app.js');
  ledger       = require('../../services/aiLedger');
  AiSuggestion = require('../../models/AiSuggestion');
  ShiftPlan    = require('../../models/ShiftPlan');
  ShiftDetail  = require('../../models/ShiftDetail');
  Machine      = require('../../models/Machine');
  Employee     = require('../../models/Employee');
  User         = require('../../models/User');

  admin = await User.create({
    name: 'Admin', email: 'ai-admin@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
  operator = await User.create({
    name: 'Operator', email: 'ai-op@t.co', password: 'pass1234',
    role: 'user', department: 'production',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  machine = await Machine.create({
    ID: `LOOM-AI-${seq++}`, manufacturer: 'Comez', DateOfPurchase: new Date(),
    NoOfHead: 4, NoOfHooks: 12,
  });
  employee = await Employee.create({
    name: `Op ${seq}`, phoneNumber: `90000000${String(seq).padStart(2, '0')}`,
    department: 'production',
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const health = (qs = '') =>
  request(app).get(`/api/v2/health/ai${qs}`).set('Cookie', cookieFor(admin));

// ══════════════════════════════════════════════════════════════════
//  1. THE HEALTH ENDPOINT
// ══════════════════════════════════════════════════════════════════
describe('GET /api/v2/health/ai', () => {
  test('is admin-only — it reports internals and spend', async () => {
    const res = await request(app).get('/api/v2/health/ai').set('Cookie', cookieFor(operator));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('names the model each surface calls, and whether it can move underneath us', async () => {
    // The distinction this endpoint exists to surface: a dated snapshot
    // changes only when somebody changes it, while an alias resolves to
    // whatever is current upstream. An accuracy drop on a Tuesday with
    // nothing in the repo changed is only diagnosable if you can see
    // which of the two you are running.
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.body.models.text.id).toBeTruthy();
    expect(res.body.models.vision.id).toBeTruthy();
    expect(typeof res.body.models.text.pinned).toBe('boolean');
    expect(typeof res.body.models.vision.pinned).toBe('boolean');
    // TEXT_MODEL ships as a dated snapshot; a regression that swapped it
    // for an alias should be visible here.
    expect(res.body.models.text.pinned).toBe(true);
  });

  test('reports a version for every registered prompt', async () => {
    // A prompt edit is a model change with no changelog unless it is
    // versioned. Every surface must carry one, or the ledger attributes
    // yesterday's results to today's wording.
    const res = await health();
    for (const surface of ['planner-rationale', 'qc-vision', 'shift-sheet-ocr',
                           'advisor-briefing', 'assistant-answer']) {
      expect(res.body.prompts[surface]).toMatch(/^v\d/);
    }
  });

  test('reports per-surface agreement over the window', async () => {
    const id = await ledger.record({
      surface: 'qc-vision', model: 'v', promptVersion: 'v1.0',
      proposed: { defectCode: 'weave-fault' },
    });
    await ledger.settle(id, { accepted: { defectCode: 'weave-fault' } });

    const res = await health();
    const qc = res.body.surfaces.find((s) => s.surface === 'qc-vision');
    expect(qc).toMatchObject({ total: 1, decided: 1, accepted: 1, acceptRate: 100 });
  });

  test('the weakest-field breakdown is opt-in', async () => {
    await AiSuggestion.create({
      surface: 'shift-sheet-ocr', model: 'm', outcome: 'edited',
      editedFields: ['rows[].timer'],
    });
    expect((await health()).body.weakestFields).toBeUndefined();

    const withFields = await health('?fields=1');
    expect(withFields.body.weakestFields[0])
      .toMatchObject({ field: 'rows[].timer', suggestions: 1 });
  });

  test('the window is clamped to something sane', async () => {
    expect((await health('?days=99999')).body.windowDays).toBe(365);
    expect((await health('?days=-5')).body.windowDays).toBe(30);
  });

  test('a broken ledger degrades the report rather than taking it down', async () => {
    // A health endpoint that dies with the thing it monitors tells you
    // nothing at the exact moment you need it.
    const spy = jest.spyOn(AiSuggestion, 'aggregate')
      .mockRejectedValueOnce(new Error('ledger unavailable'));
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.ledgerError).toMatch(/unavailable/);
    // The parts that do not depend on the ledger still answered.
    expect(res.body.models.text.id).toBeTruthy();
    spy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. THE HIGHEST-VOLUME DOOR INTO A LOCKED SHIFT
// ══════════════════════════════════════════════════════════════════
describe('POST /shift/bulk-enter-production and the finalise lock', () => {
  // (date, shift) is unique on ShiftPlan, so each plan gets its own day.
  let dayOffset = 0;
  const makeShift = async ({ finalized }) => {
    const date = new Date(); date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - dayOffset++);
    const plan = await ShiftPlan.create({ date, shift: 'DAY', finalized });
    const sd = await ShiftDetail.create({
      employee: employee._id, date, shift: 'DAY', status: 'open',
      machine: machine._id, shiftPlan: plan._id,
    });
    return { plan, sd };
  };

  const bulk = (body) => request(app)
    .post('/api/v2/shift/bulk-enter-production')
    .set('Cookie', cookieFor(admin)).send(body);

  test('a finalised plan is frozen — the batch path honours the lock too', async () => {
    // assertPlanNotFinalized sits in this file under a comment saying it
    // is "used by every route that would change a locked shift's
    // numbers". This route, which writes up to 200 production figures at
    // a time, never called it. The single-entry path, the correction
    // path and the delete path all did — so the lock held everywhere
    // except the widest door into the same field.
    const { sd } = await makeShift({ finalized: true });

    const res = await bulk({ entries: [{ id: String(sd._id), production: 1200 }] });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(0);
    expect(res.body.skipped[0].reason).toMatch(/finalised/i);

    const after = await ShiftDetail.findById(sd._id).lean();
    expect(after.submittedProductionMeters).toBeFalsy();
    expect(after.status).toBe('open');
  });

  test('one locked shift does not reject the other 199', async () => {
    // Skipped rather than thrown, on purpose: an operator entering a
    // day's sheet should not lose 199 good rows to one frozen plan.
    const locked = await makeShift({ finalized: true });
    const open   = await makeShift({ finalized: false });

    const res = await bulk({ entries: [
      { id: String(locked.sd._id), production: 1200 },
      { id: String(open.sd._id),   production: 1300 },
    ] });

    expect(res.body.saved).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect((await ShiftDetail.findById(open.sd._id).lean()).submittedProductionMeters).toBe(1300);
  });

  test('an unlocked plan still writes, exactly as before', async () => {
    const { sd } = await makeShift({ finalized: false });
    const res = await bulk({ entries: [{ id: String(sd._id), production: 1240, timer: '7:45:00' }] });
    expect(res.body.saved).toBe(1);

    const after = await ShiftDetail.findById(sd._id).lean();
    expect(after.submittedProductionMeters).toBe(1240);
    expect(after.status).toBe('pending_verification');
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. THE OCR ROUND TRIP — proposed, then settled against what was saved
// ══════════════════════════════════════════════════════════════════
describe('the shift-sheet OCR settles against what the operator saved', () => {
  test('untouched rows stay undecided; corrected columns are named', async () => {
    const date = new Date(); date.setHours(0, 0, 0, 0);
    const plan = await ShiftPlan.create({ date, shift: 'DAY', finalized: false });
    const mk = () => ShiftDetail.create({
      employee: employee._id, date, shift: 'DAY', status: 'open',
      machine: machine._id, shiftPlan: plan._id,
    });
    const [a, b, c] = [await mk(), await mk(), await mk()];

    // What the OCR read off the scanned sheet.
    const id = await ledger.record({
      surface: 'shift-sheet-ocr', model: 'vision-x', promptVersion: 'v1.0',
      refType: 'ShiftPlan', refId: plan._id,
      proposed: { rows: {
        [a._id]: { production: 1200, timer: '7:45:00', remarks: '' },
        [b._id]: { production: 980,  timer: '7:30:00', remarks: '' },
        [c._id]: { production: 1100, timer: '7:00:00', remarks: '' },
      } },
    });

    // The operator verifies two rows — accepting one, fixing the timer
    // on the other — and leaves the third for the next shift.
    const res = await request(app)
      .post('/api/v2/shift/bulk-enter-production')
      .set('Cookie', cookieFor(admin))
      .send({ aiSuggestionId: String(id), entries: [
        { id: String(a._id), production: 1200, timer: '7:45:00' },
        { id: String(b._id), production: 980,  timer: '6:10:00' },
      ] });
    expect(res.body.saved).toBe(2);

    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('edited');
    // The timer needed a human; the production figures did not; the
    // untouched row is silent rather than counted as a rejection.
    expect(row.editedFields).toEqual(['rows[].timer']);
    expect(String(row.decidedBy)).toBe(String(admin._id));
  });

  test('a batch with no suggestion id behaves exactly as it always did', async () => {
    const date = new Date(); date.setHours(0, 0, 0, 0);
    const plan = await ShiftPlan.create({ date, shift: 'DAY' });
    const sd = await ShiftDetail.create({
      employee: employee._id, date, shift: 'DAY', status: 'open',
      machine: machine._id, shiftPlan: plan._id,
    });

    const res = await request(app)
      .post('/api/v2/shift/bulk-enter-production')
      .set('Cookie', cookieFor(admin))
      .send({ entries: [{ id: String(sd._id), production: 900 }] });

    expect(res.body.saved).toBe(1);
    expect(await AiSuggestion.countDocuments({})).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. THE STORAGE DEFAULT THAT LOOKED LIKE A HUMAN CORRECTION
// ══════════════════════════════════════════════════════════════════
describe('a blank timer is not a correction', () => {
  test('an entry submitted with no timer does not read as the operator fixing it', async () => {
    // /bulk-enter-production defaults a missing timer to '00:00:00'
    // before writing it. Recording THAT as what the operator saved
    // compares the storage default against the OCR's null and calls it
    // an edit — on every row where the timer cell was blank, which is
    // most of them on a quiet shift.
    //
    // The effect is the worst kind: the weakest-field report names the
    // timer column as the OCR's biggest problem, an afternoon goes into
    // improving a prompt that was never wrong, and the figure is just as
    // plausible either way.
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 40);
    const plan = await ShiftPlan.create({ date, shift: 'DAY' });
    const sd = await ShiftDetail.create({
      employee: employee._id, date, shift: 'DAY', status: 'open',
      machine: machine._id, shiftPlan: plan._id,
    });

    const id = await ledger.record({
      surface: 'shift-sheet-ocr', model: 'm', promptVersion: 'v1',
      refType: 'ShiftPlan', refId: plan._id,
      // The sheet's timer cell was blank and the OCR correctly read null.
      proposed: { rows: { [sd._id]: { production: 1200, timer: null, remarks: '' } } },
    });

    await request(app)
      .post('/api/v2/shift/bulk-enter-production')
      .set('Cookie', cookieFor(admin))
      .send({ aiSuggestionId: String(id), entries: [{ id: String(sd._id), production: 1200 }] });

    const row = await AiSuggestion.findById(id).lean();
    expect(row.editedFields).toEqual([]);
    expect(row.outcome).toBe('accepted');

    // The ShiftDetail still stores the default — this is about what the
    // LEDGER was told, not about changing how the shift is saved.
    const saved = await ShiftDetail.findById(sd._id).lean();
    expect(saved.submittedTimer).toBe('00:00:00');
  });

  test('a timer the operator actually typed is still compared', async () => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 41);
    const plan = await ShiftPlan.create({ date, shift: 'DAY' });
    const sd = await ShiftDetail.create({
      employee: employee._id, date, shift: 'DAY', status: 'open',
      machine: machine._id, shiftPlan: plan._id,
    });

    const id = await ledger.record({
      surface: 'shift-sheet-ocr', model: 'm', promptVersion: 'v1',
      proposed: { rows: { [sd._id]: { production: 1200, timer: '7:45:00', remarks: '' } } },
    });

    await request(app)
      .post('/api/v2/shift/bulk-enter-production')
      .set('Cookie', cookieFor(admin))
      .send({ aiSuggestionId: String(id), entries: [
        { id: String(sd._id), production: 1200, timer: '6:10:00' },
      ] });

    const row = await AiSuggestion.findById(id).lean();
    expect(row.editedFields).toEqual(['rows[].timer']);
  });

  test("a suggestion from another surface cannot be settled by this route", async () => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 42);
    const plan = await ShiftPlan.create({ date, shift: 'DAY' });
    const sd = await ShiftDetail.create({
      employee: employee._id, date, shift: 'DAY', status: 'open',
      machine: machine._id, shiftPlan: plan._id,
    });

    const qcId = await ledger.record({
      surface: 'qc-vision', model: 'v', promptVersion: 'v1',
      proposed: { overallResult: 'pass' },
    });

    const res = await request(app)
      .post('/api/v2/shift/bulk-enter-production')
      .set('Cookie', cookieFor(admin))
      .send({ aiSuggestionId: String(qcId), entries: [{ id: String(sd._id), production: 900 }] });

    // The shift still saves — the ledger is never allowed to block it.
    expect(res.body.saved).toBe(1);
    expect((await AiSuggestion.findById(qcId).lean()).outcome).toBe('proposed');
  });
});
