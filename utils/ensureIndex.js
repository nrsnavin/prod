'use strict';
// ══════════════════════════════════════════════════════════════════
//  ensureIndex — create an index on a database that has already run
//                the app
//
//  `createIndex` is only idempotent if the index it finds is identical.
//  Give it a key pattern that already exists under a DIFFERENT NAME and
//  MongoDB refuses outright:
//
//      MongoServerError: Index already exists with a different name:
//      employee_1_date_1_shift_1
//
//  Which is exactly what a migration meets in production and never meets
//  in a test. Mongoose's autoIndex has already built every index the
//  schemas declare, under ITS naming (`employee_1_date_1_shift_1`),
//  while the migrations name theirs for people to read
//  (`employee_date_shift_unique`). Same index, different label, chain
//  dead — before a single migration is recorded.
//
//  So:
//    • no index on that key            → create it
//    • one exists doing the same job   → keep it, whatever it is called
//    • one exists doing a DIFFERENT
//      job (not unique when we need
//      unique, wrong TTL, …)           → drop it and create ours
//
//  Keeping a differently-named equivalent rather than renaming it is
//  deliberate: a rename means dropping a live unique index and rebuilding
//  it, which on a large collection is both a window with no constraint
//  and a long stall. The name is for humans; the constraint is the point.
// ══════════════════════════════════════════════════════════════════

/** Key patterns are ORDER-SENSITIVE in a compound index. */
function sameKeys(a, b) {
  const ea = Object.entries(a || {});
  const eb = Object.entries(b || {});
  if (ea.length !== eb.length) return false;
  return ea.every(([k, v], i) => eb[i][0] === k && Number(eb[i][1]) === Number(v));
}

/** The options that change what an index DOES, normalised for comparison. */
function behaviour(spec = {}) {
  return JSON.stringify({
    unique: !!spec.unique,
    sparse: !!spec.sparse,
    expireAfterSeconds: spec.expireAfterSeconds ?? null,
    partialFilterExpression: spec.partialFilterExpression ?? null,
  });
}

/**
 * @param {import('mongodb').Db} db
 * @param {string} collName
 * @param {object} keys      e.g. { employee: 1, date: 1 }
 * @param {object} [options] passed to createIndex; `name` is expected
 * @returns {Promise<{action: 'created'|'kept'|'replaced', name: string}>}
 */
async function ensureIndex(db, collName, keys, options = {}) {
  const col = db.collection(collName);

  let existing = [];
  try {
    existing = await col.indexes();
  } catch (_) {
    // Collection does not exist yet — nothing can conflict.
    const name = await col.createIndex(keys, options);
    return { action: 'created', name };
  }

  const clash = existing.find((i) => i.name !== '_id_' && sameKeys(i.key, keys));
  if (!clash) {
    const name = await col.createIndex(keys, options);
    return { action: 'created', name };
  }

  if (behaviour(clash) === behaviour(options)) {
    if (clash.name !== options.name) {
      // eslint-disable-next-line no-console
      console.log(
        `[ensureIndex] ${collName}: keeping existing index "${clash.name}" ` +
        `— same keys and same behaviour as "${options.name}"`
      );
    }
    return { action: 'kept', name: clash.name };
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ensureIndex] ${collName}: replacing index "${clash.name}" with "${options.name}" ` +
    `— same keys but different behaviour`
  );
  await col.dropIndex(clash.name);
  const name = await col.createIndex(keys, options);
  return { action: 'replaced', name };
}

module.exports = { ensureIndex, sameKeys, behaviour };
