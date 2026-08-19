'use strict';
const { databaseNamedIn } = require('../../db/Database');

// ══════════════════════════════════════════════════════════════════
//  A URI THAT NAMES NO DATABASE STILL CONNECTS
//
//  MongoDB puts the database in the URI PATH. Leave it out and the
//  driver connects to one called `test` — no error, no warning, and a
//  boot line that says "connected" exactly as it would have anyway.
//
//  That is not academic. The rotation runbook in this repo documented
//  `…mongodb.net/?appName=Cluster0`, which put live data into a
//  database called `test`; it also collided with SANDBOX_DB=test, so
//  routing switched itself off and the sandbox users were working in
//  production believing otherwise. The day the name was added back,
//  every id in every open tab stopped resolving.
//
//  This is the one distinction that had to be gettable right.
// ══════════════════════════════════════════════════════════════════
describe('does the URI name a database', () => {
  test.each([
    ['mongodb+srv://u:p@host/baluElastics?appName=X', true],
    ['mongodb+srv://u:p@host/baluElastics', true],
    ['mongodb://localhost:27017/elastic_erp', true],
    ['mongodb://a.net:27017,b.net:27017/erp?replicaSet=rs0', true],
  ])('%s → %s', (uri, expected) => {
    expect(databaseNamedIn(uri)).toBe(expected);
  });

  test.each([
    // The exact shape the runbook used to document.
    ['mongodb+srv://u:p@host/?appName=Cluster0', false],
    ['mongodb+srv://u:p@host/', false],
    ['mongodb+srv://u:p@host', false],
    ['mongodb://localhost:27017', false],
  ])('%s → %s (silently means "test")', (uri, expected) => {
    expect(databaseNamedIn(uri)).toBe(expected);
  });

  test('is not fooled by a database name that only appears in the query', () => {
    expect(databaseNamedIn('mongodb+srv://u:p@host/?appName=baluElastics')).toBe(false);
  });

  test('does not throw on nothing at all', () => {
    // This runs on the boot path; it must never be the reason a
    // process fails to start.
    expect(databaseNamedIn(undefined)).toBe(false);
    expect(databaseNamedIn('')).toBe(false);
  });
});
