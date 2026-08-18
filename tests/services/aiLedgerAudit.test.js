'use strict';
// ══════════════════════════════════════════════════════════════════
//  AUDITING THE THING THAT AUDITS
//
//  The ledger's whole job is to be believed. A bug in it does not
//  announce itself: the acceptance rate is a plausible number either
//  way, and nobody can tell a real 71% from a 71% produced by a
//  comparison fault. So the failures worth hunting here are the ones
//  that leave a number looking exactly as reasonable as a correct one.
//
//  Six were found by reading it back. Each test below fails against the
//  code as first written.
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

const proposeQc = (proposed) => ledger.record({
  surface: 'qc-vision', model: 'v', promptVersion: 'v1', proposed,
});

// ══════════════════════════════════════════════════════════════════
//  F2 — a call that FAILED must never read as a clean acceptance
// ══════════════════════════════════════════════════════════════════
describe('settling a suggestion that never happened', () => {
  test('a failed model call cannot be settled into an acceptance', async () => {
    // diffFields returns [] the moment either side is null, and a failed
    // row has proposed: null. So settling one produced zero edits and
    // therefore outcome 'accepted' — counting a model call that ERRORED
    // as a suggestion the human took unchanged. It inflates acceptRate
    // in exactly the place it should be lowest, and nothing about the
    // resulting number looks wrong.
    const id = await ledger.record({
      surface: 'qc-vision', model: 'v', promptVersion: 'v1',
      error: 'overloaded_error: upstream 529',
    });

    await ledger.settle(id, { accepted: { overallResult: 'fail', defectCode: 'weave-fault' } });

    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('failed');
    expect(row.accepted).toBeNull();
  });

  test('settling with nothing does not count as agreement either', async () => {
    const id = await proposeQc({ overallResult: 'fail' });
    await ledger.settle(id, { accepted: null });
    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).not.toBe('accepted');
  });
});

// ══════════════════════════════════════════════════════════════════
//  F3 — a sheet verified in two passes
// ══════════════════════════════════════════════════════════════════
describe('a suggestion settled more than once', () => {
  test('a second pass adds to the first rather than replacing it', async () => {
    // 200 rows is more than one sitting. An operator who applies half
    // now and half after lunch sent two batches against one reading;
    // the second settle overwrote the first, so the corrections made
    // before lunch vanished and the rows verified before lunch reverted
    // to looking unverified.
    const id = await ledger.record({
      surface: 'shift-sheet-ocr', model: 'm', promptVersion: 'v1',
      proposed: { rows: {
        '68f1a2b3c4d5e6f708192a01': { production: 100, timer: '7:00:00' },
        '68f1a2b3c4d5e6f708192a02': { production: 200, timer: '7:00:00' },
      } },
    });

    // Before lunch: row 1, timer corrected.
    await ledger.settle(id, {
      accepted: { rows: { '68f1a2b3c4d5e6f708192a01': { production: 100, timer: '6:30:00' } } },
      ignoreMissing: true,
    });
    // After lunch: row 2, taken as read.
    await ledger.settle(id, {
      accepted: { rows: { '68f1a2b3c4d5e6f708192a02': { production: 200, timer: '7:00:00' } } },
      ignoreMissing: true,
    });

    const row = await AiSuggestion.findById(id).lean();
    expect(Object.keys(row.accepted.rows)).toHaveLength(2);
    // The morning's correction survives the afternoon's batch.
    expect(row.editedFields).toEqual(['rows[].timer']);
    expect(row.outcome).toBe('edited');
  });

  test('re-sending the same batch changes nothing', async () => {
    const id = await proposeQc({ defectCode: 'weave-fault' });
    await ledger.settle(id, { accepted: { defectCode: 'contamination' } });
    await ledger.settle(id, { accepted: { defectCode: 'contamination' } });

    const row = await AiSuggestion.findById(id).lean();
    expect(row.outcome).toBe('edited');
    expect(row.editedFields).toEqual(['defectCode']);
  });
});

// ══════════════════════════════════════════════════════════════════
//  F4 — an id from one surface must not settle another
// ══════════════════════════════════════════════════════════════════
describe('the id is checked against the surface that claims it', () => {
  test('a QC id sent to the shift-sheet route settles nothing', async () => {
    // The id arrives in a request body, so it is whatever the client
    // says it is. Settling on it blind means a stale or copy-pasted id
    // silently writes one surface's answer onto another's row — and
    // both surfaces' numbers are then wrong with nothing to show for it.
    const qcId = await proposeQc({ overallResult: 'pass' });

    await ledger.settle(qcId, {
      expectSurface: 'shift-sheet-ocr',
      accepted: { rows: { a: { production: 1 } } },
    });

    const row = await AiSuggestion.findById(qcId).lean();
    expect(row.outcome).toBe('proposed');
    expect(row.accepted).toBeNull();
  });

  test('the matching surface settles as normal', async () => {
    const qcId = await proposeQc({ overallResult: 'pass' });
    await ledger.settle(qcId, { expectSurface: 'qc-vision', accepted: { overallResult: 'pass' } });
    expect((await AiSuggestion.findById(qcId).lean()).outcome).toBe('accepted');
  });
});

// ══════════════════════════════════════════════════════════════════
//  F5 — a date must survive being recorded
// ══════════════════════════════════════════════════════════════════
describe('trim and the values it does not recognise', () => {
  test('a Date is kept, not flattened to an empty object', () => {
    // typeof new Date() is 'object' and Object.entries(date) is [], so a
    // date in a payload became {} — present, plausible, and empty. The
    // planner's objective and any future surface carrying a due date
    // would record nothing and nobody would see a gap.
    const out = ledger.trim({ dueDate: new Date('2026-08-20T00:00:00.000Z'), qty: 5 });
    expect(out.dueDate).toBe('2026-08-20T00:00:00.000Z');
    expect(out.qty).toBe(5);
  });

  test('a date compares as itself', () => {
    const d = new Date('2026-08-20T00:00:00.000Z');
    expect(ledger.diffFields(ledger.trim({ d }), ledger.trim({ d: new Date(d) }))).toEqual([]);
  });
});
