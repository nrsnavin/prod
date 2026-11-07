'use strict';
// ══════════════════════════════════════════════════════════════════
//  A SIMPLE SQL, TURNED INTO A REPORT QUERY
//
//    SELECT customer, SUM(taxable) AS sales
//    FROM sales
//    WHERE date >= '2026-04-01' AND customer_group = 'Exporters'
//    GROUP BY customer
//    ORDER BY sales DESC
//    LIMIT 20
//
//  Supported: SELECT * | field | SUM/COUNT/AVG/MIN/MAX(field) [AS name],
//  COUNT(*), COUNT(DISTINCT field); FROM one dataset; WHERE conditions joined by AND, with
//  = != <> < <= > >= LIKE 'x%' / NOT LIKE, IN (…), NOT IN (…),
//  BETWEEN a AND b, IS [NOT] NULL; GROUP BY; ORDER BY … ASC|DESC; LIMIT.
//  It only reads: there is no INSERT, UPDATE, DELETE, join or sub-query,
//  and the result is checked against the dataset's fields like any
//  other query (services/reportEngine/query.js).
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../../utils/ErrorHandler');

const bad = (msg) => new ErrorHandler(msg, 400);
const KEYWORDS = new Set(['select', 'from', 'where', 'group', 'by', 'order', 'limit', 'and', 'or', 'as', 'asc', 'desc', 'in', 'not', 'like', 'between', 'is', 'null']);
const ALIASES = { grn: 'goods_received', inward: 'goods_received', issues: 'material_issues', receipts: 'vouchers', payments: 'vouchers', bills: 'purchases', invoices: 'sales' };

function tokens(sql) {
  const out = []; let i = 0;
  const s = String(sql || '');
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1; let v = '';
      while (j < s.length) {
        if (s[j] === ch && s[j + 1] === ch) { v += ch; j += 2; continue; }
        if (s[j] === ch) break;
        v += s[j]; j += 1;
      }
      if (j >= s.length) throw bad('A quote is not closed');
      out.push(ch === "'" ? { t: 'str', v } : { t: 'id', v }); i = j + 1; continue;
    }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '!=', '<>'].includes(two)) { out.push({ t: 'op', v: two === '<>' ? '!=' : two }); i += 2; continue; }
    if ('=<>'.includes(ch)) { out.push({ t: 'op', v: ch }); i += 1; continue; }
    if ('(),*;'.includes(ch)) { out.push({ t: ch }); i += 1; continue; }
    const num = s.slice(i).match(/^-?\d+(\.\d+)?/);
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const word = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (word) { const w = word[0]; out.push(KEYWORDS.has(w.toLowerCase()) ? { t: 'kw', v: w.toLowerCase() } : { t: 'id', v: w }); i += w.length; continue; }
    throw bad(`Cannot read "${s.slice(i, i + 10)}"`);
  }
  return out;
}

