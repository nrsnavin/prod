'use strict';
// ══════════════════════════════════════════════════════════════════
//  NOT INVENTING PATTERNS OUT OF NINE COMPLAINTS
//
//  This surface is unusual: its most important behaviour is REFUSING to
//  produce output. Hand a language model twelve complaints and ask for
//  themes and it returns four, confidently, because that is what it was
//  asked for — and all four are artefacts of twelve sentences. They
//  then get quoted in a meeting and a process changes.
//
//  So the first block of tests is about the volume floor, and the
//  distinction it protects: "no themes found" and "not enough data to
//  look for themes" are different claims and only one of them is true
//  below the floor.
//
//  The second block is about the model not being allowed to state a
//  fact. It returns a grouping; every count comes from len() of that
//  grouping. A model asked for a theme AND its frequency will produce a
//  plausible frequency, and a plausible frequency is indistinguishable
//  from a real one once it is on a page.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

// The fake model. `mockReply` is swapped per test; `mockCalls` proves whether
// the model was reached at all, which is the assertion the volume-floor
// tests actually need.
const mockCalls = [];
let mockReply = null;
let mockThrow = null;

jest.mock('../../utils/anthropicClient', () => ({
  TEXT_MODEL: 'test-model',
  VISION_MODEL: 'test-vision',
  isPinned: () => true,
  anthropic: () => ({
    messages: {
      create: async (args) => {
        mockCalls.push(args);
        if (mockThrow) throw mockThrow;
        return {
          content: [{ type: 'text', text: mockReply }],
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    },
  }),
}));

let mongo, themes, Complaint, AiSuggestion;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  themes       = require('../../services/complaintThemes');
  Complaint    = require('../../models/Complaints');
  AiSuggestion = require('../../models/AiSuggestion');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  mockCalls.length = 0;
  mockReply = null;
  mockThrow = null;
});

const oid = () => new mongoose.Types.ObjectId();

/** n complaints, spread across two categories, each with distinct text. */
async function seed(n, { category = 'shade', daysAgo = 1 } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({
    customer: oid(), job: oid(), category,
    reason: `Complaint number ${i}: the shade drifts across the width`,
    date: new Date(Date.now() - daysAgo * 86400_000),
  }));
  return Complaint.insertMany(rows);
}

