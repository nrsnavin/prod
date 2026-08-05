'use strict';
//
// Anti-vacuous-test guard for the gating suites.
//
// `expect(res.status).not.toBe(403)` is satisfied by a 404 — including
// Express's OWN 404 for a path that does not exist. A gate test hitting a
// mistyped path therefore "passes" while proving nothing; that exact
// failure hid a broken machine-write gate (see featureReadGate: the
// add-service-log test once hit /:id/add-service-log, which isn't a
// route).
//
// The discriminator is precise in this app: an unmatched route falls
// through to Express's default handler, which answers text/html
// ("Cannot GET /…") with an empty parsed body — while every real handler,
// including error responses via the app's ErrorHandler, answers JSON.

/** Fail the test if the response is Express's unmatched-route 404. */
function expectRouteHit(res) {
  const isRouterMiss =
    res.status === 404 &&
    /text\/html/.test(res.headers['content-type'] || '') &&
    /Cannot (GET|POST|PUT|PATCH|DELETE|HEAD)/.test(res.text || '');
  if (isRouterMiss) {
    throw new Error(
      `Vacuous test: the request never matched a route (Express default 404: ` +
      `${(res.text || '').replace(/<[^>]+>/g, ' ').trim().slice(0, 80)}). ` +
      `Fix the path — this assertion proves nothing about the gate.`
    );
  }
}

/** The gate let the request through AND the request hit a real route. */
function expectGatePassed(res) {
  expectRouteHit(res);
  if (res.status === 403) {
    throw new Error(
      `Expected the feature gate to PASS but got 403: ${JSON.stringify(res.body).slice(0, 120)}`
    );
  }
}

module.exports = { expectRouteHit, expectGatePassed };
