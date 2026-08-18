'use strict';
// ══════════════════════════════════════════════════════════════════
//  MEASURING THE AI SURFACES
//
//  Five features in this system ask a model a question and show a human
//  the answer. Until this ledger existed, every one of them threw the
//  answer away the moment somebody corrected it: the domain document
//  kept the corrected value, and the fact that a correction had
//  happened was gone. Which meant the plainest question about any of
//  them — "is it working?" — had no answer anywhere in the codebase.
//
//  These tests hold the ledger to the four things that make it worth
//  keeping:
//
//    1. It never breaks the feature it measures. A telemetry write that
//       can 500 a QC save is worse than no telemetry.
//    2. It is honest about what a human did. "1200" saved as 1200 is
//       not a correction; a row nobody looked at is not a rejection.
//    3. It bounds what it stores. This is a measurement, not a second
//       copy of the shift sheet.
//    4. The rate it reports counts DECIDED suggestions only, so the
//       number moves with model quality and not with how promptly the
//       floor gets round to reviewing.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let mongo, ledger, AiSuggestion;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  ledger       = require('../../services/aiLedger');
  AiSuggestion = require('../../models/AiSuggestion');
}, 180_000);

afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

afterEach(async () => { await AiSuggestion.deleteMany({}); });

const { trim, diffFields, collapsePath } = require('../../services/aiLedger');

// ══════════════════════════════════════════════════════════════════
//  1. THE DIFF — what counts as a human correction
// ══════════════════════════════════════════════════════════════════
describe('diffFields', () => {
  test('a number that arrives as a string and is saved as a number is NOT an edit', () => {
    // The OCR returns "1200"; the route saves Number("1200"). Counting
    // that as a correction would bury the real ones under type noise.
    expect(diffFields({ production: '1200' }, { production: 1200 })).toEqual([]);
  });

  test('a genuine change is reported at its full path', () => {
    expect(diffFields(
      { rows: { a: { production: 1200, timer: '7:45:00' } } },
      { rows: { a: { production: 1240, timer: '7:45:00' } } },
    )).toEqual(['rows.a.production']);
  });

  test('arrays are compared element-wise, and a length change is itself the finding', () => {
    expect(diffFields({ r: [{ pass: true }, { pass: true }] },
                      { r: [{ pass: true }, { pass: false }] }))
      .toEqual(['r[1].pass']);
    expect(diffFields({ r: [1, 2, 3] }, { r: [1, 2] })).toEqual(['r']);
  });

  test('ignoreMissing: a row the human never submitted is not a disagreement', () => {
    const proposed = { rows: { a: { production: 10 }, b: { production: 20 } } };
    const accepted = { rows: { a: { production: 10 } } };

    // Without the flag, row b reads as a rejection of the OCR.
    expect(diffFields(proposed, accepted)).toEqual(['rows.b']);
    // With it, the untouched row is simply undecided — which it is.
    expect(diffFields(proposed, accepted, '', { ignoreMissing: true })).toEqual([]);
  });

  test('ignoreMissing does not hide a field the human blanked', () => {
    // null is a value somebody chose. undefined is a row they never
    // reached. Only the second is excused.
    expect(diffFields({ rows: { a: { timer: '7:00:00' } } },
                      { rows: { a: { timer: null } } },
                      '', { ignoreMissing: true }))
      .toEqual(['rows.a.timer']);
  });
});

// ══════════════════════════════════════════════════════════════════
//  2. PATH COLLAPSING — the difference between a list and a finding
// ══════════════════════════════════════════════════════════════════
describe('collapsePath', () => {
  test('document ids and array indices collapse to the shape of the path', () => {
    expect(collapsePath('rows.68f1a2b3c4d5e6f708192a3b.timer')).toBe('rows[].timer');
    expect(collapsePath('results[7].measured')).toBe('results[].measured');
    expect(collapsePath('overallResult')).toBe('overallResult');
  });

  test('two corrections to the same column report as one weakness, not two rows', async () => {
    // This is the whole point. Uncollapsed, a sheet where three timers
    // were fixed produces three unique strings, and the weakest-field
    // report reads "no field is ever wrong twice".
    const id = await ledger.record({
      surface: 'shift-sheet-ocr', model: 'm', promptVersion: 'v1',
      proposed: { rows: {
        '68f1a2b3c4d5e6f708192a01': { production: 100, timer: '7:00:00' },
        '68f1a2b3c4d5e6f708192a02': { production: 200, timer: '7:00:00' },
      } },
    });
    await ledger.settle(id, { accepted: { rows: {
      '68f1a2b3c4d5e6f708192a01': { production: 100, timer: '6:30:00' },
      '68f1a2b3c4d5e6f708192a02': { production: 200, timer: '6:15:00' },
    } } });

    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(['rows[].timer']);
  });
});

