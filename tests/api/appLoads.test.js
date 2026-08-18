'use strict';
// ══════════════════════════════════════════════════════════════════
//  DOES THE SERVER START?
//
//  Every router in this system is required at the bottom of app.js, so
//  a single undefined identifier in any one of them takes the whole
//  application down at require time — not at the route, at BOOT. The
//  process never listens, every request 502s, and the log names a line
//  number in app.js rather than the file that actually broke.
//
//  Eighty-eight suites already require app.js, so the fault is caught
//  eventually. But "eventually" is a six-minute full run, and the
//  failure it produces is 1,500 red tests across ninety suites with the
//  real cause buried in the middle — which is a much harder thing to
//  read than one failing assertion that says the name of the missing
//  identifier.
//
//  This suite exists to fail FIRST and cheaply. It touches no database
//  and runs in about a second.
//
//  ── The specific mistake it was written for ──────────────────────
//  A guard was added to a new route in api/qc.js:
//
//      router.get('/root-cause', isAdmin('admin','production'), ...)
//
//  — in a router that does not import isAdmin, because its gating is at
//  the mount in app.js. The guard was redundant AND undefined. Targeted
//  test runs on the new service passed happily, because none of them
//  loaded app.js.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';
process.env.NODE_ENV = 'test';

describe('the application boots', () => {
  test('app.js requires cleanly, with every router it mounts', () => {
    // No mongo, no supertest, no listening. Requiring app.js executes
    // every `app.use(..., require('./api/x.js'))` line, which is where
    // a router with a broken reference throws.
    expect(() => require('../../app.js')).not.toThrow();
  });

  test('it is an express app with routes mounted on it', () => {
    // Guards against the require succeeding while exporting something
    // that could never serve a request.
    const app = require('../../app.js');
    expect(typeof app).toBe('function');
    expect(typeof app.use).toBe('function');
    expect(app._router?.stack?.length ?? 0).toBeGreaterThan(20);
  });
});
