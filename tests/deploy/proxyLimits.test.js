'use strict';
// ══════════════════════════════════════════════════════════════════
//  THE PROXY LETS THROUGH WHAT THE APP ACCEPTS
//
//  Three numbers have to nest, and were set in three places by three
//  people: how big a file the app takes (each upload route's own limit),
//  how big a request the proxy in front of it passes, and how long the
//  proxy waits for an answer against how long the app may take to read a
//  photo. They did not nest:
//
//    • the app takes a 25 MB scanned sheet and 10 MB bills; both proxy
//      configs stopped at 6 MB — a 413 page of HTML instead of an answer;
//    • a photo read by the model is given 90 s and one retry; nginx hung
//      up at 60 s, while the server finished and paid for the read.
//
//  The deploy configs are files in this repository, so they are held to
//  the app's own numbers here.
// ══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const MB = 1024 * 1024;

/** The largest file any upload route accepts, in bytes. */
function largestUpload() {
  let max = 0;
  const dir = path.join(root, 'api');
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, f.name);
      if (f.isDirectory()) { walk(full); continue; }
      if (!f.name.endsWith('.js')) continue;
      for (const m of fs.readFileSync(full, 'utf8').matchAll(/(\d+)\s*\*\s*1024\s*\*\s*1024/g)) max = Math.max(max, Number(m[1]) * MB);
    }
  })(dir);
  return max;
}

const sizeOf = (text) => {
  const m = /^(\d+)\s*(m|mb)$/i.exec(String(text).trim());
  return m ? Number(m[1]) * MB : NaN;
};

describe('upload size', () => {
  const app = largestUpload();

  it('the scan finds the app\'s limits', () => {
    expect(app).toBeGreaterThanOrEqual(20 * MB);
  });

  it('nginx passes the largest file the app accepts', () => {
    const m = /^\s*client_max_body_size\s+(\S+);/m.exec(read('deploy/nginx-jarvis.conf'));
    expect(m).toBeTruthy();
    expect(sizeOf(m[1])).toBeGreaterThan(app);
  });

  it('Caddy passes the largest file the app accepts', () => {
    const m = /request_body\s*\{\s*max_size\s+(\S+)\s*\}/.exec(read('deploy/Caddyfile'));
    expect(m).toBeTruthy();
    expect(sizeOf(m[1])).toBeGreaterThan(app);
  });
});

describe('how long the proxy waits', () => {
  it('nginx outlasts the longest read the app will make', () => {
    const { longestCallMs } = require('../../utils/aiGateway');
    const m = /^\s*proxy_read_timeout\s+(\d+)s;/m.exec(read('deploy/nginx-jarvis.conf'));
    expect(m).toBeTruthy();
    expect(Number(m[1]) * 1000).toBeGreaterThan(longestCallMs());
  });
});
