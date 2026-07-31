'use strict';

const {
  JOB_STATUSES,
  STATUS_TRANSITIONS,
  GATED_TRANSITIONS,
  STAGE_TIMESTAMPS,
  nextStatus,
  validateTransition,
  stampStage,
  enteredAtField,
} = require('../../domain/jobStatus');

describe('domain/jobStatus', () => {
  describe('nextStatus', () => {
    test('returns the next stage in the linear flow', () => {
      expect(nextStatus('preparatory')).toBe('weaving');
      expect(nextStatus('weaving')).toBe('finishing');
      expect(nextStatus('finishing')).toBe('checking');
      expect(nextStatus('checking')).toBe('packing');
      expect(nextStatus('packing')).toBe('completed');
    });
    test('returns null for terminal statuses', () => {
      expect(nextStatus('completed')).toBeNull();
      expect(nextStatus('cancelled')).toBeNull();
      expect(nextStatus('nonsense')).toBeNull();
    });
  });

  describe('validateTransition — messages match the legacy route', () => {
    test('ok on the expected next stage', () => {
      expect(validateTransition('weaving', 'finishing')).toEqual({
        ok: true, expected: 'finishing', gate: null,
      });
    });
    // preparatory → weaving is shaped right but conditional: the route
    // must still prove warping and covering are both done. The gate name
    // is what tells it to.
    test('preparatory → weaving is allowed but flagged as gated', () => {
      expect(validateTransition('preparatory', 'weaving')).toEqual({
        ok: true, expected: 'weaving', gate: 'weaving-readiness',
      });
    });
    test('rejects a status that cannot advance further', () => {
      const r = validateTransition('completed', 'weaving');
      expect(r.ok).toBe(false);
      expect(r.message).toBe('Job in status "completed" cannot advance further');
    });
    test('rejects a wrong target with the expected value in the message', () => {
      const r = validateTransition('weaving', 'checking');
      expect(r.ok).toBe(false);
      expect(r.message).toBe('Invalid transition: "weaving" → "checking". Expected: "finishing"');
    });
  });

  describe('stampStage', () => {
    test('sets the by/at fields for a known stage', () => {
      const job = {};
      stampStage(job, 'finishing', 'user1');
      expect(job.finishingBy).toBe('user1');
      expect(job.finishingAt).toBeInstanceOf(Date);
    });
    test('defaults by to null when no userId', () => {
      const job = {};
      stampStage(job, 'packing');
      expect(job.packingBy).toBeNull();
      expect(job.packingAt).toBeInstanceOf(Date);
    });
    test('no-op for a stage with no timestamp mapping', () => {
      const job = {};
      stampStage(job, 'preparatory', 'u');
      expect(Object.keys(job)).toHaveLength(0);
    });
  });

  describe('enteredAtField', () => {
    test('maps a stage to its timestamp field', () => {
      expect(enteredAtField('weaving')).toBe('weavingAt');
      expect(enteredAtField('packing')).toBe('packingAt');
    });
    test('returns null for preparatory (no stage timestamp)', () => {
      expect(enteredAtField('preparatory')).toBeNull();
    });
  });

  describe('constants', () => {
    test('every transition source and target is a known status', () => {
      for (const [from, to] of Object.entries(STATUS_TRANSITIONS)) {
        expect(JOB_STATUSES).toContain(from);
        expect(JOB_STATUSES).toContain(to);
      }
    });
    test('every STAGE_TIMESTAMPS key is a known status', () => {
      for (const stage of Object.keys(STAGE_TIMESTAMPS)) {
        expect(JOB_STATUSES).toContain(stage);
      }
    });
    test('every gated transition is a real transition', () => {
      for (const from of Object.keys(GATED_TRANSITIONS)) {
        expect(STATUS_TRANSITIONS[from]).toBeDefined();
      }
    });
    test('tables are frozen (single source of truth, not mutated at runtime)', () => {
      expect(Object.isFrozen(STATUS_TRANSITIONS)).toBe(true);
      expect(Object.isFrozen(GATED_TRANSITIONS)).toBe(true);
      expect(Object.isFrozen(STAGE_TIMESTAMPS)).toBe(true);
    });
  });
});
