'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH SERVICE BILLS ARE WORTH LOOKING AT
//
//  This detector points at people's work, and sometimes at their pay,
//  so what it must NOT do matters more than what it must:
//
//    • it must not speak from too little data. Four service logs
//      support no conclusion, and "no problems found" from four logs
//      is a confident claim resting on nothing.
//    • it must not be defeated by the thing it is looking for. Mean
//      and standard deviation are both dragged by outliers, so a run
//      of padded bills would raise the bar it has to clear. These pin
//      the robust behaviour with a worked example.
//    • it must not raise a finding somebody has already explained.
//    • it must never be certain. Every finding carries the innocent
//      reading, and that is asserted here because it is the difference
//      between an observation and an accusation.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

const {
  median, mad, robustScore, issueKey, severityFrom,
  repeatServices, technicianCost, issueAcrossMachines,
  duplicateBills, costMismatch, monthsBetween,
  MAD_THRESHOLD,
} = require('../../services/serviceAnomaly');

const DAY = 24 * 60 * 60 * 1000;
const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * DAY);

/** One service log, in the flattened shape the signals consume. */
const log = (over = {}) => ({
  logId: `l${Math.random()}`,
  machineId: 'm1',
  machineID: 'LOOM-01',
  date: day(0),
  type: 'Preventive',
  description: 'Replaced drive belt',
  technician: 'Rajan',
  cost: 1000,
  loggedCost: 1000,
  billTotal: 0,
  bills: [],
  ...over,
});

describe('robust statistics', () => {
  it('takes the middle of an odd sample', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the middle pair of an even sample', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('has no answer for an empty sample, rather than zero', () => {
    // Zero is a number somebody would compare against. null is not.
    expect(median([])).toBeNull();
    expect(mad([])).toBeNull();
  });

  it('is not dragged by an outlier, where a mean would be', () => {
    const ordinary = [10, 11, 12, 13, 14];
    const withFraud = [...ordinary, 10_000];

    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    // The mean moves by two orders of magnitude; the median barely.
    expect(mean(withFraud)).toBeGreaterThan(1000);
    expect(median(withFraud)).toBeLessThan(20);
  });

  it('still finds the outlier that would have hidden behind a σ', () => {
    // The whole reason for MAD. With enough padded bills in the sample,
    // a mean-and-sigma test stops flagging any of them: they raise the
    // mean AND widen the band. The median does not move.
    const costs = [1000, 1050, 1100, 1150, 1200, 9000, 9500, 10_000];
    const score = robustScore(10_000, costs);
    expect(score).toBeGreaterThan(MAD_THRESHOLD);
  });

  it('refuses to judge a sample too small to judge', () => {
    expect(robustScore(5, [1, 2])).toBeNull();
  });

  it('does not give up when the sample is unanimous', () => {
    // The first version returned null here, which had the detector give
    // up on the clearest case there is: perfectly consistent data with
    // one obvious outlier. A plant servicing every loom every 60 days,
    // with one serviced every 5, is exactly that.
    expect(robustScore(50, [10, 10, 10, 10])).toBeGreaterThan(MAD_THRESHOLD);
    expect(robustScore(10, [10, 10, 10, 10])).toBe(0);
  });

  it('does not treat a rounding difference as an outlier', () => {
    // The scale borrowed from a unanimous sample has to be big enough
    // that ₹1001 against a unanimous ₹1000 is not a finding.
    const score = robustScore(1001, [1000, 1000, 1000, 1000]);
    expect(Math.abs(score)).toBeLessThan(MAD_THRESHOLD);
  });

  it('has no scale to borrow from a unanimous zero', () => {
    expect(robustScore(5, [0, 0, 0, 0])).toBeNull();
    expect(robustScore(0, [0, 0, 0, 0])).toBe(0);
  });
});

describe('reading a description', () => {
  it('collapses the same job written three ways', () => {
    expect(issueKey('Replaced drive belt'))
      .toBe(issueKey('drive belt replacement'));
    expect(issueKey('Changed the drive belt'))
      .toBe(issueKey('Replaced drive belt'));
  });

  it('keeps different jobs apart', () => {
    expect(issueKey('Replaced drive belt'))
      .not.toBe(issueKey('Replaced needle bar'));
  });

  it('has no key for a description with nothing in it', () => {
    // Otherwise every empty description groups with every other, and
    // "the same job on 40 machines" is a sentence about nothing.
    expect(issueKey('')).toBe('');
    expect(issueKey('  the and of  ')).toBe('');
  });
});

