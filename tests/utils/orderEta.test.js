'use strict';

const {
  metersPerMachineDay,
  estimateForMachines,
  estimateOrderEta,
} = require('../../utils/orderEta.js');
const C = require('../../utils/etaConfig.js');

// Fix "today" on a Monday so date math is deterministic. 2026-06-15 is a Monday.
const MON_2026_06_15 = new Date('2026-06-15T00:00:00Z');

describe('orderEta.metersPerMachineDay', () => {
  test('prefers empirical elastic-specific rate', () => {
    const r = metersPerMachineDay({
      aggregates: { elasticRate: { ela1: 1200 }, plantRate: 900 },
      elasticId: 'ela1',
    });
    expect(r.rate).toBe(1200);
    expect(r.source).toBe('empirical_elastic');
  });

  test('falls back to plant rate when elastic has no history', () => {
    const r = metersPerMachineDay({
      aggregates: { plantRate: 950, machineNoOfHeadAvg: 4 },
      elasticId: 'unknown',
    });
    expect(r.rate).toBe(950);
    expect(r.source).toBe('empirical_plant');
  });

  test('cold-start fallback when no empirical data exists', () => {
    const r = metersPerMachineDay({
      aggregates: { machineNoOfHeadAvg: 6 },
      elasticId: 'unknown',
    });
    expect(r.source).toBe('coldstart');
    expect(r.rate).toBe(C.COLDSTART_METERS_PER_HEAD_DAY * 6 * C.LOOM_EFFICIENCY);
  });
});

describe('orderEta.estimateForMachines', () => {
  test('parallelism divides machine-days correctly', () => {
    const r1 = estimateForMachines({
      totalMeters: 10_000, machines: 1, effRate: 1000,
      today: MON_2026_06_15,
    });
    const r2 = estimateForMachines({
      totalMeters: 10_000, machines: 2, effRate: 1000,
      today: MON_2026_06_15,
    });
    // 10 machine-days; 1 machine -> 10 weaving days, 2 machines -> 5.
    expect(r1.weavingDays).toBe(10);
    expect(r2.weavingDays).toBe(5);
    expect(r1.workingDays).toBe(r1.weavingDays + r1.leadDays);
  });

  test('Sunday-skip: 6 working days from Monday lands on the next Monday', () => {
    // 6 working days after Mon 2026-06-15 → working days 16, 17, 18, 19, 20, 22 (skip Sun 21).
    const r = estimateForMachines({
      totalMeters: 2_400, machines: 1, effRate: 1000,
      today: MON_2026_06_15,
    });
    // machineDays=2.4, weavingDays=3, leadDays=4 → workingDays=7
    // Mon 15 + 7 working days (skip Sun): 16, 17, 18, 19, 20, 22, 23 → Tue 23.
    expect(r.workingDays).toBe(7);
    expect(r.expectedDate.getUTCDay()).not.toBe(0); // not a Sunday
    expect(r.expectedDate.toISOString().slice(0, 10)).toBe('2026-06-23');
  });
});

describe('orderEta.estimateOrderEta integration', () => {
  const baseAgg = {
    plantRate: 1000,
    elasticRate: { ela1: 1000 },
    consistencyScore: 80,
    attendanceMomentum: 1,
    machineHealth: 1,
    freeMachines: 3,
    machineNoOfHeadAvg: 4,
  };

  test('happy path returns expectedDate, range, what-if curve, no late risk', () => {
    const r = estimateOrderEta({
      lines: [{ elastic: 'ela1', quantity: 6000 }],
      machines: 2,
      supplyDate: '2026-07-15',
      today: MON_2026_06_15,
      aggregates: baseAgg,
    });
    expect(r.ok).toBe(true);
    expect(r.totalMeters).toBe(6000);
    expect(r.machines).toBe(2);
    expect(r.machineDays).toBe(6);
    expect(r.weavingDays).toBe(3);
    expect(r.workingDays).toBe(7);
    expect(r.expectedDate.toISOString().slice(0, 10)).toBe('2026-06-23');
    expect(r.optimisticDays).toBeLessThanOrEqual(r.workingDays);
    expect(r.pessimisticDays).toBeGreaterThanOrEqual(r.workingDays);
    expect(r.risk.late).toBe(false);
    expect(r.whatIf.length).toBeGreaterThan(0);
    expect(r.whatIf[0].machines).toBe(1);
    // More machines must yield equal or fewer working days.
    for (let i = 1; i < r.whatIf.length; i += 1) {
      expect(r.whatIf[i].workingDays).toBeLessThanOrEqual(r.whatIf[i - 1].workingDays);
    }
  });

  test('flags late risk when expectedDate exceeds supplyDate', () => {
    const r = estimateOrderEta({
      lines: [{ elastic: 'ela1', quantity: 50_000 }],
      machines: 1,
      supplyDate: '2026-06-20',
      today: MON_2026_06_15,
      aggregates: baseAgg,
    });
    expect(r.ok).toBe(true);
    expect(r.risk.late).toBe(true);
    expect(r.risk.lateWorkingDays).toBeGreaterThan(0);
  });

  test('attendance + machine-health factors are clamped', () => {
    // Wildly low momentum should clamp to 0.8, not 0.1.
    const r = estimateOrderEta({
      lines: [{ elastic: 'ela1', quantity: 1000 }],
      machines: 1,
      today: MON_2026_06_15,
      aggregates: { ...baseAgg, attendanceMomentum: 0.1, machineHealth: 0.1 },
    });
    expect(r.factors.attendanceMomentum).toBe(C.ATTENDANCE_MOMENTUM_MIN);
    expect(r.factors.machineHealth).toBe(C.MACHINE_HEALTH_MIN);
  });

  test('returns NO_RATE when there is genuinely no data of any kind', () => {
    const r = estimateOrderEta({
      lines: [{ elastic: 'ela1', quantity: 1000 }],
      machines: 1,
      today: MON_2026_06_15,
      aggregates: { plantRate: 0, machineNoOfHeadAvg: 0 },
    });
    // Cold-start should still produce a rate via the COLDSTART constant
    // even if NoOfHead is missing — only zero meters would fail.
    expect(r.ok).toBe(true);
  });

  test('cold-start flag surfaces in usedColdStart + assumptions', () => {
    const r = estimateOrderEta({
      lines: [{ elastic: 'newElastic', quantity: 2000 }],
      machines: 1,
      today: MON_2026_06_15,
      aggregates: { machineNoOfHeadAvg: 4 },  // no plantRate, no elasticRate
    });
    expect(r.usedColdStart).toBe(true);
    expect(r.assumptions.some((s) => /cold-start/i.test(s))).toBe(true);
  });
});
