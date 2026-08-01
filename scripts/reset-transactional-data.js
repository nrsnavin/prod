#!/usr/bin/env node
// scripts/reset-transactional-data.js
// ══════════════════════════════════════════════════════════════════
//  Empty the transactional data, keep the master data.
//
//  For starting a season, a fresh go-live, or clearing a test run
//  without re-entering every customer, product, material, supplier,
//  employee and machine.
//
//  KEPT   customers, elastics, raw materials, suppliers, employees,
//         machines — and, because losing them would break the system
//         rather than reset it, user logins and the settings
//         collections (see KEEP_OPERATIONAL). Each of those can be
//         dropped explicitly if you really mean to.
//
//  RESET  everything else: orders, jobs, warping, covering, plans,
//         batches, yarn lots, shifts, production, packing, challans,
//         purchase orders, inwards, stock movements, wastage, QC,
//         payroll, attendance, advances, bonuses, notifications, and
//         anything added since this was written.
//
//  Nothing is classified by a hand-written "drop" list. The script
//  reads the live database and resets whatever it is not told to keep,
//  so a collection added later is emptied by default rather than
//  quietly surviving a reset that was meant to be total.
//
//  ── Safety ───────────────────────────────────────────────────────
//  It prints a full plan and changes nothing unless you pass BOTH
//  --yes and --confirm-db=<the database's real name>. Naming the
//  database is the point: a reset run against the wrong URI is not
//  recoverable, and a flag you can add from muscle memory is not a
//  confirmation.
//
//  ── Usage ────────────────────────────────────────────────────────
//    node scripts/reset-transactional-data.js                 # plan only
//    node scripts/reset-transactional-data.js --yes --confirm-db=jarvis
//
//  Options
//    --keep-counters   leave document numbering where it is. By
//                      default counters are cleared, so the next order
//                      is #1 rather than continuing from the old run.
//    --keep-stock      leave elastic and raw-material balances alone.
//                      By default they are zeroed, because the inwards
//                      and movements that justify them are being
//                      deleted — a balance with no ledger behind it is
//                      a number nobody can explain.
//    --drop-users      also delete logins and settings. You will be
//                      locked out unless you seed a user afterwards.
//    --json            machine-readable plan/result.
// ══════════════════════════════════════════════════════════════════
'use strict';

try { require('dotenv').config({ path: require('path').join(__dirname, '..', 'config', '.env') }); } catch { /* optional */ }
try { require('dotenv').config(); } catch { /* optional */ }

const mongoose = require('mongoose');

// ── What survives ───────────────────────────────────────────────────
// Collection names as Mongo holds them (lower case, pluralised by
// mongoose), so the comparison does not depend on model naming.

/** The master data this reset exists to preserve. */
const KEEP_MASTER = new Set([
  'customers',
  'elastics',
  'rawmaterials',
  'suppliers',
  'employees',
  'machines',
]);

/**
 * Kept too, with reasons — deleting these does not reset the system,
 * it breaks it. Override with --drop-users if that is the intent.
 */
const KEEP_OPERATIONAL = new Map([
  ['users',                'login accounts — dropping these locks everyone out'],
  ['customerusers',        'customer portal logins, belonging to kept customers'],
  ['costings',             'per-elastic costing, referenced by the kept elastics'],
  ['elasticgroups',        'groupings of the kept elastics'],
  ['employeepayconfigs',   'pay setup for the kept employees'],
  ['payrollsettings',      'configuration, not data'],
  ['documentsettings',     'letterhead and branding'],
  ['notificationsettings', 'configuration, not data'],
  ['pdftemplates',         'document layouts you designed'],
  ['bonusconfigs',         'configuration, not data'],
]);

/** Cleared unless --keep-counters: numbering restarts from 1. */
const COUNTER_COLLECTIONS = new Set(['counters']);

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

const OPTS = {
  yes: has('--yes'),
  confirmDb: valueOf('--confirm-db'),
  keepCounters: has('--keep-counters'),
  keepStock: has('--keep-stock'),
  dropUsers: has('--drop-users'),
  json: has('--json'),
};

const out = (...a) => { if (!OPTS.json) console.log(...a); };

function keepReason(name) {
  if (KEEP_MASTER.has(name)) return 'master data';
  if (!OPTS.dropUsers && KEEP_OPERATIONAL.has(name)) return KEEP_OPERATIONAL.get(name);
  if (OPTS.keepCounters && COUNTER_COLLECTIONS.has(name)) return 'document numbering (--keep-counters)';
  return null;
}

