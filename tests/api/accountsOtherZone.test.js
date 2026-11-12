'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE BOOKS DO NOT DEPEND ON THE SERVER'S CLOCK ZONE
//
//  A document's date is the UTC midnight of its day in India. The
//  accounts reports used to cut their months, quarters and financial
//  years with `new Date(y, m, 1)` and getMonth(), which read the zone of
//  the machine. On UTC or India time that agreed with the dates. On a
//  machine west of UTC a month began hours late: tax deducted on the 1st
//  fell into the month before, and the 1st of the next month fell in.
//
//  tests/helpers/zoneProbe.js puts documents on the first and last day
//  of a month into an empty database and asks the reports about them.
//  Here it is run with the clock in four zones, and must say the same
//  thing — the right thing — in each.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const { execFile } = require('child_process');

const PROBE = path.join(__dirname, '..', 'helpers', 'zoneProbe.js');
const ZONES = ['America/Los_Angeles', 'UTC', 'Asia/Kolkata', 'Pacific/Auckland'];

const run = (zone) => new Promise((resolve, reject) => {
  execFile(process.execPath, [PROBE], { env: { ...process.env, TZ: zone }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    const line = String(stdout).split('\n').find((l) => l.startsWith('PROBE'));
    if (err || !line) return reject(new Error(`${zone}: ${err ? err.message : 'no answer'}\n${String(stderr).slice(-600)}`));
    resolve(JSON.parse(line.slice(5)));
  });
});

describe('the accounts reports, with the server\'s clock in another zone', () => {
  let answers;
  beforeAll(async () => { answers = await Promise.all(ZONES.map(run)); }, 300_000);

  it('cut a month, a quarter and a financial year at the same moments', () => {
    for (const a of answers) {
      expect(a.october).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z']);
      expect(a.quarter).toEqual(['2026-10-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z']);
      expect(a.closeMonth).toEqual(['2026-10', '2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z']);
      expect(a.quarterOfFirst).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    }
  });

  it('put a document dated the 1st or the last day in its own month', () => {
    for (const a of answers) {
      // 100 on 1 October + 200 on 31 October; the 400 of 1 November is November's.
      expect(a.tdsOctober).toBe(300);
      expect(a.closeTds).toBe(300);
      expect(a.tdsQuarter).toBe(700);
      expect(a.notDeducted).toEqual(['PB/1', 'PB/2']);
      expect(a.gstOutputTaxable).toBe(2000);
      expect(a.gstr1Invoices).toBe(2);
      expect(a.gstr1Period).toBe('102026');
    }
  });

  it('number a voucher dated 1 April in the new year, and one dated 31 March in the old', () => {
    for (const a of answers) {
      expect([a.fyFirstDay, a.fyLastDay]).toEqual(['2026-27', '2025-26']);
      expect([a.numberFirstDay, a.numberLastDay]).toEqual(['2027-28', '2026-27']);
    }
  });

  it('set due days and limits on the same days', () => {
    for (const a of answers) {
      expect(a.tdsDue).toBe('2026-11-07T00:00:00.000Z');
      expect(a.creditNoteLimit).toBe('2027-11-30T23:59:59.999Z');
      expect(a.itcDeadline).toBe('2027-11-30T23:59:59.999Z');
      expect(a.recurringNext).toBe('2026-11-28T00:00:00.000Z');
      // A date is written as its day in India: a moment at 20:00 UTC on the 31st is already the 1st there.
      expect(a.dmy).toEqual(['01-11-2026', '01-11-2026']);
    }
  });

  it('say the same in every zone', () => {
    for (const a of answers.slice(1)) expect(a).toEqual(answers[0]);
  });
});
