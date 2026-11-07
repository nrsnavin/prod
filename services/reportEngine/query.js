'use strict';
// ══════════════════════════════════════════════════════════════════
//  RUNNING A REPORT: pick, filter, group, total, sort
//
//  run(query, { role, from, to, maxRows }) →
//    { dataset, columns[{key,label,type}], rows, totals, rowCount,
//      truncated, window: { from, to } }
//
//  query = {
//    dataset: 'sales',
//    select:  ['customer', { field: 'taxable', agg: 'sum' }]  or ['*'],
//    where:   [{ field: 'customerGroup', op: '=', value: 'Exporters' }],
//    groupBy: ['customer'],
//    orderBy: [{ key: 'sum_taxable', dir: 'desc' }],
//    limit:   50,
//  }
//  Only the dataset's own fields can be named, and nothing here writes:
//  a query is a description of a table to read, never code to execute.
//  A condition on the date narrows the dates read from the database.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../../utils/ErrorHandler');
const { DATASETS } = require('./datasets');

const AGGS = ['sum', 'count', 'countd', 'avg', 'min', 'max'];
const OPS = ['=', '!=', '<', '<=', '>', '>=', 'contains', 'not contains', 'starts', 'in', 'between', 'not in', 'empty', 'not empty'];
const AGG_WORD = { sum: 'Total', count: 'Count of', avg: 'Average', min: 'Lowest', max: 'Highest' };
// "Taxable value" → "taxable value", but GST and HSN stay as they are.
const soft = (l) => (l === l.toUpperCase() ? l : l.charAt(0).toLowerCase() + l.slice(1));
const plural = (w) => { const l = w.toLowerCase(); return /s$/.test(l) ? l : /[^aeiou]y$/.test(l) ? `${l.slice(0, -1)}ies` : `${l}s`; };
const MAX_ROWS = 5000;
const DAY = 86_400_000;

const bad = (msg) => new ErrorHandler(msg, 400);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** The dataset's field named `name` (by key, snake_case or label), or an error saying what there is. */
function fieldOf(ds, dsId, name) {
  if (name === '*') return '*';
  const n = norm(name);
  const hit = Object.entries(ds.fields).find(([k, f]) => norm(k) === n || norm(f.label) === n);
  if (!hit) throw bad(`"${name}" is not a field of ${dsId}. Fields: ${Object.keys(ds.fields).join(', ')}`);
  return hit[0];
}

function datasetOf(id, role) {
  const key = Object.keys(DATASETS).find((k) => norm(k) === norm(id));
  if (!key) throw bad(`No dataset "${id}". There is: ${Object.keys(DATASETS).join(', ')}`);
  const ds = DATASETS[key];
  if (role && !ds.access.includes(role)) {
    const e = new ErrorHandler(`${ds.label} is for ${ds.access.join(' and ')} only`, 403); throw e;
  }
  return { key, ds };
}

function asComparable(f, v) {
  if (v == null) return v;
  if (f.type === 'number' || f.type === 'money') { const n = Number(String(v).replace(/[,₹\s]/g, '')); if (!Number.isFinite(n)) throw bad(`${f.label} needs a number, not "${v}"`); return n; }
  return String(v);
}

function test(row, c, f) {
  const x = row[c.field];
  const lower = (s) => String(s ?? '').toLowerCase();
  switch (c.op) {
    case '=': return f.type === 'text' ? lower(x) === lower(c.value) : x === c.value;
    case '!=': return f.type === 'text' ? lower(x) !== lower(c.value) : x !== c.value;
    case '<': return x < c.value;
    case '<=': return x <= c.value;
    case '>': return x > c.value;
    case '>=': return x >= c.value;
    case 'contains': return lower(x).includes(lower(c.value));
    case 'not contains': return !lower(x).includes(lower(c.value));
    case 'starts': return lower(x).startsWith(lower(c.value));
    case 'in': return c.value.some((v) => (f.type === 'text' ? lower(v) === lower(x) : v === x));
    case 'not in': return !c.value.some((v) => (f.type === 'text' ? lower(v) === lower(x) : v === x));
    case 'between': return x >= c.value[0] && x <= c.value[1];
    case 'empty': return x == null || x === '';
    case 'not empty': return !(x == null || x === '');
    default: return true;
  }
}

