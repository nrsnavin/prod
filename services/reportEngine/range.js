'use strict';
// The period a report covers, in India's business days: a preset or
// from/to (YYYY-MM-DD, both inclusive) → { from, to, label } with `to`
// the start of the day after, so the last day is counted whole.

const ErrorHandler = require('../../utils/ErrorHandler');

const DAY = 86_400_000;
const istToday = (now = new Date()) => new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
const at = (ymd) => new Date(`${ymd}T00:00:00+05:30`);
const addDays = (ymd, n) => new Date(at(ymd).getTime() + n * DAY + 5.5 * 3600_000).toISOString().slice(0, 10);
const nice = (ymd) => at(ymd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

const PRESETS = ['today', 'yesterday', 'week', 'month', 'last_month', 'quarter', 'fy', 'last_fy', 'custom'];

function resolve({ preset, from, to } = {}, now = new Date()) {
  const today = istToday(now);
  const [y, m] = today.split('-').map(Number);
  const fyStartYear = m >= 4 ? y : y - 1;
  const first = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}-01`;
  let a; let b; let label;
  const p = from || to ? 'custom' : (preset || 'month');
  switch (p) {
    case 'today': a = today; b = today; label = 'Today'; break;
    case 'yesterday': a = addDays(today, -1); b = a; label = 'Yesterday'; break;
    case 'week': { const dow = (at(today).getUTCDay() + 6) % 7; a = addDays(today, -dow); b = today; label = 'This week'; break; }
    case 'month': a = first(y, m); b = today; label = 'This month'; break;
    case 'last_month': { const lm = m === 1 ? 12 : m - 1; const ly = m === 1 ? y - 1 : y; a = first(ly, lm); b = addDays(first(y, m), -1); label = 'Last month'; break; }
    case 'quarter': { const qm = Math.floor((m - 1) / 3) * 3 + 1; a = first(y, qm); b = today; label = 'This quarter'; break; }
    case 'fy': a = `${fyStartYear}-04-01`; b = today; label = `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`; break;
    case 'last_fy': a = `${fyStartYear - 1}-04-01`; b = `${fyStartYear}-03-31`; label = `FY ${fyStartYear - 1}-${String(fyStartYear).slice(2)}`; break;
    case 'custom': {
      const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(at(s).getTime());
      a = from || to; b = to || from;
      if (!ok(a) || !ok(b)) throw new ErrorHandler('Dates must be YYYY-MM-DD', 400);
      if (b < a) throw new ErrorHandler('The end date is before the start date', 400);
      label = a === b ? nice(a) : `${nice(a)} – ${nice(b)}`;
      break;
    }
    default: throw new ErrorHandler(`Period must be one of ${PRESETS.join(', ')}`, 400);
  }
  return { from: at(a), to: at(addDays(b, 1)), label, preset: p, fromDay: a, toDay: b };
}

module.exports = { resolve, PRESETS, istToday };
