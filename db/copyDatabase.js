'use strict';
// ══════════════════════════════════════════════════════════════════
//  COPY ONE DATABASE INTO ANOTHER
//  File: db/copyDatabase.js
//
//  A driver-only clone, so a backup does not depend on mongodump being
//  installed — it ships separately from the server (MongoDB Database
//  Tools), and discovering that at the moment you are about to erase a
//  production database is not the time.
//
//  WHAT THIS IS NOT
//  It copies onto the SAME CLUSTER, so it does not survive losing the
//  cluster, an expired Atlas trial, or a dropped project. It is an undo
//  button for the thing about to be run, not an offsite backup. Take a
//  real mongodump as well when you can.
//
//  Documents keep their _id, so every reference between collections
//  still resolves after a restore. Indexes are NOT copied — mongoose
//  rebuilds them from the schemas on boot and migrate-mongo installs the
//  rest — so a restored database needs `migrate-mongo up` before it
//  serves traffic.
// ══════════════════════════════════════════════════════════════════

/** Read and write in batches: a whole collection in memory is how a copy
 *  dies of heap exhaustion half way through and leaves a partial database. */
const BATCH = 500;

const isSystem = (name) => name.startsWith('system.');

/**
 * @param {import('mongodb').Db} source
 * @param {import('mongodb').Db} target
 * @param {object}   [opts]
 * @param {string[]} [opts.only]      copy just these collections
 * @param {boolean}  [opts.overwrite] empty the target first
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{collections: number, documents: number}>}
 */
async function copyDatabase(source, target, { only = null, overwrite = false, log = () => {} } = {}) {
  const names = (await source.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !isSystem(n))
    .filter((n) => !only || only.includes(n))
    .sort();

  if (overwrite) {
    for (const c of await target.listCollections().toArray()) {
      if (!isSystem(c.name)) await target.collection(c.name).deleteMany({});
    }
  }

  let documents = 0;
  for (const name of names) {
    const cursor = source.collection(name).find({});
    let batch = [];
    let copied = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      // ordered:false so one rejected document does not abandon the rest
      // of the batch — a partial copy that reports success is the worst
      // outcome available here.
      await target.collection(name).insertMany(batch, { ordered: false });
      copied += batch.length;
      batch = [];
    };

    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    documents += copied;
    log(`  ${name.padEnd(24)} ${String(copied).padStart(8)} copied`);
  }

  return { collections: names.length, documents };
}

/** Total documents in a database — used to refuse a populated target. */
async function countDocuments(db) {
  let total = 0;
  for (const c of await db.listCollections().toArray()) {
    if (!isSystem(c.name)) total += await db.collection(c.name).countDocuments();
  }
  return total;
}

/** Per-collection document counts, as a Map. */
async function countByCollection(db) {
  const counts = new Map();
  for (const c of await db.listCollections().toArray()) {
    if (isSystem(c.name)) continue;
    counts.set(c.name, await db.collection(c.name).countDocuments());
  }
  return counts;
}

/**
 * Compare two databases collection by collection.
 *
 * Size on disk is not evidence: a copy carries no indexes (they are
 * rebuilt from the schemas), so a complete backup is routinely half the
 * size of its source and looks alarming. Counting documents is the only
 * check worth trusting before something irreversible.
 *
 * @returns {Promise<{ok: boolean, rows: Array<{name, source, target, ok}>}>}
 */
async function compareDatabases(source, target) {
  const [a, b] = await Promise.all([countByCollection(source), countByCollection(target)]);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort();
  const rows = names.map((name) => {
    const s = a.get(name) ?? 0;
    const t = b.get(name) ?? 0;
    return { name, source: s, target: t, ok: s === t };
  });
  return { ok: rows.every((r) => r.ok), rows };
}

module.exports = { copyDatabase, countDocuments, countByCollection, compareDatabases, BATCH };
