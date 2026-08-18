'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE VISION SURFACE, END TO END, WITHOUT CALLING A MODEL
//
//  classifyDefect is stubbed here. That is not a shortcut — the point
//  of these tests is the route's BOOKKEEPING, and a live model would
//  make every assertion non-deterministic while proving nothing extra
//  about the code under test.
//
//  Three outcomes the route has to distinguish, and used not to:
//
//    • the model answered and the inspector agreed        → accepted
//    • the model answered and the inspector changed it    → edited
//    • the model answered with something unparseable      → failed
//
//  The third was returned to the client as a polite "couldn't read the
//  image confidently" and recorded nowhere. A vision model that had
//  started replying in prose instead of JSON would look, from every
//  angle available to a person, exactly like a feature nobody used.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../../utils/qcVision', () => ({
  classifyDefect: jest.fn(),
  SUPPORTED: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
}));

const request  = require('supertest');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { classifyDefect } = require('../../utils/qcVision');

let mongo, app, AiSuggestion, Elastic, JobOrder, Customer, Order, User;
let admin, elastic, job;

const cookie = () => [`token=${jwt.sign({ id: admin._id, role: 'admin' }, process.env.JWT_SECRET_KEY)}`];

// A one-pixel PNG — the route only needs a buffer with a real mimetype.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const draft = (over = {}) => ({
  available: true, ok: true,
  overallResult: 'fail', confidence: 82, defectCode: 'weave-fault',
  rejectedMetersHint: 12,
  results: [{ parameter: 'Width (mm)', expected: '20', measured: '19', pass: false }],
  notes: 'visible weave fault mid-roll',
  ...over,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  app          = require('../../app.js');
  AiSuggestion = require('../../models/AiSuggestion');
  Elastic      = require('../../models/Elastic');
  JobOrder     = require('../../models/JobOrder');
  Customer     = require('../../models/Customer');
  Order        = require('../../models/Order');
  User         = require('../../models/User');

  admin = await User.create({
    name: 'QC Admin', email: 'qc-ledger@t.co', password: 'pass1234',
    role: 'admin', department: 'admin',
  });
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

let seq = 0;
beforeEach(async () => {
  classifyDefect.mockReset();
  elastic = await Elastic.create({
    name: `20mm-qc-${seq++}`, weaveType: '8', spandexEnds: 40,
    yarnEnds: 120, pick: 12, noOfHook: 8, weight: 2.4,
    testingParameters: { width: 20, elongation: 160 },
  });
  const customer = await Customer.create({ name: `Acme ${seq}`, contactName: 'R', phoneNumber: '9000000002' });
  const order = await Order.create({
    customer: customer._id, po: `PO-QC-${seq}`, date: new Date(), supplyDate: new Date(),
    status: 'Approved',
    elasticOrdered: [{ elastic: elastic._id, quantity: 1000, rate: 10 }],
  });
  job = await JobOrder.create({
    order: order._id, customer: customer._id, date: new Date(), status: 'weaving',
  });
});

afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) {
    if (c.collectionName !== 'users') await c.deleteMany({});
  }
});

const visionDraft = () => request(app)
  .post('/api/v2/qc/vision-draft')
  .set('Cookie', cookie())
  .field('elasticId', String(elastic._id))
  .attach('image', PIXEL, { filename: 's.png', contentType: 'image/png' });

const createCheck = (body) => request(app)
  .post('/api/v2/qc/create').set('Cookie', cookie()).send(body);

// ══════════════════════════════════════════════════════════════════
//  1. THE THREE OUTCOMES
// ══════════════════════════════════════════════════════════════════
describe('the vision draft is recorded whatever happens to it', () => {
  test('a draft the inspector applies unchanged is an acceptance', async () => {
    classifyDefect.mockResolvedValue(draft());
    const d = await visionDraft();
    expect(d.body.aiSuggestionId).toBeTruthy();

    await createCheck({
      jobId: String(job._id), elasticId: String(elastic._id),
      results: d.body.draft.results,
      defectCode: d.body.draft.defectCode,
      rejectedMeters: d.body.draft.rejectedMetersHint,
      aiAssisted: true, aiSuggestionId: d.body.aiSuggestionId,
    });

    const row = await AiSuggestion.findById(d.body.aiSuggestionId).lean();
    expect(row.outcome).toBe('accepted');
    expect(row.editedFields).toEqual([]);
  });

  test('the defect class the inspector overrides is named', async () => {
    classifyDefect.mockResolvedValue(draft());
    const d = await visionDraft();

    await createCheck({
      jobId: String(job._id), elasticId: String(elastic._id),
      results: d.body.draft.results,
      defectCode: 'contamination',              // the inspector disagreed
      rejectedMeters: 12,
      aiAssisted: true, aiSuggestionId: d.body.aiSuggestionId,
    });

    const row = await AiSuggestion.findById(d.body.aiSuggestionId).lean();
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(['defectCode']);
  });

  test('a reply the parser could not read is recorded as a failure', async () => {
    // The route answered "couldn't read the image confidently — fill the
    // check manually" and wrote nothing anywhere. A model that had
    // started replying in prose would show up as silence.
    classifyDefect.mockResolvedValue({ available: true, ok: false });

    const res = await visionDraft();
    expect(res.body.ok).toBe(false);

    const rows = await AiSuggestion.find({ surface: 'qc-vision' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].error).toMatch(/pars|read/i);
  });

  test('a thrown vision error is recorded too', async () => {
    classifyDefect.mockRejectedValue(new Error('upstream 529'));
    await visionDraft();

    const rows = await AiSuggestion.find({ surface: 'qc-vision' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].error).toMatch(/529/);
  });

  test('an unconfigured key is not recorded as a failure of the model', async () => {
    // No key means no call was made. Counting it against the surface
    // would make "the AI is failing" the answer to "the AI is off".
    classifyDefect.mockResolvedValue({ available: false });
    await visionDraft();
    expect(await AiSuggestion.countDocuments({})).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. THE LEDGER NEVER BREAKS THE CHECK
// ══════════════════════════════════════════════════════════════════
describe('QC saves survive a broken ledger', () => {
  test('a failed ledger write does not cost the inspector their check', async () => {
    classifyDefect.mockResolvedValue(draft());
    const d = await visionDraft();

    const spy = jest.spyOn(AiSuggestion, 'findById').mockImplementationOnce(() => {
      throw new Error('ledger unavailable');
    });

    const res = await createCheck({
      jobId: String(job._id), elasticId: String(elastic._id),
      results: [{ parameter: 'Width (mm)', expected: '20', measured: '19', pass: false }],
      defectCode: 'weave-fault', rejectedMeters: 12,
      aiAssisted: true, aiSuggestionId: d.body.aiSuggestionId,
    });

    expect(res.status).toBe(201);
    expect(res.body.record).toBeTruthy();
    spy.mockRestore();
  });

  test('a garbage suggestion id is ignored, not fatal', async () => {
    const res = await createCheck({
      jobId: String(job._id), elasticId: String(elastic._id),
      results: [{ parameter: 'Width (mm)', expected: '20', measured: '20', pass: true }],
      aiSuggestionId: 'not-an-object-id',
    });
    expect(res.status).toBe(201);
  });
});
