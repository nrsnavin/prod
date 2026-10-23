'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE SELEC LTC9A, READ — utils/timerOcr.js
//
//  The meter on these looms shows the run time as H:MM:SS in seven-
//  segment digits, right-aligned, with faint colons and the printed
//  "LTC9A" just above. The prompt asks for H:MM:SS; whatever the model
//  sends back, the client gets the run time in that form, never the
//  model name as a reading, and a primary that still points at the run
//  time after anything is dropped.
// ══════════════════════════════════════════════════════════════════

const { asHms, sanitise, PROMPT } = require('../../utils/timerOcr');
const { PROMPTS } = require('../../utils/aiPrompts');

describe('the prompt', () => {
  it('describes the LTC9A and asks for H:MM:SS read from the right', () => {
    expect(PROMPT).toMatch(/SELEC LTC9A/);
    expect(PROMPT).toMatch(/HOURS:MINUTES:SECONDS/);
    expect(PROMPT).toMatch(/Read from the RIGHT/);
    expect(PROMPT).toMatch(/ALWAYS write the text with both colons, as H:MM:SS/);
    expect(PROMPT).toMatch(/1 and 7/);
    expect(PROMPT).toMatch(/"0:44:17"/);
    expect(PROMPTS['timer-ocr'].version).toBe('v1.1');
  });
});

describe('a run time put back together', () => {
  it.each([
    ['04417', '0:44:17'],      // colons lost, hour blank
    ['0 44 17', '0:44:17'],    // colons read as spaces
    ['0.44.17', '0:44:17'],    // colons read as dots
    ['7.05.30', '7:05:30'],
    ['104417', '10:44:17'],
    ['0:44:17', '0:44:17'],    // already right: as read
    ['07:45:12', '07:45:12'],
    ['7:45', '7:45'],
  ])('%s → %s', (read, expected) => {
    expect(asHms(read)).toBe(expected);
  });

  it('leaves what cannot be a time for the person to check', () => {
    expect(asHms('9:75:10')).toBe('9:75:10');
    expect(asHms('07560')).toBe('07560'); // 75 seconds
    expect(asHms('4417')).toBe('4417');   // too short to be H:MM:SS
    expect(asHms('1234.6')).toBe('1234.6');
  });
});

describe('the reading the client gets', () => {
  it('a run time in H:MM:SS, its alternatives too, without repeats', () => {
    const r = sanitise({
      displays: [{ text: '04417', kind: 'run_time', label: '', confidence: 0.9, alternatives: ['0 44 11', '04417', '0:44:11'] }],
      primary: 0,
    });
    expect(r.displays).toEqual([{ text: '0:44:17', kind: 'run_time', label: '', confidence: 0.9, alternatives: ['0:44:11'] }]);
    expect(r.primary).toBe(0);
  });

  it('never the printed model name as a reading or a label', () => {
    const r = sanitise({
      displays: [
        { text: 'LTC9A', kind: 'other', confidence: 0.99 },
        { text: '0:44:17', kind: 'run_time', label: 'LTC9A', confidence: 0.95 },
      ],
      primary: 1,
    });
    expect(r.displays.map((d) => d.text)).toEqual(['0:44:17']);
    expect(r.displays[0].label).toBe('');
    // Pointed at the second display, which is now the first.
    expect(r.primary).toBe(0);
  });

  it('primary follows its display when one before it is dropped', () => {
    const r = sanitise({
      displays: [
        { text: 'LTC9A', kind: 'other' },
        { text: '04417', kind: 'run_time', confidence: 0.9 },
        { text: '1234.6 h', kind: 'hour_meter', confidence: 0.8 },
      ],
      primary: 1,
    });
    expect(r.displays[r.primary].text).toBe('0:44:17');
  });

  it('a primary on the dropped name falls back to the run time', () => {
    const r = sanitise({
      displays: [{ text: '58213', kind: 'counter' }, { text: 'LTC9A', kind: 'other' }, { text: '0:44:17', kind: 'run_time' }],
      primary: 1,
    });
    expect(r.displays[r.primary].text).toBe('0:44:17');
  });

  it('keeps an hour meter and a counter as they were read', () => {
    const r = sanitise({
      displays: [{ text: '1234.6 h', kind: 'hour_meter' }, { text: '58213', kind: 'counter' }],
      primary: 0,
    });
    expect(r.displays.map((d) => d.text)).toEqual(['1234.6 h', '58213']);
  });
});