async function main() {
  const uri =
    process.env.MONGO_URI || process.env.DB_URL || process.env.MONGO_URL;
  if (!uri) {
    console.error('No connection string. Set MONGO_URI, DB_URL or MONGO_URL.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const dbName = mongoose.connection.name;

  // Read the live database rather than the model files: a collection
  // that exists only in production still has to be accounted for.
  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const plan = [];
  for (const name of collections) {
    const count = await db.collection(name).countDocuments();
    const reason = keepReason(name);
    plan.push({ collection: name, count, action: reason ? 'keep' : 'reset', reason });
  }

  const toReset = plan.filter((p) => p.action === 'reset');
  const toKeep = plan.filter((p) => p.action === 'keep');
  const docsToDelete = toReset.reduce((s, p) => s + p.count, 0);

  const pad = (s, n) => String(s).padEnd(n);
  out('');
  out(`Database:  ${dbName}`);
  out(`Host:      ${mongoose.connection.host}`);
  out('');
  out('KEEP');
  for (const p of toKeep) {
    out(`  ${pad(p.collection, 26)} ${pad(p.count, 8)} ${p.reason}`);
  }
  out('');
  out('RESET');
  for (const p of toReset) {
    out(`  ${pad(p.collection, 26)} ${pad(p.count, 8)} ${p.count ? '' : '(already empty)'}`);
  }
  out('');
  out(`${docsToDelete.toLocaleString()} document(s) across ${toReset.length} collection(s) would be deleted.`);
  if (!OPTS.keepStock) {
    out('Elastic and raw-material balances will be zeroed (--keep-stock to leave them).');
  }
  if (!OPTS.keepCounters) {
    out('Document numbering will restart from 1 (--keep-counters to continue).');
  }
  out('Machines will be freed and unassigned from any order.');
  out('');

  // ── The gate ──────────────────────────────────────────────────────
  if (!OPTS.yes || OPTS.confirmDb !== dbName) {
    const why = !OPTS.yes
      ? 'Nothing was changed. Re-run with --yes and --confirm-db to execute:'
      : `Refused: --confirm-db="${OPTS.confirmDb}" does not match the database this URI points at ("${dbName}").`;
    out(why);
    out(`  node scripts/reset-transactional-data.js --yes --confirm-db=${dbName}`);
    out('');
    if (OPTS.json) {
      console.log(JSON.stringify({ dryRun: true, dbName, plan, docsToDelete }, null, 2));
    }
    await mongoose.disconnect();
    process.exit(OPTS.yes ? 1 : 0);
  }

  // ── Execute ───────────────────────────────────────────────────────
  const deleted = [];
  for (const p of toReset) {
    // deleteMany, not drop: dropping takes the indexes with it, and the
    // app would run without them until something recreated them.
    const res = await db.collection(p.collection).deleteMany({});
    deleted.push({ collection: p.collection, deleted: res.deletedCount });
    out(`  emptied ${pad(p.collection, 26)} ${res.deletedCount}`);
  }

  // ── Leave the kept masters consistent with an empty ledger ────────
  const fixes = [];

  // A machine still marked running, pointing at an order that no longer
  // exists, would be unusable and unexplainable.
  if (collections.includes('machines')) {
    const r = await db.collection('machines').updateMany(
      {},
      { $set: { status: 'free', orderRunning: null, elastics: [] } }
    );
    fixes.push(`machines freed: ${r.modifiedCount}`);
  }

  if (!OPTS.keepStock) {
    if (collections.includes('elastics')) {
      const r = await db.collection('elastics').updateMany(
        {},
        { $set: { stock: 0, quantityProduced: 0, reservedStock: 0 } }
      );
      fixes.push(`elastic balances zeroed: ${r.modifiedCount}`);
    }
    if (collections.includes('rawmaterials')) {
      const r = await db.collection('rawmaterials').updateMany(
        {},
        { $set: { stock: 0 } }
      );
      fixes.push(`raw material balances zeroed: ${r.modifiedCount}`);
    }
  }

  out('');
  for (const f of fixes) out(`  ${f}`);
  out('');
  out('Done.');

  if (OPTS.json) {
    console.log(JSON.stringify({ dryRun: false, dbName, deleted, fixes }, null, 2));
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Reset failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
