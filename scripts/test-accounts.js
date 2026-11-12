#!/usr/bin/env node
'use strict';
// The accounts tests, by themselves: `npm run test:accounts`.
//
// The whole server suite runs in a single worker and takes over half an
// hour, so nobody ran it for a change to the books. These suites (listed
// in tests/accounts-suites.json) cover the accounts module — posting,
// cancelling, two requests at once, bank statements, the statutory
// registers, the migrations that touch the books — and run in about two
// minutes on three workers. Anything after the script's name is passed
// on to jest:  npm run test:accounts -- -t "deposit slip"

const path = require('path');
const { spawnSync } = require('child_process');

const suites = require('../tests/accounts-suites.json');
const jest = require.resolve('jest/bin/jest');
const r = spawnSync(process.execPath, [jest, ...suites, '--maxWorkers=3', ...process.argv.slice(2)], { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(r.status ?? 1);
