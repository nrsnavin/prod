'use strict';
//
// Empty strings where a reference belongs.
//
// An HTML form has no way to say "no value" — an unpicked <select>
// submits "". For a text field that is harmless; for a field the schema
// declares as an ObjectId it is a cast error, and Mongoose rejects the
// WHOLE document. A warping plan was refused outright because the one
// field that is meant to be optional, the dye lot, had not been chosen:
//
//   WarpingPlan validation failed: beams.0.sections.0.yarnLot:
//   Cast to ObjectId failed for value "" (type string)
//
// Every optional reference reachable from a form is the same fault
// waiting, so it is fixed once here rather than per route.
//
// ── Why the field names are derived, not listed ──────────────────────
// A hand-written list goes stale the moment a model gains a reference,
// and the failure is silent — the new field simply keeps crashing. So
// the names come from the registered schemas themselves.
//
// ── Why some names are deliberately skipped ──────────────────────────
// Matching by field NAME is a heuristic: the middleware cannot know
// which model a route is about to write. That is safe only for a name
// that means the same thing everywhere. A handful do not — `status` is
// a String on 27 models but an ObjectId on Elastic (models/Elastic.js,
// a reference confusingly named `status`), and `customer` is a String
// on ProductionPlan. Blanking those would corrupt ordinary text fields,
// which is far worse than the crash being fixed. Ambiguous names are
// left alone and reported by `ambiguousRefNames()` so the exclusion is
// visible rather than folklore.

const mongoose = require('mongoose');

// Bodies are user input; a pathological one should not exhaust the
// stack before it reaches a route.
const MAX_DEPTH = 12;

let cache = null;

function scan() {
  const objectIds = new Map();
  const strings = new Map();

  const walk = (schema, modelName) => {
    schema.eachPath((path, type) => {
      const leaf = path.split('.').pop();
      // An array of refs reports its type on the caster.
      const instance = type.instance || (type.caster && type.caster.instance);
      const bucket = instance === 'ObjectId' ? objectIds : instance === 'String' ? strings : null;
      if (bucket) {
        if (!bucket.has(leaf)) bucket.set(leaf, new Set());
        bucket.get(leaf).add(modelName);
      }
      // Sub-documents carry their own paths.
      if (type.schema) walk(type.schema, modelName);
    });
  };

  for (const [name, model] of Object.entries(mongoose.models)) walk(model.schema, name);

  const ambiguous = [...objectIds.keys()].filter((n) => strings.has(n)).sort();
  const safe = new Set([...objectIds.keys()].filter((n) => !strings.has(n)));
  // `_id` is ambiguous (String on the counter models) and a caller has
  // no business sending a blank one anyway.
  safe.delete('_id');
  return { safe, ambiguous };
}

/**
 * Field names that mean "a reference" in every model that declares them.
 * Computed on first use, because models register as the routers load.
 */
function refFieldNames() {
  if (!cache) cache = scan();
  return cache.safe;
}

/** Names skipped because they are a reference in one model and text in another. */
function ambiguousRefNames() {
  if (!cache) cache = scan();
  return cache.ambiguous;
}

/** Testing seam — forget the scan so a suite can register more models. */
function _resetCache() { cache = null; }

/**
 * Replace "" with null on reference fields, in place, at any depth.
 *
 * Only the empty string is touched: a whitespace string is a value
 * someone typed, and turning it into null would be guessing.
 */
function blankRefsToNull(value, names = refFieldNames(), depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    for (const item of value) blankRefsToNull(item, names, depth + 1);
    return value;
  }

  for (const key of Object.keys(value)) {
    // Never walk into a prototype-polluting key.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const child = value[key];
    if (child === '' && names.has(key)) value[key] = null;
    else if (child && typeof child === 'object') blankRefsToNull(child, names, depth + 1);
  }
  return value;
}

/**
 * Express middleware. Mount after the body parsers, before the routers.
 * Body only: a query string is a different shape of problem, and a route
 * reading `?id=` already guards for a missing one.
 */
function normaliseBlankRefs(req, _res, next) {
  if (req.body && typeof req.body === 'object') blankRefsToNull(req.body);
  next();
}

module.exports = {
  normaliseBlankRefs,
  blankRefsToNull,
  refFieldNames,
  ambiguousRefNames,
  _resetCache,
};
