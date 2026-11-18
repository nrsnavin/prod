'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT A BROWSER MAY KEEP OF THE WEB APP
//
//  The web app and the customer portal are static files served by the
//  Caddy in deploy/Caddyfile. Every file under /assets/ has a hash of
//  its contents in its name; index.html is the one file that names
//  them. So there are three rules, and the config broke two of them
//  without a single error anywhere:
//
//    • "Never cache index.html" was written for the address
//      /index.html. Nobody opens that address — the app is opened at /,
//      /orders, /settings — so the page went out with no rule at all,
//      and a browser was free to keep it for hours. A deploy was on the
//      server and not on the screen.
//
//    • The fallback that turns /orders into index.html also applied
//      under /assets/. A tab opened before a deploy asks for last
//      build's file; it was sent the app's page, as a 200, marked
//      "immutable" for a year — HTML where a script was asked for,
//      which the app cannot tell from a real answer, kept for good.
//
//  Each rule below was run against a real Caddy when it was written
//  (the answers are in the commit message). Caddy is not on the test
//  machine, so here the config's own text is held to the same rules.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '../../deploy/Caddyfile'), 'utf8');

/**
 * A Caddyfile as nested blocks. `head` is the line that opened the
 * block without its brace ("handle /assets/*"), `lines` its own
 * one-line entries, `blocks` the blocks inside it. Comments are dropped.
 */
function parse(src) {
  const root = { head: '', lines: [], blocks: [] };
  const stack = [root];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '}') { stack.pop(); continue; }
    if (line.endsWith(' {')) {
      const block = { head: line.slice(0, -2).trim(), lines: [], blocks: [] };
      stack[stack.length - 1].blocks.push(block);
      stack.push(block);
      continue;
    }
    stack[stack.length - 1].lines.push(line);
  }
  if (stack.length !== 1) throw new Error('deploy/Caddyfile: braces do not pair up');
  return root;
}

const tree = parse(text);
const siteOf = (host) => tree.blocks.find((b) => b.head === host);

/** Named matchers of a block: { '@gone': ['not file'], '@there': ['file', 'not path *\/'] }. */
function matchersOf(block) {
  const out = {};
  for (const b of block.blocks) if (b.head.startsWith('@')) out[b.head] = b.lines;
  for (const l of block.lines) {
    const m = /^(@\S+)\s+(.+)$/.exec(l);
    if (m) out[m[1]] = [m[2]];
  }
  return out;
}

/** A block's Cache-Control rules: `on` is the matcher they are tied to, '' for every request. */
function cacheRules(block) {
  return block.lines
    .map((l) => /^header\s+(?:(\S+)\s+)?Cache-Control\s+"([^"]*)"$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ on: m[1] || '', value: m[2] }));
}

/** Every block of a site, itself included. */
function everyBlock(block) {
  return [block, ...block.blocks.flatMap(everyBlock)];
}

describe('the parser reads the file', () => {
  it('finds the API and the two static sites', () => {
    expect(tree.blocks.map((b) => b.head)).toEqual(
      expect.arrayContaining(['api.baluelastics.com', 'erp.baluelastics.com', 'portal.baluelastics.com'])
    );
  });

  it('reads one-line and braced matchers alike', () => {
    const t = parse('site {\n\t@a path /x/*\n\t@b {\n\t\tfile\n\t\tnot path */\n\t}\n\theader @a Cache-Control "no-cache"\n}\n');
    expect(matchersOf(t.blocks[0])).toEqual({ '@a': ['path /x/*'], '@b': ['file', 'not path */'] });
    expect(cacheRules(t.blocks[0])).toEqual([{ on: '@a', value: 'no-cache' }]);
  });
});

// A block that is not there reads as an empty one, so the test that
// misses it says what it expected instead of throwing on `undefined`.
const NONE = { head: '', lines: [], blocks: [] };

describe.each(['erp.baluelastics.com', 'portal.baluelastics.com'])('%s', (host) => {
  const site = siteOf(host) || NONE;
  const hashed = site.blocks.find((b) => b.head === 'handle /assets/*') || NONE;
  const rest = site.blocks.find((b) => b.head === 'handle') || NONE;

  it('answers hashed files and everything else in separate blocks', () => {
    expect(hashed).not.toBe(NONE);
    expect(rest).not.toBe(NONE);
    // A fallback or a cache rule on the site itself applies to both
    // kinds of request, which is how the two rules got crossed.
    expect(site.lines.filter((l) => /^(try_files|rewrite|file_server)\b/.test(l))).toEqual([]);
    expect(cacheRules(site)).toEqual([]);
  });

  it('keeps a hashed file for a year only when the file is there', () => {
    const matchers = matchersOf(hashed);
    const forGood = cacheRules(hashed).filter((r) => /immutable/.test(r.value));
    expect(forGood.map((r) => r.value)).toEqual(['public, max-age=31536000, immutable']);
    const when = matchers[forGood[0].on] || [];
    expect(when).toContain('file');
    expect(when.some((c) => /^not\s+file\b/.test(c))).toBe(false);
    // Nothing in this block is cached without a condition.
    expect(cacheRules(hashed).filter((r) => r.on === '')).toEqual([]);
  });

  it('answers a hashed file that is gone with a 404, never with the page', () => {
    expect(hashed.lines).toContain('file_server');
    expect(hashed.lines.filter((l) => /^(try_files|rewrite)\b/.test(l))).toEqual([]);
    const matchers = matchersOf(hashed);
    const notKept = cacheRules(hashed).filter((r) => r.value === 'no-store');
    expect(notKept).toHaveLength(1);
    expect(matchers[(notKept[0] || {}).on]).toEqual(['not file']);
  });

  it('has the page checked with the server however it is asked for', () => {
    // On every request of the block: /, /orders and /settings are all
    // index.html by the time they are answered.
    expect(cacheRules(rest)).toEqual([{ on: '', value: 'no-cache' }]);
    expect(rest.lines).toContain('try_files {path} /index.html');
    expect(rest.lines).toContain('file_server');
  });

  it('ties no cache rule to one address', () => {
    const tied = everyBlock(site).flatMap(cacheRules).filter((r) => r.on.startsWith('/'));
    expect(tied).toEqual([]);
  });
});

describe('the portal', () => {
  it('still keeps customers\' pages out of search results, on every answer', () => {
    expect((siteOf('portal.baluelastics.com') || NONE).lines).toContain('header X-Robots-Tag "noindex"');
  });
});
