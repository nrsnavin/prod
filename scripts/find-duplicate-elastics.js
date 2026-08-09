'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHICH ELASTICS ARE THE SAME PRODUCT ENTERED TWICE
//
//  Usage (from the repo root on the server):
//
//    node scripts/find-duplicate-elastics.js
//    node scripts/find-duplicate-elastics.js --db baluElastics
//
//  Read-only. It changes nothing and asks for nothing.
//
//  It exists because the unique-name index cannot be built while
//  duplicates are in the catalogue, and choosing which of two rows is
//  the real product is not a decision code should make. Which one is
//  right depends on what each is carrying — the one with the orders
//  and the stock is usually the keeper, but not always, and the wrong
//  choice silently moves history onto the wrong product.
//
//  So this prints what the decision needs: for each duplicated name,
//  every row that answers to it, with the stock on hand, how many
//  orders and jobs reference it, whether it is archived, and when it
//  was created. Then a person decides.
//
//  Matching is on the same folded key the API refuses duplicates by
//  (utils/elasticName.js), so this finds the pairs that differ only in
//  capitalisation or spacing too — which is most of them.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');

const { elasticNameKey } = require('../utils/elasticName.js');

const argv = process.argv.slice(2);
const flagValue = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const dbName = flagValue('--db');

/** Right-pad, but never truncate a name — the name is the point. */
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  if (!process.env.MONGO_URL) {
    console.error('MONGO_URL is not set — check config/.env');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URL, dbName ? { dbName } : {});
  const db = mongoose.connection.db;
  console.log(`Reading "${db.databaseName}".\n`);

  const elastics = db.collection('elastics');

  // Grouped in memory on the folded key rather than with $group on
  // nameKey, so this still works on a database where the backfill
  // migration has not run yet — which is exactly when it is needed.
  const rows = await elastics
    .find({}, { projection: { name: 1, stock: 1, archived: 1, createdAt: 1 } })
    .toArray();

  const groups = new Map();
  for (const r of rows) {
    const key = elasticNameKey(r.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const dupes = [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (dupes.length === 0) {
    console.log('No duplicate elastic names. The unique index can be built —');
    console.log('run "npx migrate-mongo up" to add it.');
    await mongoose.disconnect();
    return;
  }

  console.log(`${dupes.length} duplicated name(s).\n`);

  const orders = db.collection('orders');
  const jobs = db.collection('joborders');

  for (const [key, list] of dupes) {
    console.log(`── "${list[0].name}" ── ${list.length} rows (key: ${key})`);
    console.log(
      '   ' + pad('id', 26) + pad('name as typed', 34) +
      pad('stock', 10) + pad('orders', 8) + pad('jobs', 7) +
      pad('archived', 10) + 'created'
    );

    for (const r of list) {
      // Counted, not listed: the count is what decides which row is the
      // real one, and a list of order numbers would bury it.
      const [orderCount, jobCount] = await Promise.all([
        orders.countDocuments({ 'elasticOrdered.elastic': r._id }),
        jobs.countDocuments({ 'elastics.elastic': r._id }),
      ]);
      console.log(
        '   ' + pad(String(r._id), 26) + pad(r.name, 34) +
        pad(Number(r.stock) || 0, 10) + pad(orderCount, 8) + pad(jobCount, 7) +
        pad(r.archived ? 'yes' : 'no', 10) +
        (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '—')
      );
    }
    console.log('');
  }

  console.log('Nothing was changed. To resolve each one, in the app:');
  console.log('  • keep the row carrying the orders, jobs and stock;');
  console.log('  • rename the other so it reads as what it is, or archive it;');
  console.log('  • an archived row still holds its name — rename it too, or');
  console.log('    the index will still refuse to build.');
  console.log('\nThen re-run "npx migrate-mongo up" to add the unique index.');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
