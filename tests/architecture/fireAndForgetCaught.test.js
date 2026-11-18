'use strict';
// ══════════════════════════════════════════════════════════════════
//  WORK STARTED AND NOT WAITED FOR CATCHES ITS OWN FAILURES
//
//  A route that answers and then carries on — an alert, a WhatsApp
//  message, a recount — does it in `(async () => { … })()` with nothing
//  waiting on it. If that throws there is no one to hear it: it is an
//  unhandled rejection, and index.js closes the worker on one. A
//  database hiccup while queueing a stock alert, after the edit was
//  already saved and answered, took the server process down.
//
//  So every such block is one try with a catch (or has .catch on it).
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return d.name.endsWith('.js') ? [p] : [];
  });
}

/** Index of the brace that closes the one at `open`, skipping strings, templates and comments. */
function closing(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '"' || c === "'") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { i = closing(src, i + 1); if (i < 0) return -1; }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** Blocks started and not waited for, that are not one try with a catch. */
function uncaught(src) {
  const found = [];
  const re = /\(\s*async\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    // Waited for, returned, handed on or kept: someone hears it fail.
    const before = stripComments(src.slice(Math.max(0, m.index - 200), m.index)).trimEnd();
    if (/(\bawait|\breturn|=|\(|,|=>|\?|:|\bvoid)$/.test(before) && !/[;{}]$/.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const close = closing(src, open);
    if (close < 0) continue;
    const after = src.slice(close + 1, close + 200);
    if (!/^\s*\)\s*\(\s*\)/.test(after)) continue;               // not called on the spot
    if (/^\s*\)\s*\(\s*\)\s*\.\s*catch\s*\(/.test(after)) continue;
    const body = stripComments(src.slice(open + 1, close)).trim();
    let ok = false;
    if (body.startsWith('try')) {
      const tryOpen = body.indexOf('{');
      const tryClose = closing(body, tryOpen);
      const rest = tryClose > 0 ? body.slice(tryClose + 1).trimStart() : '';
      if (rest.startsWith('catch')) {
        const catchOpen = rest.indexOf('{');
        const catchClose = closing(rest, catchOpen);
        const tail = catchClose > 0 ? rest.slice(catchClose + 1).trim() : 'x';
        ok = tail === '' || /^finally\s*\{[\s\S]*\}$/.test(tail);
      }
    }
    if (!ok) found.push(src.slice(0, m.index).split('\n').length);
  }
  return found;
}

describe('work started and not waited for', () => {
  it('is one try with a catch, in every route, service and utility', () => {
    const offenders = [];
    for (const dir of ['api', 'services', 'utils', 'middleware']) {
      for (const f of files(path.join(ROOT, dir))) {
        for (const line of uncaught(fs.readFileSync(f, 'utf8'))) offenders.push(`${path.relative(ROOT, f)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CONTROL: the check sees a bare block, and passes a caught one', () => {
    expect(uncaught('res.json({});\n(async () => {\n  await enqueue(1);\n})();\n')).toEqual([2]);
    expect(uncaught('res.json({});\n(async () => {\n  let a = 1;\n  try { await x(); } catch (e) { }\n  await y();\n})();\n')).toEqual([2]);
    expect(uncaught('res.json({});\n(async () => {\n  // why\n  try { await x(`${a}}`); } catch (e) { log("}"); }\n})();\n')).toEqual([]);
    expect(uncaught('res.json({});\n(async () => { await x(); })().catch(() => {});\n')).toEqual([]);
    expect(uncaught('const r = await (async () => { await x(); })();\n')).toEqual([]);
    expect(uncaught('return (async () => { await x(); })();\n')).toEqual([]);
  });
});