describe('a machine serviced far more often than the rest', () => {
  /** One busy machine among several serviced at a steady pace. */
  const floor = () => {
    const logs = [];
    // Five machines serviced every ~60 days.
    for (let m = 2; m <= 6; m++) {
      for (let i = 0; i < 4; i++) {
        logs.push(log({
          machineId: `m${m}`, machineID: `LOOM-0${m}`,
          date: day(i * 60), cost: 1000,
        }));
      }
    }
    return logs;
  };

  it('finds the machine on a much shorter cycle', () => {
    const logs = [
      ...floor(),
      ...[0, 5, 10, 15, 20].map((d) =>
        log({ machineId: 'm1', machineID: 'LOOM-01', date: day(d), cost: 4000 })),
    ];

    const found = repeatServices(logs);
    expect(found.map((f) => f.subject)).toContain('m1');
  });

  it('does not flag a machine serviced LESS often', () => {
    // Rarely serviced is not a billing pattern.
    const logs = [
      ...floor(),
      ...[0, 200, 400].map((d) =>
        log({ machineId: 'm9', machineID: 'LOOM-09', date: day(d) })),
    ];
    expect(repeatServices(logs).map((f) => f.subject)).not.toContain('m9');
  });

  it('says nothing at all from a floor with no history', () => {
    expect(repeatServices([log(), log()])).toEqual([]);
  });

  it('states the innocent reading beside the finding', () => {
    const logs = [
      ...floor(),
      ...[0, 5, 10, 15, 20].map((d) =>
        log({ machineId: 'm1', date: day(d), cost: 4000 })),
    ];
    const found = repeatServices(logs).find((f) => f.subject === 'm1');
    // A loom serviced often is usually a loom that is failing, and the
    // finding has to say so or it reads as an accusation.
    expect(found.innocent).toMatch(/failing/i);
    expect(found.evidence.length).toBeGreaterThan(0);
  });
});

describe('a technician whose jobs cost more', () => {
  const peers = () => {
    const logs = [];
    for (const t of ['Anil', 'Bala', 'Chandra']) {
      for (let i = 0; i < 5; i++) {
        logs.push(log({ technician: t, cost: 1000 + i * 10, date: day(i) }));
      }
    }
    return logs;
  };

  it('finds the one billing far above the others', () => {
    const logs = [
      ...peers(),
      ...Array.from({ length: 5 }, (_, i) =>
        log({ technician: 'Dev', cost: 20_000 + i * 10, date: day(i) })),
    ];
    expect(technicianCost(logs).map((f) => f.subject)).toContain('Dev');
  });

  it('will not judge a technician with too few jobs', () => {
    const logs = [...peers(), log({ technician: 'New', cost: 90_000 })];
    expect(technicianCost(logs).map((f) => f.subject)).not.toContain('New');
  });

  it('says nothing when there is nobody to compare against', () => {
    const solo = Array.from({ length: 8 }, (_, i) =>
      log({ technician: 'Only', cost: 5000, date: day(i) }));
    expect(technicianCost(solo)).toEqual([]);
  });

  it('states that the expensive jobs may simply be the hard ones', () => {
    const logs = [
      ...peers(),
      ...Array.from({ length: 5 }, (_, i) =>
        log({ technician: 'Dev', cost: 20_000, date: day(i) })),
    ];
    const found = technicianCost(logs).find((f) => f.subject === 'Dev');
    expect(found.innocent).toMatch(/difficult machines/i);
  });
});

describe('the same job across many machines', () => {
  it('notices a part billed across the floor', () => {
    const logs = [1, 2, 3, 4].map((m) =>
      log({ machineId: `m${m}`, machineID: `LOOM-0${m}`, description: 'Replaced drive belt' }));
    const found = issueAcrossMachines(logs);
    expect(found).toHaveLength(1);
    expect(found[0].title).toMatch(/4 machines/);
  });

  it('needs more than a couple of machines to call it a pattern', () => {
    const logs = [1, 2].map((m) =>
      log({ machineId: `m${m}`, description: 'Replaced drive belt' }));
    expect(issueAcrossMachines(logs)).toEqual([]);
  });

  it('ranks one technician behind the whole pattern higher', () => {
    const oneHand = [1, 2, 3, 4].map((m) =>
      log({ machineId: `m${m}`, technician: 'Rajan', description: 'Replaced drive belt' }));
    const manyHands = [1, 2, 3, 4].map((m) =>
      log({ machineId: `m${m}`, technician: `T${m}`, description: 'Replaced drive belt' }));

    expect(issueAcrossMachines(oneHand)[0].severity)
      .toBeGreaterThan(issueAcrossMachines(manyHands)[0].severity);
  });

  it('ignores logs with no description', () => {
    const logs = [1, 2, 3, 4].map((m) => log({ machineId: `m${m}`, description: '' }));
    expect(issueAcrossMachines(logs)).toEqual([]);
  });
});