/** The dates to read: a condition on the date wins over the screen's window. */
function windowOf(where, from, to) {
  let a = from; let b = to;
  for (const c of where) {
    if (c.field !== 'date') continue;
    const at = (s) => new Date(`${s}T00:00:00+05:30`);
    if (c.op === '>=' || c.op === '=') a = at(c.value);
    if (c.op === '>') a = new Date(at(c.value).getTime() + DAY);
    if (c.op === '<=' || c.op === '=') b = new Date(at(c.value).getTime() + DAY);
    if (c.op === '<') b = at(c.value);
    if (c.op === 'between') { a = at(c.value[0]); b = new Date(at(c.value[1]).getTime() + DAY); }
  }
  if (!(a instanceof Date) || Number.isNaN(a.getTime()) || !(b instanceof Date) || Number.isNaN(b.getTime())) throw bad('A date in the query is not a date (use YYYY-MM-DD)');
  if (b <= a) throw bad('The dates in the query leave nothing between them');
  if (b - a > 6 * 366 * DAY) throw bad('At most six years at a time');
  return { from: a, to: b };
}

function normalise(query, role) {
  if (!query || typeof query !== 'object') throw bad('Say what to report on');
  const { key, ds } = datasetOf(query.dataset, role);
  const select = (Array.isArray(query.select) && query.select.length ? query.select : ['*']).map((s) => {
    const item = typeof s === 'string' ? { field: s } : { ...s };
    if (item.agg) { item.agg = String(item.agg).toLowerCase(); if (!AGGS.includes(item.agg)) throw bad(`${item.agg} is not one of ${AGGS.join(', ')}`); }
    if (item.field === '*' && item.agg !== 'count' && item.agg) throw bad('Only COUNT(*) can take *');
    item.field = item.field === '*' ? '*' : fieldOf(ds, key, item.field);
    return item;
  });
  const where = (Array.isArray(query.where) ? query.where : []).map((c) => {
    const field = fieldOf(ds, key, c.field);
    const f = ds.fields[field]; const op = String(c.op || '=').toLowerCase();
    if (!OPS.includes(op)) throw bad(`"${c.op}" is not a condition. Use one of ${OPS.join(', ')}`);
    let value = c.value;
    if (op === 'in' || op === 'not in') value = (Array.isArray(value) ? value : String(value ?? '').split(',')).map((v) => asComparable(f, typeof v === 'string' ? v.trim() : v));
    else if (op === 'between') { if (!Array.isArray(value) || value.length !== 2) throw bad(`BETWEEN on ${f.label} needs two values`); value = value.map((v) => asComparable(f, v)); }
    else if (op !== 'empty' && op !== 'not empty') value = asComparable(f, value);
    return { field, op, value };
  });
  const groupBy = (Array.isArray(query.groupBy) ? query.groupBy : []).map((g) => fieldOf(ds, key, g));
  const hasAgg = select.some((s) => s.agg);
  if (groupBy.length || hasAgg) {
    for (const s of select) {
      if (s.field === '*' && !s.agg) throw bad('SELECT * cannot be grouped — name the columns');
      if (!s.agg && !groupBy.includes(s.field)) throw bad(`${ds.fields[s.field].label} must be grouped by, or totalled (SUM, COUNT…)`);
    }
  }
  const limit = query.limit == null ? null : Math.max(1, Math.min(Number(query.limit) || 0, 100_000));
  return { key, ds, select, where, groupBy, orderBy: Array.isArray(query.orderBy) ? query.orderBy : [], limit, hasAgg };
}

function columnsOf(ds, q) {
  if (!q.groupBy.length && !q.hasAgg) {
    const keys = q.select.some((s) => s.field === '*') ? Object.keys(ds.fields) : q.select.map((s) => s.field);
    return keys.map((k) => ({ key: k, label: ds.fields[k].label, type: ds.fields[k].type, field: k }));
  }
  return q.select.map((s) => {
    if (!s.agg) return { key: s.as || s.field, label: s.as || ds.fields[s.field].label, type: ds.fields[s.field].type, field: s.field };
    if (s.agg === 'count') return { key: s.as || (s.field === '*' ? 'count' : `count_${s.field}`), label: s.as || (s.field === '*' ? 'Rows' : `Count of ${soft(ds.fields[s.field].label)}`), type: 'number', agg: 'count', field: s.field };
    if (s.agg === 'countd') { if (s.field === '*') throw bad('COUNT(DISTINCT …) needs a column'); return { key: s.as || `countd_${s.field}`, label: s.as || `Number of ${plural(ds.fields[s.field].label)}`, type: 'number', agg: 'countd', field: s.field }; }
    const f = ds.fields[s.field];
    if (f.type === 'text' && s.agg !== 'min' && s.agg !== 'max') throw bad(`${s.agg.toUpperCase()} needs a number; ${f.label} is text`);
    return { key: s.as || `${s.agg}_${s.field}`, label: s.as || `${AGG_WORD[s.agg]} ${soft(f.label)}`, type: f.type === 'date' ? 'date' : f.type, agg: s.agg, field: s.field };
  });
}