// ══════════════════════════════════════════════════════════════════
//  The volume floor
// ══════════════════════════════════════════════════════════════════
describe('the volume floor', () => {
  test('below the floor, no themes are produced and the model is never called', async () => {
    await seed(9);
    const out = await themes.analyse({ days: 365 });

    expect(out.total).toBe(9);
    expect(out.belowThreshold).toBe(true);
    // null, NOT []. An empty array reads as "we looked and found
    // nothing", which is a claim this has not earned.
    expect(out.themes).toBeNull();
    expect(out.note).toMatch(/not produced below/i);
    expect(mockCalls).toHaveLength(0);
  });

  test('the counts are still exact below the floor — they are the day-one product', async () => {
    await seed(4, { category: 'shade' });
    await seed(3, { category: 'width' });
    const out = await themes.analyse({ days: 365 });

    expect(out.total).toBe(7);
    expect(out.byCategory.shade).toBe(4);
    expect(out.byCategory.width).toBe(3);
    // Categories with nothing in them are reported as zero rather than
    // omitted: a reader scanning for "strength" must be able to tell
    // "none" from "the row is missing".
    expect(out.byCategory.strength).toBe(0);
  });

  test('at the floor, the model is called', async () => {
    await seed(25);
    mockReply = JSON.stringify({ themes: [{ label: 'shade drift', members: [0, 1, 2] }] });
    const out = await themes.analyse({ days: 365 });

    expect(mockCalls).toHaveLength(1);
    expect(out.belowThreshold).toBeUndefined();
    expect(out.themes).toHaveLength(1);
  });

  test('enough complaints but not enough TEXT is still below the floor', async () => {
    // A row with no prose cannot be grouped. Counting it toward the
    // floor would let 30 blank complaints unlock theming over none.
    //
    // Written through the driver rather than the model on purpose: the
    // schema trims `reason` and requires it, so this row cannot be
    // created through the API. It is what a legacy row or a direct
    // write looks like, which is the only way the guard is ever reached
    // — and a guard that can only be reached by data the tests cannot
    // produce is a guard nobody has checked.
    await mongoose.connection.collection('complaints').insertMany(
      Array.from({ length: 30 }, () => ({
        customer: oid(), job: oid(), category: 'other', reason: '   ',
        feedback: '', status: 'Open', date: new Date(),
      }))
    );
    const out = await themes.analyse({ days: 365 });

    expect(out.total).toBe(30);
    expect(out.themes).toBeNull();
    expect(out.belowThreshold).toBe(true);
    expect(mockCalls).toHaveLength(0);
  });

  test('complaints outside the window do not count toward the floor', async () => {
    await seed(30, { daysAgo: 400 });
    const out = await themes.analyse({ days: 365 });

    expect(out.total).toBe(0);
    expect(out.note).toMatch(/no complaints recorded/i);
    expect(mockCalls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  The model returns a grouping, never a number
// ══════════════════════════════════════════════════════════════════
describe('what the model is allowed to assert', () => {
  test('a count the model states is ignored; the real one is counted here', async () => {
    await seed(25);
    mockReply = JSON.stringify({
      themes: [{ label: 'shade drift', members: [0, 1, 2], count: 900, sharePct: 99 }],
    });
    const out = await themes.analyse({ days: 365 });

    expect(out.themes[0].count).toBe(3);
    expect(out.themes[0].sharePct).toBe(12);   // 3 of 25
  });

  test('a member index outside the sample is dropped, not trusted', async () => {
    await seed(25);
    mockReply = JSON.stringify({
      themes: [{ label: 'shade drift', members: [0, 1, 999, -4, 'x'] }],
    });
    const out = await themes.analyse({ days: 365 });

    expect(out.themes[0].count).toBe(2);
    expect(out.themes[0].complaintIds).toHaveLength(2);
  });

  test('a complaint claimed by two themes is counted once, in the first', async () => {
    await seed(25);
    mockReply = JSON.stringify({
      themes: [
        { label: 'shade drift', members: [0, 1, 2] },
        { label: 'width', members: [2, 3] },
      ],
    });
    const out = await themes.analyse({ days: 365 });

    const total = out.themes.reduce((s, t) => s + t.count, 0);
    expect(total).toBe(4);
    expect(out.themes.find((t) => t.label === 'width').count).toBe(1);
  });

  test('a theme with no valid members is dropped entirely', async () => {
    await seed(25);
    mockReply = JSON.stringify({
      themes: [
        { label: 'real', members: [0, 1] },
        { label: 'invented', members: [500, 501] },
        { label: '', members: [2] },
      ],
    });
    const out = await themes.analyse({ days: 365 });

    expect(out.themes.map((t) => t.label)).toEqual(['real']);
  });

  test('complaints in no theme are reported as ungrouped', async () => {
    // A themes list covering 3 of 25 is a different object from one
    // covering 24 of 25, and the reader cannot tell them apart without
    // this number.
    await seed(25);
    mockReply = JSON.stringify({ themes: [{ label: 'shade drift', members: [0, 1, 2] }] });
    const out = await themes.analyse({ days: 365 });

    expect(out.sampled).toBe(25);
    expect(out.ungrouped).toBe(22);
  });

  test('themes come back strongest first', async () => {
    await seed(25);
    mockReply = JSON.stringify({
      themes: [
        { label: 'small', members: [0] },
        { label: 'big', members: [1, 2, 3, 4] },
        { label: 'medium', members: [5, 6] },
      ],
    });
    const out = await themes.analyse({ days: 365 });
    expect(out.themes.map((t) => t.label)).toEqual(['big', 'medium', 'small']);
  });
});

// ══════════════════════════════════════════════════════════════════
//  When the model does not cooperate
// ══════════════════════════════════════════════════════════════════
describe('failure', () => {
  test('unparseable output yields no themes and does not throw', async () => {
    await seed(25);
    mockReply = 'Sure! Here are the themes I found: mostly shade issues.';
    const out = await themes.analyse({ days: 365 });

    expect(out.themes).toBeNull();
    expect(out.aiGenerated).toBe(false);
    // The counts are unaffected — they never depended on the model.
    expect(out.total).toBe(25);
    expect(out.note).toMatch(/did not return a usable answer/i);
  });

  test('a fenced JSON block is accepted', async () => {
    await seed(25);
    mockReply = '```json\n{"themes":[{"label":"shade drift","members":[0,1]}]}\n```';
    const out = await themes.analyse({ days: 365 });
    expect(out.themes).toHaveLength(1);
  });

  test('a thrown call is recorded as a failure, not swallowed silently', async () => {
    // The disease the whole ledger exists to cure: a surface that fails
    // into console.warn looks exactly like a surface nobody uses.
    await seed(25);
    mockThrow = new Error('upstream 529');
    const out = await themes.analyse({ days: 365 });

    expect(out.themes).toBeNull();
    const rows = await AiSuggestion.find({ surface: 'complaint-themes' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].error).toMatch(/529/);
  });

  test('a successful pass is recorded in the ledger with its cost', async () => {
    await seed(25);
    mockReply = JSON.stringify({ themes: [{ label: 'shade drift', members: [0, 1] }] });
    await themes.analyse({ days: 365 });

    const rows = await AiSuggestion.find({ surface: 'complaint-themes' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('proposed');
    expect(rows[0].inputTokens).toBe(10);
    expect(rows[0].outputTokens).toBe(20);
    expect(rows[0].promptVersion).toBe('v1.0');
  });

  test('unparseable output is recorded too — a silent no-op is the thing to avoid', async () => {
    await seed(25);
    mockReply = 'no json here';
    await themes.analyse({ days: 365 });

    const rows = await AiSuggestion.find({ surface: 'complaint-themes' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
  });
});

// ══════════════════════════════════════════════════════════════════
//  Windowing and text handling
// ══════════════════════════════════════════════════════════════════
describe('inputs', () => {
  test('a nonsense window falls back to a year rather than returning nothing', async () => {
    await seed(5);
    for (const bad of [0, -30, NaN, 'abc', undefined]) {
      const out = await themes.analyse({ days: bad });
      expect(out.windowDays).toBe(365);
      expect(out.total).toBe(5);
    }
  });

  test('long prose is truncated before it reaches the model', async () => {
    const long = 'x'.repeat(2000);
    expect(themes.textOf({ reason: long, feedback: '' }).length).toBeLessThanOrEqual(401);
  });

  test('reason and feedback are both given to the model', async () => {
    const t = themes.textOf({ reason: 'Shade band', feedback: 'Third roll only' });
    expect(t).toBe('Shade band — Third roll only');
  });
});
