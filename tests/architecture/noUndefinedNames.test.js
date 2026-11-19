'use strict';
// ══════════════════════════════════════════════════════════════════
//  EVERY NAME THE SERVER USES IS ONE IT HAS
//
//  A route took a date with a helper it never imported:
//
//      cfg.bonusDate = dayFrom(bonusDate, "bonusDate", null);
//
//  Nothing complains about that until the line runs. The file loads, the
//  server starts, every other route in it works — and saving the Diwali
//  date in the bonus settings answered with a server error, because
//  `dayFrom` was not defined. No test had ever sent that field through
//  the route, so the suite was green.
//
//  JavaScript finds out at run time; this finds out here. Every source
//  file is parsed and each name it refers to must be declared in it,
//  imported into it, or be one the language or Node provides.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
// The parser Jest itself runs on: present wherever these tests run.
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['api', 'services', 'utils', 'models', 'middleware', 'scripts', 'migrations'];
const TOP = ['app.js', 'index.js'];

function sources(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : sources(p);
    return /\.c?js$/.test(d.name) ? [p] : [];
  });
}

// What a file may use without declaring it: the language's own names and
// the ones Node gives every module.
const PROVIDED = new Set([
  // module scope
  'require', 'module', 'exports', '__dirname', '__filename',
  // Node
  'process', 'Buffer', 'console', 'global', 'globalThis',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask',
  'URL', 'URLSearchParams', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder', 'structuredClone', 'performance', 'crypto',
  'atob', 'btoa', 'ReadableStream', 'WritableStream', 'TransformStream', 'EventTarget', 'Event',
  // the language
  'undefined', 'NaN', 'Infinity', 'arguments', 'eval',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Function', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise', 'Proxy', 'Reflect', 'Intl', 'Iterator',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Atomics', 'WebAssembly',
  'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);

/** Names a file refers to that nothing in it declares: [{ name, line }]. */
function undefinedNames(src) {
  const ast = parser.parse(src, { sourceType: 'script', allowReturnOutsideFunction: true });
  let found = [];
  traverse(ast, {
    Program(program) {
      found = Object.entries(program.scope.globals)
        .filter(([name]) => !PROVIDED.has(name))
        .map(([name, node]) => ({ name, line: node.loc?.start.line ?? 0 }));
      program.stop();
    },
  });
  return found;
}

describe('the check itself', () => {
  it('sees a helper used and never imported', () => {
    expect(undefinedNames('const a = 1;\nfunction f(x) { return dayFrom(x, a); }\n'))
      .toEqual([{ name: 'dayFrom', line: 2 }]);
  });

  it('is quiet about what is declared, imported, or a parameter — in any order', () => {
    const src = `
      const { dayFrom } = require('./requestDate');
      function f(x, { y = later() } = {}) { try { return dayFrom(x) + y + hoisted(); } catch (err) { return err.message; } }
      function hoisted() { return new Date().getTime(); }
      const later = () => process.env.TZ;
      class A { m() { return A.name; } }
      for (const [k, v] of Object.entries({})) console.log(k, v);
      module.exports = { f, A };
    `;
    expect(undefinedNames(src)).toEqual([]);
  });
});

describe('every name the server uses', () => {
  const all = [...DIRS.flatMap((d) => sources(path.join(ROOT, d))), ...TOP.map((f) => path.join(ROOT, f))];

  it('finds the source to check', () => {
    expect(all.length).toBeGreaterThan(400);
  });

  it('is declared, imported, or provided', () => {
    const problems = [];
    for (const file of all) {
      const rel = path.relative(ROOT, file);
      let names;
      try {
        names = undefinedNames(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        problems.push(`${rel}: could not be read as JavaScript (${err.message})`);
        continue;
      }
      for (const { name, line } of names) problems.push(`${rel}:${line}  ${name} is not defined`);
    }
    expect(problems).toEqual([]);
  });
});
