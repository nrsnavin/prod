'use strict';
// ══════════════════════════════════════════════════════════════════
//  NO PARALLEL OPERATIONS ON ONE TRANSACTION'S SESSION
//
//  MongoDB does not support running operations in parallel inside one
//  transaction. Two that both try to start it can fail ("Given
//  transaction number does not match any in-progress transactions"),
//  intermittently and only under load. Four places did it with
//  Promise.all; this keeps it from coming back. A Promise.all whose
//  arguments mention a session (or a withSession helper) fails here.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return d.name.endsWith('.js') || d.name.endsWith('.cjs') ? [p] : [];
  });
}

function parallelSessionCalls(src) {
  const found = [];
  const re = /Promise\.all\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let end = m.index;
    for (let i = src.indexOf('(', m.index); i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) { end = i; break; }
    }
    const args = src.slice(m.index, end);
    if (/\bsession\b|withSession\(/.test(args)) {
      found.push(src.slice(0, m.index).split('\n').length);
    }
  }
  return found;
}

it('runs every operation in a transaction one after the other', () => {
  const root = path.join(__dirname, '..', '..');
  const offenders = ['api', 'services', 'utils', 'domain']
    .flatMap((d) => files(path.join(root, d)))
    .flatMap((f) => parallelSessionCalls(fs.readFileSync(f, 'utf8'))
      .map((line) => `${path.relative(root, f)}:${line}`));
  expect(offenders).toEqual([]);
});

it('would catch one', () => {
  expect(parallelSessionCalls('await Promise.all([A.find().session(session), B.find().session(session)])')).toEqual([1]);
  expect(parallelSessionCalls('await Promise.all([a(), b()])')).toEqual([]);
});
