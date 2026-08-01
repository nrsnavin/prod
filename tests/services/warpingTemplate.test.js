'use strict';
//
// Building a warping plan's beams from the elastics on a job.
//
// The old code took the FIRST elastic with a template and stopped, so a
// job carrying two products was planned as though it carried one and the
// second product's beams simply were not there. Whoever read the
// programme had to notice.

const mongoose = require('mongoose');
const { buildBeamsFromTemplates, hasBeams } = require('../../services/warpingTemplate');

const yarnA = new mongoose.Types.ObjectId();
const yarnB = new mongoose.Types.ObjectId();

const elastic = (name, beams) => ({
  elastic: {
    _id: new mongoose.Types.ObjectId(),
    name,
    warpingPlanTemplate: beams ? { noOfBeams: beams.length, beams } : undefined,
  },
});

const beam = (beamNo, sections, pairedBeamNo = null) => ({ beamNo, sections, pairedBeamNo });
const section = (warpYarn, ends, maxMeters = 0) => ({ warpYarn, ends, maxMeters });

describe('hasBeams', () => {
  test('an absent, empty or section-less template is nothing to plan from', () => {
    expect(hasBeams(undefined)).toBe(false);
    expect(hasBeams(null)).toBe(false);
    expect(hasBeams({ beams: [] })).toBe(false);
    expect(hasBeams({ beams: [beam(1, [])] })).toBe(false);
  });
  test('a template with one filled beam is', () => {
    expect(hasBeams({ beams: [beam(1, [section(yarnA, 100)])] })).toBe(true);
  });
});

describe('buildBeamsFromTemplates', () => {
  test('copies a single elastic\'s beams and totals their ends', () => {
    const { beams } = buildBeamsFromTemplates([
      elastic('20mm', [beam(1, [section(yarnA, 120, 5000), section(yarnB, 80)])]),
    ]);

    expect(beams).toHaveLength(1);
    expect(beams[0].beamNo).toBe(1);
    expect(beams[0].totalEnds).toBe(200);
    expect(beams[0].sections).toEqual([
      { warpYarn: yarnA, ends: 120, maxMeters: 5000 },
      { warpYarn: yarnB, ends: 80, maxMeters: 0 },
    ]);
  });

  test('takes every elastic on the job, not only the first', () => {
    const { beams, sources } = buildBeamsFromTemplates([
      elastic('20mm', [beam(1, [section(yarnA, 100)])]),
      elastic('32mm', [beam(1, [section(yarnB, 60)]), beam(2, [section(yarnB, 60)])]),
    ]);

    expect(beams).toHaveLength(3);
    expect(sources.map((s) => s.elasticName)).toEqual(['20mm', '32mm']);
    expect(sources[1].beamNos).toEqual([2, 3]);
  });

  test('renumbers beams across the plan so two products cannot both be beam 1', () => {
    const { beams } = buildBeamsFromTemplates([
      elastic('20mm', [beam(1, [section(yarnA, 100)])]),
      elastic('32mm', [beam(1, [section(yarnB, 60)])]),
    ]);

    expect(beams.map((b) => b.beamNo)).toEqual([1, 2]);
  });

  test('says which elastic each beam is warping', () => {
    const first = elastic('20mm', [beam(1, [section(yarnA, 100)])]);
    const second = elastic('32mm', [beam(1, [section(yarnB, 60)])]);
    const { beams } = buildBeamsFromTemplates([first, second]);

    expect(String(beams[0].elastic)).toBe(String(first.elastic._id));
    expect(String(beams[1].elastic)).toBe(String(second.elastic._id));
  });

  test('remaps a paired beam onto its new number instead of dangling', () => {
    const { beams } = buildBeamsFromTemplates([
      elastic('20mm', [beam(1, [section(yarnA, 100)])]),
      // This product pairs its own beams 1 and 2, which become 2 and 3.
      elastic('32mm', [
        beam(1, [section(yarnB, 60)], 2),
        beam(2, [section(yarnB, 60)], 1),
      ]),
    ]);

    expect(beams[1].pairedBeamNo).toBe(3);
    expect(beams[2].pairedBeamNo).toBe(2);
    // An unpaired beam stays unpaired rather than inheriting a number.
    expect(beams[0].pairedBeamNo).toBeNull();
  });

  test('skips an elastic with no template, and one whose beams are empty', () => {
    const { beams, sources } = buildBeamsFromTemplates([
      elastic('no template', null),
      elastic('empty beams', [beam(1, [])]),
      elastic('20mm', [beam(1, [section(yarnA, 100)])]),
    ]);

    expect(beams).toHaveLength(1);
    expect(sources).toHaveLength(1);
    expect(sources[0].elasticName).toBe('20mm');
  });

  test('a job with nothing to plan from yields no beams at all', () => {
    // The caller uses this to decide not to create a plan — an empty
    // plan is worse than none, because it looks like it was programmed.
    expect(buildBeamsFromTemplates([]).beams).toEqual([]);
    expect(buildBeamsFromTemplates([elastic('bare', null)]).beams).toEqual([]);
  });

  test('tolerates a malformed entry rather than throwing mid-plan', () => {
    const { beams } = buildBeamsFromTemplates([
      null,
      {},
      { elastic: null },
      elastic('20mm', [beam(1, [section(yarnA, 100)])]),
    ]);
    expect(beams).toHaveLength(1);
  });

  test('coerces string ends, so a template saved from a form still totals', () => {
    const { beams } = buildBeamsFromTemplates([
      elastic('20mm', [beam(1, [section(yarnA, '120'), section(yarnB, '80')])]),
    ]);
    expect(beams[0].totalEnds).toBe(200);
  });
});
