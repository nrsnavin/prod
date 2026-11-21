'use strict';
// ══════════════════════════════════════════════════════════════════
//  deploy/deploy.sh — the script run on the box for every deploy
//
//  It is tried end to end on a stand-in box when it changes; these hold
//  the parts that can be checked anywhere: it parses, it refuses what it
//  does not know before touching anything, and its help is its header.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '..', '..', 'deploy', 'deploy.sh');
const run = (args, env = {}) => spawnSync('bash', [script, ...args], {
  encoding: 'utf8',
  env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-home-')), ...env },
});

describe('deploy/deploy.sh', () => {
  it('parses', () => {
    const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('refuses a word it does not know, before it writes anything', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-home-'));
    const r = run(['everything'], { HOME: home });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage: .*deploy\.sh \[all\|api\|web\]/);
    // No log folder: nothing was started.
    expect(fs.existsSync(path.join(home, 'deploy-logs'))).toBe(false);
  });

  it('--help prints the header, which says what each mode does', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/deploy\.sh api {6}the API only/);
    expect(r.stdout).toMatch(/READY_WAIT=90/);
    expect(r.stdout).not.toMatch(/set -Eeuo pipefail/);
  });

  it('runs from a copy of itself, and removes the copy', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('jarvis-deploy.'));
    run(['--help']);
    const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('jarvis-deploy.'));
    expect(after.filter((f) => !before.includes(f))).toEqual([]);
  });
});
