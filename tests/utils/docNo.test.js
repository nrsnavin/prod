'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DOCUMENT NUMBER WRITTEN SHORT — utils/docNo.js
//
//  Papers name our documents (and suppliers' own) the short way: "701",
//  "INV-701". They are found by "the last number in it". A financial
//  year written AFTER the number ("701/26-27", "SY/118/2026-27") made
//  the last number 27: every document of the year "ended in 27", so a
//  payment advice for invoice 701 was placed on invoice 0027, and a
//  supplier's bill 119/26-27 was "matched by number" to our 120/26-27.
// ══════════════════════════════════════════════════════════════════

const { lastNumber, squash } = require('../../utils/docNo');

describe('the running number in a document number', () => {
  it('is the last number, however the number is dressed', () => {
    expect(lastNumber('701')).toBe(701);
    expect(lastNumber('INV-701')).toBe(701);
    expect(lastNumber('INV/2026-27/0701')).toBe(701);
    expect(lastNumber('SY/118')).toBe(118);
    expect(lastNumber('Bill No. 45 dt.')).toBe(45);
  });

  it('is not the financial year written after it', () => {
    expect(lastNumber('701/26-27')).toBe(701);
    expect(lastNumber('701/2026-27')).toBe(701);
    expect(lastNumber('SY/118/2026-2027')).toBe(118);
    expect(lastNumber('118 / 26-27')).toBe(118);
    expect(lastNumber('GST/25-26/00451')).toBe(451);
    expect(lastNumber('2026/27/118')).toBe(118);
    expect(lastNumber('A-45/99-00')).toBe(45);
  });

  it('leaves alone two numbers that are not consecutive years', () => {
    expect(lastNumber('701/02')).toBe(2);
    expect(lastNumber('12-45')).toBe(45);
    expect(lastNumber('INV 2026-30')).toBe(30);
  });

  it('is nothing when there is no number, or only a year', () => {
    expect(lastNumber('')).toBeNull();
    expect(lastNumber(null)).toBeNull();
    expect(lastNumber('ADVANCE')).toBeNull();
    expect(lastNumber('FY 2026-27')).toBeNull();
  });

  it('squash compares numbers whatever the punctuation', () => {
    expect(squash('inv/2026-27/0701')).toBe('INV2026270701');
    expect(squash(' SY - 118 ')).toBe('SY118');
    expect(squash(null)).toBe('');
  });
});
