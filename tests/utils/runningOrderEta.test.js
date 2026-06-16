'use strict';

const {
  estimateJobCompletion,
  estimateRunningOrderEta,
  FINISH_BUFFER_WORKING_DAYS,
} = require('../../utils/runningOrderEta.js');
const C = require('../../utils/etaConfig.js');

// Fix "today" on a Monday so date math is deterministic. 2026-06-15 is a Monday.
const MON_2026_06_15 = new Date('2026-06-15T00:00:00Z');

describe('runningOrderEta.estimateJobCompletion', () => {
  test('single elastic — shifts derived from heads × per-head rate', () => {
    const r = estimateJobCompletion({
      elastics: [{
        elastic: 'A',
        remainingMeters: 2400,
        headsAssigned: 4,
        metersPerHeadPerShift: 100,   // → 400 m/shift
      }],
    });
    expect(r.jobShifts).toBe(6);                          // 2400 / 400
    expect(r.jobDays).toBe(Math.ceil(6 / C.SHIFTS_PER_DAY));
    expect(r.perElastic[0].metersPerShift).toBe(400);
  });

  test('multiple elastics — slowest elastic drives the job', () => {
    const r = estimateJobCompletion({
      elastics: [
        { elastic: 'A', remainingMeters: 1000, headsAssigned: 2, metersPerHeadPerShift: 100 }, // 5 shifts
        { elastic: 'B', remainingMeters: 2000, headsAssigned: 1, metersPerHeadPerShift: 100 }, // 20 shifts
      ],
    });
    expect(r.jobShifts).toBe(20);
  });

  test('elastic with no remaining meters contributes 0 shifts', () => {
    const r = estimateJobCompletion({
      elastics: [
        { elastic: 'A', remainingMeters: 0, headsAssigned: 4, metersPerHeadPerShift: 100 },
        { elastic: 'B', remainingMeters: 800, headsAssigned: 2, metersPerHeadPerShift: 100 },
      ],
    });
    expect(r.jobShifts).toBe(4);
    expect(r.perElastic[0].shifts).toBe(0);
  });

  test('elastic with no rate marked NO_RATE and excluded from job total', () => {
    const r = estimateJobCompletion({
      elastics: [
        { elastic: 'A', remainingMeters: 500, headsAssigned: 0, metersPerHeadPerShift: 100 },
        { elastic: 'B', remainingMeters: 500, headsAssigned: 2, metersPerHeadPerShift: 100 }, // 3 shifts (ceil)
      ],
    });
    expect(r.perElastic[0].reason).toBe('NO_RATE');
    expect(r.jobShifts).toBe(3);
  });
});

describe('runningOrderEta.estimateRunningOrderEta', () => {
  test('returns NO_ACTIVE_JOBS when jobs is empty', () => {
    const r = estimateRunningOrderEta({ jobs: [], today: MON_2026_06_15 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_ACTIVE_JOBS');
  });

  test('two parallel jobs — order ETA is the slower of the two', () => {
    const fastJob = {
      job: 'J1', machineId: 'M1', noOfHead: 4,
      elastics: [{ elastic: 'A', remainingMeters: 800, headsAssigned: 4, metersPerHeadPerShift: 100 }], // 2 shifts → 1d
    };
    const slowJob = {
      job: 'J2', machineId: 'M2', noOfHead: 4,
      elastics: [{ elastic: 'B', remainingMeters: 4000, headsAssigned: 2, metersPerHeadPerShift: 100 }], // 20 shifts → 10d
    };
    const r = estimateRunningOrderEta({
      jobs: [fastJob, slowJob],
      today: MON_2026_06_15,
    });
    expect(r.ok).toBe(true);
    expect(r.weavingDays).toBe(10);
    expect(r.leadDays).toBe(FINISH_BUFFER_WORKING_DAYS);
    expect(r.workingDays).toBe(10 + FINISH_BUFFER_WORKING_DAYS);
  });

  test('expectedDate skips Sundays from today', () => {
    const r = estimateRunningOrderEta({
      jobs: [{
        job: 'J1', machineId: 'M1', noOfHead: 2,
        elastics: [{ elastic: 'A', remainingMeters: 800, headsAssigned: 2, metersPerHeadPerShift: 100 }],
        // 4 shifts → 2d weaving + 2d finish = 4 working days
      }],
      today: MON_2026_06_15,        // Monday
    });
    // Mon + 4 working days (skip Sun) → Fri Jun 19
    expect(r.expectedDate.toISOString().slice(0, 10)).toBe('2026-06-19');
  });

  test('marks order late when expectedDate is past supplyDate', () => {
    const r = estimateRunningOrderEta({
      jobs: [{
        job: 'J1', machineId: 'M1', noOfHead: 2,
        elastics: [{ elastic: 'A', remainingMeters: 4000, headsAssigned: 2, metersPerHeadPerShift: 100 }],
      }],
      today:      MON_2026_06_15,
      supplyDate: new Date('2026-06-18'),
    });
    expect(r.risk.late).toBe(true);
    expect(r.risk.lateWorkingDays).toBeGreaterThan(0);
  });

  test('NO_RATE when every job lacks rate data', () => {
    const r = estimateRunningOrderEta({
      jobs: [{
        job: 'J1', machineId: 'M1', noOfHead: 2,
        elastics: [{ elastic: 'A', remainingMeters: 500, headsAssigned: 0, metersPerHeadPerShift: 100 }],
      }],
      today: MON_2026_06_15,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_RATE');
  });

  test('assumptions surfaces jobs with missing per-elastic rates', () => {
    const r = estimateRunningOrderEta({
      jobs: [
        {
          job: 'J1', machineId: 'M1', noOfHead: 2,
          elastics: [
            { elastic: 'A', remainingMeters: 800, headsAssigned: 2, metersPerHeadPerShift: 100 },
            { elastic: 'B', remainingMeters: 500, headsAssigned: 0, metersPerHeadPerShift: 100 },
          ],
        },
      ],
      today: MON_2026_06_15,
    });
    expect(r.assumptions.some((s) => s.includes('no production-rate data'))).toBe(true);
  });
});
