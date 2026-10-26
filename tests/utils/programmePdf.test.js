'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE WARPING AND COVERING PROGRAMMES (PDF) — utils/programmePdf.js
//
//  What the printed sheet SAYS, read back out of the PDF: the run
//  length and dye lot of each section, the ends a tape and a beam carry
//  (worked out when the plan never stored them), tape headings only
//  where there are tapes, the customer, and for covering the 20-row
//  beam-weight grid. And how it is laid out: one A4 page for a small
//  plan, narrow margins, no tape heading left at the foot of a page.
//
//  These carry over what the browser-printed sheets were tested for.
// ══════════════════════════════════════════════════════════════════

const { pdfText, pdfRuns, pdfPageCount } = require('../helpers/pdfText');
const { buildWarpingProgrammePdf, buildCoveringProgrammePdf, beamEnds, MARGIN } = require('../../utils/programmePdf');

const pymupdfPages = pdfPageCount;

const section = (yarn, ends, extra = {}) => ({ yarn, lot: '', ends, maxMeters: 1500, ...extra });
const warping = (over = {}) => ({
  jobOrderNo: 48, customerName: 'Suguna Garments', orderNo: 31, dateLabel: '26 Oct 2026', status: 'Open',
  elastics: [{ name: 'SUGUNA PLAIN 8MM MAROON', quantity: 1800 }],
  plan: { beams: [{ beamNo: 1, tapeNo: null, elasticName: 'SUGUNA PLAIN 8MM MAROON', totalEnds: null, sections: [section('Nylon 40D', 54)] }] },
  branding: { company: 'Balu Elastics' },
  ...over,
});

