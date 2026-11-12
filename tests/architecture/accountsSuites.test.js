'use strict';
// `npm run test:accounts` runs the suites listed in tests/accounts-suites.json.
// A suite renamed or deleted without the list being told would simply
// stop running there, and nobody would notice: this says so.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const suites = require('../accounts-suites.json');

describe('the accounts test group', () => {
  it('lists only suites that exist, each once', () => {
    expect(suites.length).toBeGreaterThan(40);
    expect(new Set(suites).size).toBe(suites.length);
    const missing = suites.filter((s) => !fs.existsSync(path.join(root, s)));
    expect(missing).toEqual([]);
  });

  it('includes every test file whose name says it is about the accounts', () => {
    const named = fs.readdirSync(path.join(root, 'tests', 'api')).filter((f) => /^(accounts|bank|statutory|registers|statement)/i.test(f) && f.endsWith('.test.js')).map((f) => `tests/api/${f}`);
    expect(named.filter((f) => !suites.includes(f))).toEqual([]);
  });
});
