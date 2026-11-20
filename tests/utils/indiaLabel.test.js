'use strict';
// ══════════════════════════════════════════════════════════════════
//  NO DATE IS WRITTEN IN THE SERVER'S ZONE
//
//  The server runs on UTC. Fifty labels across the PDFs, the alerts and
//  the messages were written with toLocaleDateString() and no time
//  zone, which writes them in the server's:
//
//    • every "Generated …" stamp on the MRP, order status, material
//      ledger, warping programme and order P&L PDFs printed the time
//      five and a half hours behind;
//    • the daily wastage alert named the day BEFORE the one it was
//      about, every day — its day starts at 00:00 in India, which is
//      18:30 UTC the evening before;
//    • anything stamped between midnight and 05:30 (a complaint, a
//      bonus payment, a warping) carried the day before.
//
//  They all go through utils/indiaLabel.js now. The second half of this
//  file reads the server's source and refuses a new one.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { indiaDay, indiaDateTime } = require('../../utils/indiaLabel');
const factoryDay = require('../../utils/factoryDay');

describe('indiaDay', () => {
  it('writes a calendar date as itself', () => {
    expect(indiaDay(new Date('2026-11-18T00:00:00Z'))).toBe('18 Nov 2026');
  });

  it('writes a moment after midnight in India as that day, not the one before', () => {
    // 00:30 on the 18th in India is 19:00 UTC on the 17th.
    expect(indiaDay(new Date('2026-11-17T19:00:00Z'))).toBe('18 Nov 2026');
    expect(indiaDay('2026-11-17T19:00:00.000Z')).toBe('18 Nov 2026');
  });

  it('writes the start of an India day as that day', () => {
    const start = factoryDay.dayStart('2026-11-18');
    expect(start.toISOString()).toBe('2026-11-17T18:30:00.000Z');
    expect(indiaDay(start)).toBe('18 Nov 2026');
  });

  it("writes a day's last millisecond as that day, not the next", () => {
    // 23:59:59.999 UTC is 05:29 the next morning in India.
    expect(indiaDay(factoryDay.calendarDayEnd('2026-11-18'))).toBe('18 Nov 2026');
    expect(indiaDay(new Date('2026-03-31T23:59:59.999Z'), { month: 'long', year: 'numeric' })).toBe('March 2026');
  });

  it('takes a plain date string, and the options Intl takes', () => {
    expect(indiaDay('2026-11-18')).toBe('18 Nov 2026');
    expect(indiaDay('2026-11-18', {})).toBe('18/11/2026');
    expect(indiaDay('2026-11-18', { weekday: 'short' })).toBe('Wed');
    expect(indiaDay('2026-11-18', { day: 'numeric', month: 'short' })).toBe('18 Nov');
    expect(indiaDay(new Date(Date.UTC(2026, 10, 1)), { month: 'long', year: 'numeric' })).toBe('November 2026');
  });

  it('writes nothing for what is not a date', () => {
    for (const v of [null, undefined, '', 'soon', new Date('nope')]) expect(indiaDay(v)).toBe('');
  });

  it('cannot be talked into another zone', () => {
    expect(indiaDay(new Date('2026-11-17T19:00:00Z'), { timeZone: 'America/New_York', day: '2-digit', month: 'short', year: 'numeric' })).toBe('18 Nov 2026');
  });
});

describe('indiaDateTime', () => {
  it("writes a moment on the factory's clock", () => {
    // 08:35 UTC is 14:05 in India.
    expect(indiaDateTime(new Date('2026-11-18T08:35:00Z'))).toBe('18 Nov 2026, 02:05 pm');
    expect(indiaDateTime('2026-11-17T19:00:00Z')).toBe('18 Nov 2026, 12:30 am');
  });

  it('means now when given nothing, and writes nothing for what is not a moment', () => {
    expect(indiaDateTime()).toMatch(/^\d{2} \w{3} \d{4}, \d{2}:\d{2} [ap]m$/);
    for (const v of [null, '', 'soon']) expect(indiaDateTime(v)).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════
//  The whole server, held to it.
// ══════════════════════════════════════════════════════════════════
describe('every date the server writes names its zone', () => {
  const root = path.join(__dirname, '../..');
  const DATE_PART = /\b(day|month|year|hour|minute|second|weekday|dateStyle|timeStyle)\s*:/;

  /** Source files that run in production. */
  function sources() {
    const out = [];
    for (const base of ['api', 'services', 'utils', 'models', 'middleware', 'server', 'db', 'domain']) {
      (function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, f.name);
          if (f.isDirectory()) walk(full);
          else if (f.name.endsWith('.js')) out.push(full);
        }
      })(path.join(root, base));
    }
    for (const f of ['app.js', 'index.js']) out.push(path.join(root, f));
    return out;
  }

  /** The argument list of the call opening at `open` (index of its "("). */
  function argsAt(src, open) {
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) return src.slice(open + 1, i); }
    }
    return src.slice(open + 1);
  }

  /** Calls that write a date or a time and say no zone. */
  function zoneless(src) {
    const found = [];
    const re = /\.toLocale(Date|Time)?String\(/g;
    let m;
    while ((m = re.exec(src))) {
      const args = argsAt(src, m.index + m[0].length - 1);
      // `new Date(…).toLocaleString('en-IN')` writes a date and a time with no
      // option that says so: known by what it is called on. Two of these got
      // past the check (a report's "Generated:" line, the skipped-digest notice).
      const onADate = /new Date\([^()]*(\([^()]*\)[^()]*)*\)\s*$/.test(src.slice(Math.max(0, m.index - 200), m.index));
      const writesADate = m[1] === 'Date' || m[1] === 'Time' || DATE_PART.test(args) || onADate;
      if (writesADate && !/timeZone/.test(args)) {
        found.push(src.slice(0, m.index).split('\n').length);
      }
    }
    return found;
  }

  it('the check itself tells the three kinds apart', () => {
    expect(zoneless("x.toLocaleDateString('en-IN', { day: '2-digit' })")).toEqual([1]);
    expect(zoneless("x.toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit' })")).toEqual([1]);
    expect(zoneless("x.toLocaleTimeString()")).toEqual([1]);
    expect(zoneless("`Generated: ${new Date().toLocaleString('en-IN')}`")).toEqual([1]);
    expect(zoneless("new Date(last.createdAt).toLocaleString('en-IN')")).toEqual([1]);
    expect(zoneless("new Date(Date.now() - 5).toLocaleString()")).toEqual([1]);
    // A number is not a date.
    expect(zoneless("n.toLocaleString('en-IN', { maximumFractionDigits: 2 })")).toEqual([]);
    expect(zoneless("new Date(x).getTime().toLocaleString('en-IN')")).toEqual([]);
    expect(zoneless("n.toLocaleString('en-IN')")).toEqual([]);
    // A date that names its zone is fine.
    expect(zoneless("x.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit' })")).toEqual([]);
    expect(zoneless("x.toLocaleDateString('en-IN', {\n  day: 'numeric', timeZone: 'UTC' })")).toEqual([]);
  });

  it('finds none in the server', () => {
    const offenders = [];
    for (const file of sources()) {
      for (const line of zoneless(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(root, file)}:${line}`);
      }
    }
    // Write it with utils/indiaLabel.js (indiaDay / indiaDateTime), or
    // give the call a timeZone if it is something those two do not cover.
    expect(offenders).toEqual([]);
  });
});