describe('the warping programme', () => {
  it('names the job, the customer and the order, and each elastic with its quantity', async () => {
    const text = await pdfText(await buildWarpingProgrammePdf(warping()));
    expect(text).toMatch(/WARPING PROGRAMME/);
    expect(text).toMatch(/J-48/);
    expect(text).toMatch(/Suguna Garments/);
    expect(text).toMatch(/#31/);
    expect(text).toMatch(/SUGUNA PLAIN 8MM MAROON/);
    expect(text).toMatch(/1,800/);
  });

  it('prints each section with its yarn, dye lot, ends and run length', async () => {
    const text = await pdfText(await buildWarpingProgrammePdf(warping({
      plan: { beams: [{ beamNo: 1, sections: [section('Nylon 40D', 120, { lot: 'L-77 · Navy', maxMeters: 1500 }), section('Poly 150D', 60, { maxMeters: null })] }] },
    })));
    expect(text).toMatch(/Nylon 40D/);
    expect(text).toMatch(/L-77 · Navy/);
    expect(text).toMatch(/1,500/);
    // A section with no run length prints a dash, not a blank.
    expect(text).toMatch(/Poly 150D\s*—\s*60\s*—/);
  });

  it('works out a beam\'s ends from its sections when the plan never stored them', async () => {
    expect(beamEnds({ totalEnds: null, sections: [{ ends: 54 }] })).toBe(54);
    expect(beamEnds({ totalEnds: 0, sections: [{ ends: 20 }, { ends: 30 }] })).toBe(50);
    expect(beamEnds({ totalEnds: 96, sections: [{ ends: 1 }] })).toBe(96);
    const text = await pdfText(await buildWarpingProgrammePdf(warping()));
    expect(text).toMatch(/Total\s*54/);
  });

  const taped = {
    beams: [
      { beamNo: 1, tapeNo: 1, elasticName: '20mm', totalEnds: 120, sections: [section('Nylon 40D', 120)] },
      { beamNo: 2, tapeNo: 1, elasticName: '32mm', sections: [section('Poly 150D', 60)] },
      { beamNo: 3, tapeNo: 2, elasticName: '20mm', totalEnds: 120, sections: [section('Nylon 40D', 120)] },
      { beamNo: 4, tapeNo: 2, elasticName: '32mm', sections: [section('Poly 150D', 60)] },
    ],
  };

  it('heads each tape with its own beams and ends — counted even when a beam stored none', async () => {
    const text = await pdfText(await buildWarpingProgrammePdf(warping({ plan: taped })));
    expect(text).toMatch(/TAPE 1/);
    expect(text).toMatch(/TAPE 2/);
    expect(text.match(/2 beams · 180 ends/g)).toHaveLength(2);
    expect(text).toMatch(/4 beams over 2 tapes/i);
    expect(text).toMatch(/TAPES/);
    expect(text).toMatch(/Beam 1 · 20mm/);
    expect(text).toMatch(/Beam 2 · 32mm/);
  });

  it('a plan with no tapes has no tape heading and no tape count', async () => {
    const text = await pdfText(await buildWarpingProgrammePdf(warping()));
    expect(text).not.toMatch(/TAPE /);
    expect(text).not.toMatch(/TAPES/);
  });

  it('a single tape is headed, but the header does not count tapes', async () => {
    const text = await pdfText(await buildWarpingProgrammePdf(warping({ plan: { beams: taped.beams.slice(0, 2) } })));
    expect(text).toMatch(/TAPE 1/);
    expect(text).not.toMatch(/TAPES/);
  });

  it('says when there is no plan yet', async () => {
    const text = await pdfText(await buildWarpingProgrammePdf(warping({ plan: null })));
    expect(text).toMatch(/BEAM PLAN — NOT CREATED YET/);
  });

  it('fits the five-beam job on one page with ~10 mm margins', async () => {
    const plan = { beams: [1, 2, 3, 4, 5].map((n) => ({ beamNo: n, tapeNo: 1, elasticName: `Elastic ${n}`, sections: [section(`Yarn ${n}`, 54)] })) };
    const buf = await buildWarpingProgrammePdf(warping({ plan }));
    expect(pymupdfPages(buf)).toBe(1);
    expect(MARGIN).toBeLessThanOrEqual(30);
    expect(await pdfText(buf)).toMatch(/5 beams · 270 ends/);
  });

  it('never leaves a tape heading at the foot of a page', async () => {
    const beams = [];
    for (let t = 1; t <= 3; t++) {
      for (let b = 1; b <= 8; b++) {
        beams.push({ beamNo: (t - 1) * 8 + b, tapeNo: t, elasticName: 'NAVY', sections: [1, 2, 3, 4].map((s) => section(`Yarn ${s}`, 24)) });
      }
    }
    const buf = await buildWarpingProgrammePdf(warping({ plan: { beams } }));
    const runs = await pdfRuns(buf);
    // Per page, the last thing before the footer is never a tape heading.
    const pages = [];
    let page = [];
    for (const r of runs) {
      if (/^Page \d+ of \d+$/.test(r)) { pages.push(page); page = []; } else page.push(r);
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const body = p.filter((r) => !/^Generated /.test(r));
      const tail = body.slice(-3).join(' ');
      expect(tail).not.toMatch(/TAPE \d/);
    }
  });
});

describe('the covering programme', () => {
  const covering = (over = {}) => ({
    jobOrderNo: 48, customerName: 'Suguna Garments', orderNo: 31, dateLabel: '26 Oct 2026', status: 'In progress',
    lines: [{ name: 'SUGUNA PLAIN 8MM MAROON', quantity: 1800, warpSpandex: 'Spandex 840D', spandexCovering: 'Nylon 70D', spandexEnds: 9, totalWeight: 0.62 }],
    beamEntries: [],
    producedWeight: null,
    ...over,
  });

  it('lists each elastic with its spandex, weight a metre and expected covering weight', async () => {
    const text = await pdfText(await buildCoveringProgrammePdf(covering()));
    expect(text).toMatch(/COVERING PROGRAMME/);
    expect(text).toMatch(/Suguna Garments/);
    expect(text).toMatch(/Spandex 840D/);
    expect(text).toMatch(/Nylon 70D/);
    expect(text).toMatch(/0\.62/);
    // 1800 × 0.62 / 1000 = 1.116
    expect(text).toMatch(/1\.12/);
  });

  it('prints 20 rows for beam weights, numbered across the two halves, blank when nothing is weighed', async () => {
    const text = await pdfText(await buildCoveringProgrammePdf(covering()));
    expect(text).toMatch(/to be entered at the machine/i);
    expect(text).toMatch(/\b20\b/);
    expect(text).not.toMatch(/\b21\b/);
    expect(text).toMatch(/________ kg/);
  });

  it('fills the rows from what was weighed, in beam order, and totals them', async () => {
    const text = await pdfText(await buildCoveringProgrammePdf(covering({
      beamEntries: [{ beamNo: 2, weight: 12.25, note: 'joint' }, { beamNo: 1, weight: 12.5, note: '' }],
      producedWeight: 24.75,
    })));
    expect(text).toMatch(/2 recorded/i);
    expect(text.indexOf('12.50')).toBeLessThan(text.indexOf('12.25'));
    expect(text).toMatch(/joint/);
    expect(text).toMatch(/24\.75 kg/);
  });

  it('grows past 20 rows rather than dropping a weighed beam', async () => {
    const beamEntries = Array.from({ length: 23 }, (_, i) => ({ beamNo: i + 1, weight: 10 + i, note: '' }));
    const text = await pdfText(await buildCoveringProgrammePdf(covering({ beamEntries })));
    expect(text).toMatch(/\b23\b/);
    expect(text).toMatch(/32/); // the 23rd beam's weight
  });

  it('fits on one page', async () => {
    expect(pymupdfPages(await buildCoveringProgrammePdf(covering()))).toBe(1);
  });
});