function parse(sql) {
  const tk = tokens(sql).filter((t) => t.t !== ';');
  let p = 0;
  const peek = (o = 0) => tk[p + o];
  const isKw = (v, o = 0) => peek(o)?.t === 'kw' && peek(o).v === v;
  const take = () => tk[p++];
  const expect = (cond, msg) => { if (!cond) throw bad(msg); };
  const kw = (v) => { expect(isKw(v), `Expected ${v.toUpperCase()}${peek() ? ` near "${peek().v ?? peek().t}"` : ' at the end'}`); take(); };
  const ident = (what) => { const t = take(); expect(t && t.t === 'id', `Expected ${what}${t ? ` near "${t.v ?? t.t}"` : ''}`); return t.v; };
  const value = () => {
    const t = take();
    if (t?.t === 'str' || t?.t === 'num') return t.v;
    if (t?.t === 'kw' && t.v === 'null') return null;
    throw bad(`Expected a value${t ? ` near "${t.v ?? t.t}"` : ''} — put text and dates in single quotes`);
  };

  kw('select');
  const select = [];
  do {
    if (peek()?.t === ',') take();
    if (peek()?.t === '*') { take(); select.push('*'); continue; }
    const name = ident('a column');
    let item;
    if (peek()?.t === '(') {
      take();
      const agg = name.toLowerCase();
      expect(['sum', 'count', 'avg', 'min', 'max'].includes(agg), `${name}() is not supported — use SUM, COUNT, AVG, MIN or MAX`);
      let field; let distinct = false;
      if (peek()?.t === 'id' && peek().v.toLowerCase() === 'distinct') { take(); distinct = true; expect(agg === 'count', 'DISTINCT goes with COUNT'); }
      if (peek()?.t === '*') { take(); field = '*'; } else field = ident('a column inside the brackets');
      expect(take()?.t === ')', 'A bracket is not closed');
      item = { field, agg: distinct ? 'countd' : agg };
    } else item = { field: name };
    if (isKw('as')) { take(); item.as = ident('a name after AS'); }
    select.push(item);
  } while (peek()?.t === ',');

  kw('from');
  let dataset = ident('a dataset after FROM').toLowerCase();
  dataset = ALIASES[dataset] || dataset;

  const where = [];
  if (isKw('where')) {
    take();
    do {
      if (isKw('and')) take();
      expect(!isKw('or'), 'OR is not supported — use IN (…) for one of several values');
      const field = ident('a column in WHERE');
      if (isKw('is')) {
        take(); const not = isKw('not'); if (not) take(); kw('null');
        where.push({ field, op: not ? 'not empty' : 'empty' });
      } else if (isKw('between')) {
        take(); const a = value(); kw('and'); const b = value();
        where.push({ field, op: 'between', value: [a, b] });
      } else if (isKw('not') && (isKw('in', 1) || isKw('like', 1))) {
        take();
        if (isKw('in')) { take(); where.push({ field, op: 'not in', value: list() }); } else { take(); const v = String(value()); where.push(likeOf(field, v, true)); }
      } else if (isKw('in')) {
        take(); where.push({ field, op: 'in', value: list() });
      } else if (isKw('like')) {
        take(); where.push(likeOf(field, String(value()), false));
      } else {
        const op = take(); expect(op?.t === 'op', `Expected =, <, >, LIKE, IN or BETWEEN after ${field}`);
        where.push({ field, op: op.v, value: value() });
      }
    } while (isKw('and'));
    expect(!isKw('or'), 'OR is not supported — use IN (…) for one of several values');
  }
  function list() {
    expect(take()?.t === '(', 'IN needs a list in brackets, like IN (\'A\', \'B\')');
    const vals = [value()];
    while (peek()?.t === ',') { take(); vals.push(value()); }
    expect(take()?.t === ')', 'The IN list is not closed');
    return vals;
  }
  function likeOf(field, v, not) {
    const core = v.replace(/^%/, '').replace(/%$/, '');
    if (not) return { field, op: '!=', value: core, notLike: true };
    if (v.startsWith('%') || !v.endsWith('%')) return { field, op: v.includes('%') ? 'contains' : '=', value: core };
    return { field, op: 'starts', value: core };
  }

  const groupBy = [];
  if (isKw('group')) { take(); kw('by'); do { if (peek()?.t === ',') take(); groupBy.push(ident('a column in GROUP BY')); } while (peek()?.t === ','); }

  const orderBy = [];
  if (isKw('order')) {
    take(); kw('by');
    do {
      if (peek()?.t === ',') take();
      const name = ident('a column in ORDER BY');
      let key = name; let agg;
      if (peek()?.t === '(') { take(); agg = name.toLowerCase(); key = peek()?.t === '*' ? (take(), '*') : ident('a column'); expect(take()?.t === ')', 'A bracket is not closed'); key = key === '*' ? 'count' : key; }
      let dir = 'asc';
      if (isKw('asc') || isKw('desc')) dir = take().v;
      orderBy.push({ key: agg && key !== 'count' ? `${agg}_${key}` : key, dir, agg });
    } while (peek()?.t === ',');
  }

  let limit = null;
  if (isKw('limit')) { take(); const t = take(); expect(t?.t === 'num' && t.v > 0, 'LIMIT needs a number'); limit = Math.floor(t.v); }
  expect(p >= tk.length, `Did not understand "${peek()?.v ?? peek()?.t}" — only SELECT … FROM … WHERE … GROUP BY … ORDER BY … LIMIT`);

  // NOT LIKE '%x%' is the one condition the query has no word for: kept as a filter the runner understands.
  return { dataset, select, where: where.map((c) => (c.notLike ? { field: c.field, op: 'not contains', value: c.value } : c)), groupBy, orderBy, limit };
}

module.exports = { parse, tokens };