function aggregate(rows, col) {
  if (col.agg === 'count') return col.field === '*' ? rows.length : rows.filter((r) => r[col.field] != null && r[col.field] !== '').length;
  if (col.agg === 'countd') return new Set(rows.map((r) => r[col.field]).filter((v) => v != null && v !== '')).size;
  const vals = rows.map((r) => r[col.field]).filter((v) => v != null && v !== '');
  if (!vals.length) return null;
  if (col.agg === 'sum') return Math.round(vals.reduce((s, v) => s + Number(v), 0) * 1000) / 1000;
  if (col.agg === 'avg') return Math.round((vals.reduce((s, v) => s + Number(v), 0) / vals.length) * 100) / 100;
  if (col.agg === 'min') return vals.reduce((m, v) => (v < m ? v : m));
  return vals.reduce((m, v) => (v > m ? v : m));
}

async function run(query, { role, from, to, maxRows = MAX_ROWS } = {}) {
  const q = normalise(query, role);
  const win = q.ds.dated ? windowOf(q.where, from, to) : null;
  let rows = await q.ds.rows(win || {});
  for (const c of q.where) rows = rows.filter((r) => test(r, c, q.ds.fields[c.field]));
  const columns = columnsOf(q.ds, q);

  let out;
  if (q.groupBy.length || q.hasAgg) {
    const groups = new Map();
    for (const r of rows) {
      const k = JSON.stringify(q.groupBy.map((g) => r[g] ?? ''));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    if (!q.groupBy.length && !groups.size) groups.set('[]', []);
    out = [...groups.values()].map((list) => Object.fromEntries(columns.map((c) => [c.key, c.agg ? aggregate(list, c) : list[0]?.[c.field] ?? ''])));
  } else {
    out = rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.field]])));
  }

  // Sort: as asked, else the first total biggest first, else newest first.
  const order = q.orderBy.length ? q.orderBy.map((o) => {
    const k = columns.find((c) => norm(c.key) === norm(o.key) || norm(c.label) === norm(o.key) || (c.field && norm(c.field) === norm(o.key) && (!o.agg || c.agg === o.agg)));
    if (!k) throw bad(`Cannot sort by "${o.key}" — it is not one of the columns`);
    return { key: k.key, dir: String(o.dir || 'asc').toLowerCase() === 'desc' ? -1 : 1 };
  }) : (() => {
    // Biggest value first: a rupee total, else any total, else a count.
    const total = columns.find((c) => c.agg === 'sum' && c.type === 'money') || columns.find((c) => c.agg === 'sum') || columns.find((c) => c.agg && c.agg !== 'min' && c.agg !== 'max');
    if (total) return [{ key: total.key, dir: -1 }];
    if (columns.some((c) => c.key === 'date')) return [{ key: 'date', dir: -1 }];
    return [];
  })();
  if (order.length) {
    out.sort((a, b) => {
      for (const o of order) {
        const x = a[o.key]; const y = b[o.key];
        if (x === y) continue;
        if (x == null || x === '') return 1;
        if (y == null || y === '') return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * o.dir;
      }
      return 0;
    });
  }

  // Totals over every row that matched, not just the rows shown.
  // A total is worked out over the rows themselves, not by adding up the
  // groups: an invoice with two items is one invoice, an average is the
  // average of every line.
  const totals = {};
  for (const c of columns) {
    if (c.type !== 'number' && c.type !== 'money') continue;
    if (c.agg) { const v = aggregate(rows, c); if (v != null) totals[c.key] = typeof v === 'number' ? Math.round(v * 100) / 100 : v; }
    else if (q.ds.fields[c.field]?.agg === 'sum') totals[c.key] = Math.round(out.reduce((sum, r) => sum + (Number(r[c.key]) || 0), 0) * 100) / 100;
  }
  const rowCount = out.length;
  const cap = Math.min(q.limit || Infinity, maxRows);
  const truncated = rowCount > cap;
  if (out.length > cap) out = out.slice(0, cap);

  return {
    dataset: q.key, datasetLabel: q.ds.label,
    columns: columns.map(({ key, label, type }) => ({ key, label, type })),
    rows: out, totals, rowCount, truncated,
    window: win ? { from: win.from.toISOString(), to: win.to.toISOString() } : null,
  };
}

module.exports = { run, normalise, windowOf, MAX_ROWS, AGGS, OPS };
