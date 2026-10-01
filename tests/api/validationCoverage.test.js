'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH WRITE ROUTES HAVE A SCHEMA
//
//  Every POST, PUT and PATCH in the files listed here must run
//  validate(...) (middleware/validate.js) before its handler. The list
//  only grows: when a router is brought under schemas, add it here, and
//  a new route added to it later without one fails this test.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';

const GUARDED = ['user', 'me', 'employee'];

function writeRoutes(router) {
  return router.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods)
      .filter((m) => ['post', 'put', 'patch'].includes(m))
      .map((m) => ({ method: m.toUpperCase(), path: l.route.path, layers: l.route.stack })));
}

describe.each(GUARDED)('api/%s.js', (file) => {
  const router = require(`../../api/${file}.js`);

  it('has write routes to check', () => {
    expect(writeRoutes(router).length).toBeGreaterThan(0);
  });

  it('runs a schema on every write route', () => {
    const missing = writeRoutes(router)
      .filter((r) => !r.layers.some((l) => l.handle && l.handle.isRequestValidator))
      .map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });
});
