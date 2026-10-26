'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE COVERING BEAM SHEET READER AND THE BEAM LABELS
//
//  utils/coveringBeamOcr.js turns whatever the model said about a filled
//  covering programme into bounded rows; utils/coveringBeamLabelsPdf.js
//  prints one label a beam with what the floor reads off it.
// ══════════════════════════════════════════════════════════════════

const { sanitise, sheetRefOf, PROMPT } = require('../../utils/coveringBeamOcr');
const { buildCoveringBeamLabelsPdf, payloadOf } = require('../../utils/coveringBeamLabelsPdf');
const { pdfText, pdfPageCount } = require('../helpers/pdfText');

describe('reading the beam rows', () => {
  it('describes the sheet it reads', () => {
    expect(PROMPT).toMatch(/COVERING PROGRAMME/);
    expect(PROMPT).toMatch(/S\.No \| Beam # \| Weight \(kg\) \| Remarks/);
    expect(PROMPT).toMatch(/CV-8F3A2C/);
  });

  it('keeps rows with a beam or a weight, and types every field', () => {
    const r = sanitise({
      jobOrderNo: '48', sheetRef: 'cv 8f3a2c', totalWeight: '24,75',
      rows: [
        { sNo: 1, beamNo: '1', weight: '12,5', remarks: ' joint ', printed: false, confidence: 0.92 },
        { sNo: 2, beamNo: 2, weight: 12.25, confidence: 7 },
        { sNo: 3, beamNo: null, weight: null },
        { sNo: 4, beamNo: 1.5, weight: -2 },
      ],
    });
    expect(r.jobOrderNo).toBe(48);
    expect(r.sheetRef).toBe('CV-8F3A2C');
    expect(r.totalWeight).toBe(24.75);
    expect(r.rows).toEqual([
      { sNo: 1, beamNo: 1, weight: 12.5, remarks: 'joint', printed: false, confidence: 0.92 },
      { sNo: 2, beamNo: 2, weight: 12.25, remarks: '', printed: false, confidence: 1 },
    ]);
    expect(r.problem).toBeNull();
  });

  it('a reply with no rows is unreadable, never a guess', () => {
    expect(sanitise({}).problem).toBe('unreadable');
    expect(sanitise({ rows: [], problem: 'not_a_covering_sheet' }).problem).toBe('not_a_covering_sheet');
  });

  it('the sheet reference is CV- and the last six of the covering id', () => {
    expect(sheetRefOf('6adf49cf065044daeded789e')).toBe('CV-ED789E');
  });
});

describe('the beam labels', () => {
  const data = {
    jobOrderNo: 48, coveringId: 'c1', customerName: 'Suguna Garments', elasticName: 'SUGUNA PLAIN 8MM MAROON',
    beams: [
      { entryId: 'e1', beamNo: 1, weight: 12.5, note: '', dateLabel: '26 Oct 2026' },
      { entryId: 'e2', beamNo: 2, weight: 12.25, note: 'joint', dateLabel: '26 Oct 2026' },
    ],
    branding: { company: 'Balu Elastics' },
  };

  it('prints each beam with its number, weight, job, elastic and customer', async () => {
    const text = await pdfText(await buildCoveringBeamLabelsPdf(data));
    expect(text).toMatch(/COVERING BEAM · JOB J-48/);
    expect(text).toMatch(/12\.50 kg/);
    expect(text).toMatch(/12\.25 kg/);
    expect(text).toMatch(/SUGUNA PLAIN 8MM MAROON/);
    expect(text).toMatch(/Suguna Garments/);
    expect(text).toMatch(/joint/);
  });

  it('carries the payload the scanners already read', () => {
    expect(payloadOf(data, data.beams[0])).toBe('COVB|J:48|C:c1|B:1|E:e1');
  });

  it('ten to a page', async () => {
    const beams = Array.from({ length: 11 }, (_, i) => ({ entryId: `e${i}`, beamNo: i + 1, weight: 10 + i }));
    expect(pdfPageCount(await buildCoveringBeamLabelsPdf({ ...data, beams }))).toBe(2);
    expect(pdfPageCount(await buildCoveringBeamLabelsPdf({ ...data, beams: beams.slice(0, 10) }))).toBe(1);
  }, 30_000);

  it('says so when there is nothing to label', async () => {
    expect(await pdfText(await buildCoveringBeamLabelsPdf({ ...data, beams: [] }))).toMatch(/nothing to label/);
  });
});