describe('a bill filed twice', () => {
  const bill = (over = {}) => ({
    _id: `b${Math.random()}`, kind: 'service_bill', amount: 5000,
    vendor: 'Comez Spares', billNo: 'INV-100',
    billDate: new Date('2026-03-01'), ...over,
  });

  it('finds the same bill number against two machines', () => {
    const logs = [
      log({ machineId: 'm1', machineID: 'LOOM-01', bills: [bill()] }),
      log({ machineId: 'm2', machineID: 'LOOM-02', bills: [bill()] }),
    ];
    const found = duplicateBills(logs);
    expect(found.some((f) => f.kind === 'duplicate-bill-no')).toBe(true);
  });

  it('ranks it above the softer signals — it is closer to fact', () => {
    const logs = [
      log({ machineId: 'm1', bills: [bill()] }),
      log({ machineId: 'm2', bills: [bill()] }),
    ];
    const found = duplicateBills(logs).find((f) => f.kind === 'duplicate-bill-no');
    expect(found.severity).toBeGreaterThan(0.8);
  });

  it('does not report the same pair twice under two headings', () => {
    // Same number AND same vendor/day/amount: the number is the
    // stronger signal and the weaker one must not double it up.
    const logs = [
      log({ machineId: 'm1', bills: [bill()] }),
      log({ machineId: 'm2', bills: [bill()] }),
    ];
    const found = duplicateBills(logs);
    expect(found.filter((f) => f.subject.includes('inv-100'))).toHaveLength(1);
  });

  it('leaves a single bill alone', () => {
    expect(duplicateBills([log({ bills: [bill()] })])).toEqual([]);
  });

  it('ignores bills with no amount on them', () => {
    const logs = [
      log({ machineId: 'm1', bills: [bill({ amount: 0 })] }),
      log({ machineId: 'm2', bills: [bill({ amount: 0 })] }),
    ];
    expect(duplicateBills(logs)).toEqual([]);
  });

  it('says the usual explanation is a double upload', () => {
    const logs = [
      log({ machineId: 'm1', bills: [bill()] }),
      log({ machineId: 'm2', bills: [bill()] }),
    ];
    expect(duplicateBills(logs)[0].innocent).toMatch(/uploaded twice|several machines/i);
  });
});

describe('the logged cost against the bills', () => {
  it('reports two numbers that should agree and do not', () => {
    const found = costMismatch([log({ loggedCost: 1500, billTotal: 4200 })]);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toMatch(/1,500/);
    expect(found[0].detail).toMatch(/4,200/);
  });

  it('says nothing when they agree', () => {
    expect(costMismatch([log({ loggedCost: 4200, billTotal: 4200 })])).toEqual([]);
  });

  it('says nothing when no bill has been filed yet', () => {
    // Absent is not disagreeing.
    expect(costMismatch([log({ loggedCost: 1500, billTotal: 0 })])).toEqual([]);
  });
});

describe('severity', () => {
  it('is zero at the threshold — the point is not yet interesting', () => {
    expect(severityFrom(MAD_THRESHOLD)).toBe(0);
  });

  it('rises past it and saturates', () => {
    expect(severityFrom(MAD_THRESHOLD * 2)).toBeGreaterThan(0);
    expect(severityFrom(MAD_THRESHOLD * 100)).toBeLessThanOrEqual(1);
  });

  it('treats a large negative deviation as just as interesting', () => {
    // A gap far SHORTER than usual is the repeat-service signal.
    expect(severityFrom(-MAD_THRESHOLD * 3)).toBeGreaterThan(0);
  });
});

describe('the months a chart is drawn over', () => {
  it('includes the months with nothing in them', () => {
    // A chart drawn only from months that had a bill closes the gaps,
    // and three quiet months read as three busy ones.
    const months = monthsBetween(new Date('2026-01-15'), new Date('2026-04-02'));
    expect(months).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
  });

  it('gives a single month for a window inside one', () => {
    expect(monthsBetween(new Date('2026-03-02'), new Date('2026-03-28')))
      .toEqual(['2026-03']);
  });
});
