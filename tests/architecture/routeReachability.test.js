'use strict';
// ══════════════════════════════════════════════════════════════════
//  EVERY ROUTE CAN BE REACHED
//
//  Express answers a request with the first route that matches it, in
//  the order the routes were added. A route added below one that
//  already matches its path never runs: GET /stale sat below
//  GET /:jobId and answered nothing for months
//  (tests/api/jobScanLookup.test.js).
//
//  The largest routers are now several files mounted in order —
//  api/order.js, job.js, rawMaterial.js and accounts.js each mount a
//  run of sibling files — which makes that order easier to lose sight
//  of. So for every router in api/, and every route on it whose path is
//  a plain one, a request for exactly that path must reach that route
//  and not one above it.
// ══════════════════════════════════════════════════════════════════

process.env.JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || 'test-secret';

const fs = require('fs');
const path = require('path');
const express = require('express');

const api = path.join(__dirname, '..', '..', 'api');
const files = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return d.name.endsWith('.js') ? [p] : [];
  });
})(api);

// The routes in the order Express tries them, through the routers
// mounted at the root (a router mounted at a path is its own file).
function routesOf(router, out = []) {
  for (const layer of router.stack) {
    if (layer.route) out.push(layer);
    else if (layer.handle && Array.isArray(layer.handle.stack) && layer.regexp.fast_slash) routesOf(layer.handle, out);
  }
  return out;
}

// Each plain-path route that a route above it answers instead.
function hiddenRoutes(router) {
  const routes = routesOf(router);
  const hidden = [];
  let checked = 0;
  for (const r of routes) {
    const p = r.route.path;
    if (typeof p !== 'string' || /[:*?(]/.test(p)) continue;
    for (const m of Object.keys(r.route.methods)) {
      const method = m === '_all' ? 'get' : m;
      checked += 1;
      const first = routes.find((x) => x.route._handles_method(method) && x.match(p));
      if (first !== r) hidden.push(`${method.toUpperCase()} ${p} is answered by ${first.route.path}`);
    }
  }
  return { hidden, checked };
}

const routers = files
  .map((f) => ({ file: path.relative(api, f), router: require(f) }))
  .filter(({ router }) => typeof router === 'function' && Array.isArray(router.stack));

it('finds the routers', () => {
  expect(routers.length).toBeGreaterThan(50);
});

it('answers every plain path with its own route', () => {
  const hidden = [];
  let checked = 0;
  for (const { file, router } of routers) {
    const r = hiddenRoutes(router);
    checked += r.checked;
    hidden.push(...r.hidden.map((h) => `${file}: ${h}`));
  }
  expect(checked).toBeGreaterThan(500); // the scan is really finding them
  expect(hidden).toEqual([]);
});

it('would catch one, across mounted files too', () => {
  const ok = (req, res) => res.end();
  const first = express.Router();
  first.get('/:jobId', ok);
  const second = express.Router();
  second.get('/stale', ok);
  second.post('/stale', ok);
  const main = express.Router();
  main.use(first);
  main.use(second);
  expect(hiddenRoutes(main).hidden).toEqual(['GET /stale is answered by /:jobId']);
});