// ══════════════════════════════════════════════════════════════════
//  3. TRIMMING — a measurement, not a second copy of the data
// ══════════════════════════════════════════════════════════════════
describe('trim', () => {
  test('a long string is cut and its true length kept', () => {
    const out = trim('x'.repeat(5000));
    expect(out.length).toBeLessThan(2100);
    expect(out).toMatch(/\[5000\]$/);
  });

  test('a long array keeps a head and its count', () => {
    const out = trim(Array.from({ length: 500 }, (_, i) => i));
    expect(out._truncated).toBe(true);
    expect(out.length).toBe(500);
    expect(out.head).toHaveLength(50);
  });

  test('an image never reaches the ledger, whatever key it arrives under', () => {
    const out = trim({ image: 'data:image/png;base64,AAAA', base64: 'AAAA', notes: 'ok' });
    expect(out.image).toBe('[omitted]');
    expect(out.base64).toBe('[omitted]');
    expect(out.notes).toBe('ok');
  });

  test('a buffer is summarised, not stored', () => {
    expect(trim(Buffer.alloc(1024))).toBe('[buffer 1024b]');
  });

  test('a very wide object is bounded — a shift sheet is keyed, not listed', () => {
    const wide = {};
    for (let i = 0; i < 600; i++) wide[`k${i}`] = i;
    const out = trim(wide);
    expect(Object.keys(out)).toHaveLength(401);   // 400 keys + _truncatedKeys
    expect(out._truncatedKeys).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════
//  4. RECORD / SETTLE
// ══════════════════════════════════════════════════════════════════
describe('record and settle', () => {
  test('a suggestion starts as proposed and carries its telemetry', async () => {
    const id = await ledger.record({
      surface: 'qc-vision', model: 'vision-x', promptVersion: 'v1.0',
      proposed: { overallResult: 'fail', defectCode: 'weave-fault' },
      latencyMs: 812, usage: { input_tokens: 900, output_tokens: 120 },
    });
    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('proposed');
    expect(row.promptVersion).toBe('v1.0');
    expect(row.latencyMs).toBe(812);
    expect(row.inputTokens).toBe(900);
    expect(row.outputTokens).toBe(120);
  });

  test('a failed model call is recorded as failed, with no proposal', async () => {
    // The failure path used to be a console.warn. A surface broken for a
    // fortnight looked exactly like a surface nobody was using.
    const id = await ledger.record({
      surface: 'planner-rationale', model: 'text-x', promptVersion: 'v1.0',
      proposed: { rationale: 'should not be kept' },
      error: 'overloaded_error: upstream 529',
    });
    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('failed');
    expect(row.proposed).toBeNull();
    expect(row.error).toMatch(/529/);
  });

  test('applied unchanged → accepted; one field touched → edited', async () => {
    const mk = () => ledger.record({
      surface: 'qc-vision', model: 'v', promptVersion: 'v1',
      proposed: { overallResult: 'fail', defectCode: 'weave-fault', rejectedMeters: 12 },
    });

    const clean = await mk();
    await ledger.settle(clean, { accepted: { overallResult: 'fail', defectCode: 'weave-fault', rejectedMeters: 12 } });
    expect((await AiSuggestion.findById(clean).lean()).outcome).toBe('accepted');

    const touched = await mk();
    await ledger.settle(touched, { accepted: { overallResult: 'fail', defectCode: 'contamination', rejectedMeters: 12 } });
    const row = await AiSuggestion.findById(touched).lean();
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(['defectCode']);
  });

  test('the outcome is derived, not taken from the caller', async () => {
    // A route that believes it applied the draft unchanged, but changed
    // a field, is an edit whatever it believes.
    const id = await ledger.record({
      surface: 'qc-vision', model: 'v', promptVersion: 'v1',
      proposed: { overallResult: 'pass' },
    });
    await ledger.settle(id, { accepted: { overallResult: 'fail' } });
    expect((await AiSuggestion.findById(id).lean()).outcome).toBe('edited');
  });

  test('an explicit outcome skips the diff, for surfaces with nothing to compare', async () => {
    // A narrative rationale is acted on or it isn't. Diffing it would
    // report "the human edited `rationale`" every time, purely because
    // the client never sends prose back.
    const id = await ledger.record({
      surface: 'planner-rationale', model: 't', promptVersion: 'v1',
      proposed: { rationale: '- sequence by due date', objective: { late: 2 } },
    });
    await ledger.settle(id, { outcome: 'accepted' });
    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('accepted');
    expect(row.editedFields).toEqual([]);
    expect(row.decidedAt).toBeInstanceOf(Date);
  });

  test('rejected is recorded as rejected', async () => {
    const id = await ledger.record({ surface: 'qc-vision', model: 'v', promptVersion: 'v1', proposed: { a: 1 } });
    await ledger.settle(id, { rejected: true });
    expect((await AiSuggestion.findById(id).lean()).outcome).toBe('rejected');
  });

  // ── The rule that matters most ──────────────────────────────────
  test('a broken ledger returns null instead of throwing', async () => {
    // Measuring a thing must not be able to break it. An invalid surface
    // fails the enum; the caller gets null and the FEATURE still works.
    await expect(ledger.record({ surface: 'not-a-surface', model: 'x' })).resolves.toBeNull();
    await expect(ledger.settle('not-an-id', { accepted: {} })).resolves.toBeNull();
    await expect(ledger.settle(null, { accepted: {} })).resolves.toBeNull();
  });

  test('settling an id that no longer exists is a no-op, not an error', async () => {
    const gone = new mongoose.Types.ObjectId();
    await expect(ledger.settle(gone, { accepted: {} })).resolves.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
//  5. STATS — the number nobody could quote before
// ══════════════════════════════════════════════════════════════════
describe('stats', () => {
  const seed = async (surface, outcomes) => {
    for (const o of outcomes) {
      await AiSuggestion.create({ surface, model: 'm', promptVersion: 'v1', outcome: o, latencyMs: 100 });
    }
  };

  test('acceptRate counts decided rows only — pending is not evidence either way', async () => {
    // 2 accepted, 1 edited, 1 rejected, 4 still awaiting a human.
    // Folding the pending rows in would make the figure move with how
    // promptly the floor reviews rather than with model quality.
    await seed('qc-vision', ['accepted', 'accepted', 'edited', 'rejected',
                             'proposed', 'proposed', 'proposed', 'proposed']);
    const [s] = await ledger.stats({ days: 30 });
    expect(s.surface).toBe('qc-vision');
    expect(s.total).toBe(8);
    expect(s.decided).toBe(4);
    expect(s.pending).toBe(4);
    expect(s.acceptRate).toBe(50);   // 2 of 4 decided, clean
    expect(s.usefulRate).toBe(75);   // 3 of 4 were worth having
  });

  test('failures are counted but never fold into the acceptance figure', async () => {
    await seed('advisor-briefing', ['failed', 'failed', 'accepted']);
    const [s] = await ledger.stats({ days: 30 });
    expect(s.failed).toBe(2);
    expect(s.decided).toBe(1);
    expect(s.acceptRate).toBe(100);
  });

  test('a surface with nothing decided reports null, not zero', async () => {
    // 0% and "no data" are different claims, and only one of them is true.
    await seed('assistant-answer', ['proposed', 'proposed']);
    const [s] = await ledger.stats({ days: 30 });
    expect(s.acceptRate).toBeNull();
    expect(s.usefulRate).toBeNull();
  });

  test('the window is honoured', async () => {
    const old = await AiSuggestion.create({ surface: 'qc-vision', model: 'm', outcome: 'accepted' });
    // Straight through the driver: mongoose would stamp createdAt back
    // to now on the way past.
    await AiSuggestion.collection.updateOne({ _id: old._id },
      { $set: { createdAt: new Date(Date.now() - 90 * 86_400_000) } });
    expect(await ledger.stats({ days: 30 })).toHaveLength(0);
    expect(await ledger.stats({ days: 365 })).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════
//  6. WEAK FIELDS — the actionable half
// ══════════════════════════════════════════════════════════════════
describe('weakFields', () => {
  test('ranks the columns that keep needing a human', async () => {
    const mk = (fields) => AiSuggestion.create({
      surface: 'shift-sheet-ocr', model: 'm', outcome: 'edited', editedFields: fields,
    });
    await mk(['rows[].timer']);
    await mk(['rows[].timer', 'rows[].production']);
    await mk(['rows[].timer']);

    const out = await ledger.weakFields({ days: 30 });
    expect(out[0]).toMatchObject({ surface: 'shift-sheet-ocr', field: 'rows[].timer', suggestions: 3 });
    expect(out[1]).toMatchObject({ field: 'rows[].production', suggestions: 1 });
  });

  test('only edited rows count — an accepted suggestion has no weakness to report', async () => {
    await AiSuggestion.create({ surface: 'qc-vision', model: 'm', outcome: 'accepted', editedFields: ['defectCode'] });
    expect(await ledger.weakFields({ days: 30 })).toEqual([]);
  });
});
