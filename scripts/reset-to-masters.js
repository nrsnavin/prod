'use strict';
// ══════════════════════════════════════════════════════════════════
//  RESET TO MASTERS — erase everything except the five master lists.
//
//  KEEPS   raw materials · elastics · suppliers · customers ·
//          elastic groups
//  ERASES  everything else, including the stock-movement ledger,
//          purchase orders, employees, and material inward / outward.
//
//  Usage (from the repo root on the server):
//
//    node scripts/reset-to-masters.js                     # DRY RUN
//    node scripts/reset-to-masters.js --yes --db jarvis   # execute
//
//    node scripts/reset-to-masters.js --keep machines     # spare a collection
//    node scripts/reset-to-masters.js --wipe costings     # erase one that is kept
//    node scripts/reset-to-masters.js --yes --db jarvis --reset-stock
//                                                         # also zero the stock BALANCES
//
//    node scripts/reset-to-masters.js --yes --db test --copy-to baluElastics
//                                                         # …then copy what survived
//                                                         # into a second database
//
//  --copy-to runs AFTER the erase, so what lands in the target is the
//  master data and nothing else — a clean database to start production
//  on, while the source stays available as a sandbox. It refuses to
//  write into a target that already holds documents unless
//  --overwrite-target is given, because a half-merged database is worse
//  than either of the two it came from.
//
//  ⚠️  THERE IS NO UNDO, so --yes will not run without a backup. Either:
//
//    --backup-to <db>       clone this database first, using the driver.
//                           Needs nothing installed, and restores with
//                             node scripts/copy-db.js --from <db> --to <this> --overwrite
//                           Same cluster, so it is an undo button rather
//                           than an offsite backup.
//
//    --i-have-a-backup      you took a mongodump, and you checked it
//                           reads back:
//                             mongodump --uri "$MONGO_URL" --out ~/backup-$(date +%F)
//                           (mongodump ships separately from the server —
//                            sudo apt-get install -y mongodb-database-tools)
//
//  WHY A KEEP-LIST, NOT A WIPE-LIST
//  The existing reset-for-production.js names the collections to clear.
//  That is the wrong way round for "erase everything except…": a
//  collection added after the script was written is silently SPARED, and
//  nobody finds out until stale rows turn up in a fresh production
//  ledger. (It has already happened — that list predates sample
//  requests, yarn lots, warping batches and machine service bills, and
//  would have left all four behind.) This script reads the collections
//  that actually EXIST in the database and erases everything it was not
//  explicitly told to keep, so it cannot go out of date.
//
//  WHAT IS KEPT BEYOND THE FIVE
//    • logins (users, customer portal users) — erasing them locks you out
//      of the system you are resetting, with no way back in short of
//      scripts/create-admin.js on the server
//    • the migration changelog — erase it and `migrate-mongo up` replays
//      the whole chain against a live database on next boot
//    • settings and branding: document settings, PDF templates,
//      notification / payroll / bonus / cost settings
//    • costings — the cost sheets belong to the elastics they price
//  Any of these can be erased anyway with --wipe <collection>.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');
const { copyDatabase, countDocuments } = require('../db/copyDatabase');

// ── The five the request named ───────────────────────────────────
const MASTERS = [
  'rawmaterials',
  'elastics',
  'suppliers',
  'customers',
  'elasticgroups',
];

/** Cost sheets are part of the elastic they price, not transactions. */
const ATTACHED = ['costings'];

/** Infrastructure. Erasing any of these breaks the system itself. */
const SYSTEM = [
  'users',
  'customerusers',
  'changelog',            // migrate-mongo — see the header
  'documentsettings',
  'pdftemplates',
  'notificationsettings',
  'payrollsettings',
  'bonusconfigs',
  'costsettings',
  'system.views',
  'system.profile',
];

/** Named in the request, so they are checked for explicitly below. */
const MUST_ERASE = [
  'stockmovements',
  'purchaseorders',
  'employees',
  'materialinwards',
  'materialoutwards',
];

// ── Arguments ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const EXECUTE = argv.includes('--yes');
const RESET_STOCK = argv.includes('--reset-stock');
const ALLOW_LOCKOUT = argv.includes('--allow-lockout');

const valuesOf = (flag) => argv
  .map((a, i) => (a === flag ? argv[i + 1] : null))
  .filter((v) => v && !v.startsWith('--'))
  .map((v) => v.toLowerCase());

const EXTRA_KEEP = valuesOf('--keep');
const EXTRA_WIPE = valuesOf('--wipe');
const DB_ARG = valuesOf('--db')[0] ?? null;
// Not lowercased: a database name is case-sensitive, and "baluElastics"
// is not "baluelastics".
const COPY_TO = (argv.map((a, i) => (a === '--copy-to' ? argv[i + 1] : null))
  .find((v) => v && !v.startsWith('--'))) ?? null;
const BACKUP_TO = (argv.map((a, i) => (a === '--backup-to' ? argv[i + 1] : null))
  .find((v) => v && !v.startsWith('--'))) ?? null;
const HAVE_BACKUP = argv.includes('--i-have-a-backup');
const OVERWRITE_TARGET = argv.includes('--overwrite-target');

const bail = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };

async function main() {
  if (!process.env.MONGO_URL) {
    bail('MONGO_URL is not set (config/.env). Aborting.');
  }

  // A maintenance script has no business building indexes or creating
  // collections; both would fire on connect if models were loaded eagerly.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGO_URL, {});
  const db = mongoose.connection.db;
  const dbName = mongoose.connection.name;

  console.log(`\nConnected to database: ${dbName}`);
  console.log(EXECUTE
    ? '⚠️  EXECUTE MODE — data WILL be erased.\n'
    : '🔍 DRY RUN — nothing will be changed. Add --yes --db ' + dbName + ' to execute.\n');

  // Naming the database out loud is the guard against pointing a total
  // wipe at the wrong one — easy to do when the connection string lives
  // in an env file you cannot see from the command line.
  if (EXECUTE && DB_ARG !== dbName) {
    bail(
      `Refusing to erase "${dbName}" — confirm it by name:\n` +
      `    node scripts/reset-to-masters.js --yes --db ${dbName}`
    );
  }

  const keep = new Set([...MASTERS, ...ATTACHED, ...SYSTEM, ...EXTRA_KEEP]);
  for (const name of EXTRA_WIPE) keep.delete(name);

  // The backup is not advice, it is a precondition: this erases most of
  // a production database and there is nothing to fall back on.
  if (EXECUTE && !BACKUP_TO && !HAVE_BACKUP) {
    bail(
      'Refusing to erase without a backup. Either:\n\n' +
      `    --backup-to ${dbName}_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, '_')}\n` +
      '        clones this database first, using the driver — nothing to install.\n\n' +
      '    --i-have-a-backup\n' +
      '        you took a mongodump AND checked that it reads back.'
    );
  }
  if (BACKUP_TO && BACKUP_TO === dbName) {
    bail(`--backup-to ${BACKUP_TO} is the database you are about to erase.`);
  }

  if (!keep.has('users') && !ALLOW_LOCKOUT) {
    bail(
      'Refusing to erase "users" — that is every login to this system, and\n' +
      'the only way back in is scripts/create-admin.js on the server.\n' +
      'Add --allow-lockout if you really mean it.'
    );
  }

  const present = (await db.listCollections().toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith('system.'))
    .sort();

  const kept = present.filter((n) => keep.has(n));
  const wipe = present.filter((n) => !keep.has(n));

  const counts = {};
  for (const name of present) counts[name] = await db.collection(name).countDocuments();

  const line = (n) => `  ${n.padEnd(24)} ${String(counts[n]).padStart(8)} docs`;

  console.log('KEEPING');
  for (const n of kept) console.log(line(n));
  if (kept.length === 0) console.log('  (nothing)');

  console.log('\nERASING');
  for (const n of wipe) console.log(line(n));
  const totalWiped = wipe.reduce((s, n) => s + counts[n], 0);
  console.log(`  ${'TOTAL'.padEnd(24)} ${String(totalWiped).padStart(8)} docs`);

  // The four things asked for by name: say plainly whether each is going,
  // rather than leaving it to be read out of a long list.
  console.log('\nNAMED IN THE REQUEST');
  for (const n of MUST_ERASE) {
    if (!present.includes(n)) console.log(`  ${n.padEnd(24)} not in this database`);
    else if (keep.has(n)) console.log(`  ${n.padEnd(24)} ⚠️  KEPT (you passed --keep ${n})`);
    else console.log(`  ${n.padEnd(24)} will be erased (${counts[n]} docs)`);
  }

  // Anything present that is neither a master nor infrastructure and was
  // not named — machines above all. Worth its own heading, because
  // rebuilding a machine list by hand is a day nobody planned for.
  const collateral = wipe.filter((n) => !MUST_ERASE.includes(n) && counts[n] > 0);
  if (collateral.length) {
    console.log('\nALSO ERASED — not named in the request, spare any with --keep <name>');
    console.log(`  ${collateral.join(', ')}`);
  }

  console.log('\nON THE MASTERS THAT STAY');
  console.log('  elastics       quantityProduced, reservedStock → 0, stockMovements[] cleared');
  console.log('  rawmaterials   stockMovements[] cleared');
  console.log(RESET_STOCK
    ? '  --reset-stock  elastics.stock and rawmaterials.stock → 0'
    : '  balances KEPT as they are (add --reset-stock to zero them).\n'
      + '                 Note: with the ledger erased there is nothing behind those\n'
      + '                 numbers — the stock report will show a balance with no history.');

  if (COPY_TO) {
    if (COPY_TO === dbName) bail(`--copy-to ${COPY_TO} is the database you are connected to.`);
    const target = mongoose.connection.useDb(COPY_TO, { useCache: true });
    const targetCollections = await target.db.listCollections().toArray();
    let targetDocs = 0;
    for (const c of targetCollections) {
      targetDocs += await target.db.collection(c.name).countDocuments();
    }
    console.log(`\nCOPY TO "${COPY_TO}" (after the erase — masters only)`);
    console.log(`  target currently holds ${targetDocs} doc(s) in ${targetCollections.length} collection(s)`);
    if (targetDocs > 0 && !OVERWRITE_TARGET) {
      bail(
        `Refusing to copy into "${COPY_TO}" — it already holds ${targetDocs} document(s).\n` +
        'Merging into a populated database gives you something that is neither one\n' +
        'nor the other. Add --overwrite-target to empty it first, or pick another name.'
      );
    }
    if (targetDocs > 0) console.log('  --overwrite-target: it will be EMPTIED first');
  }

  if (BACKUP_TO) {
    const backup = mongoose.connection.useDb(BACKUP_TO, { useCache: true }).db;
    const existing = await countDocuments(backup);
    console.log(`\nBACKUP TO "${BACKUP_TO}" (before anything is erased)`);
    console.log(`  target currently holds ${existing} doc(s)`);
    if (existing > 0) {
      bail(
        `Refusing to back up into "${BACKUP_TO}" — it already holds ${existing} document(s).\n` +
        'Writing a backup on top of something else gives you neither. Pick another name.'
      );
    }
  }

  if (!EXECUTE) {
    console.log('\nDry run complete. Nothing was changed.\n');
    await mongoose.disconnect();
    return;
  }

  // Before anything is destroyed, and separately from --copy-to, which
  // runs afterwards and carries only the masters.
  if (BACKUP_TO) {
    console.log(`\nBacking up "${dbName}" → "${BACKUP_TO}"…`);
    const backup = mongoose.connection.useDb(BACKUP_TO, { useCache: true }).db;
    const result = await copyDatabase(db, backup, { log: (l) => console.log(l) });
    if (result.documents === 0) {
      bail('The backup copied 0 documents. Refusing to erase anything.');
    }
    console.log(`  ${result.documents} document(s) in ${result.collections} collection(s) backed up.`);
    console.log(`  Restore with:  node scripts/copy-db.js --from ${BACKUP_TO} --to ${dbName} --overwrite`);
  }

  console.log('\nErasing…');
  for (const n of wipe) {
    const r = await db.collection(n).deleteMany({});
    console.log(`  ${n.padEnd(24)} ${r.deletedCount} removed`);
  }

  console.log('\nResetting derived fields on the masters that stay…');
  // Both are erased unconditionally: they are the embedded half of the
  // stock ledger the request asked to remove, and a reservation held
  // against an order that no longer exists blocks dispatch forever.
  const elasticSet = { quantityProduced: 0, reservedStock: 0, stockMovements: [] };
  if (RESET_STOCK) elasticSet.stock = 0;
  const e = await db.collection('elastics').updateMany({}, { $set: elasticSet });

  const materialSet = { stockMovements: [] };
  if (RESET_STOCK) materialSet.stock = 0;
  const m = await db.collection('rawmaterials').updateMany({}, { $set: materialSet });

  console.log(`  elastics ${e.modifiedCount} updated · rawmaterials ${m.modifiedCount} updated`);

  if (COPY_TO) {
    const target = mongoose.connection.useDb(COPY_TO, { useCache: true });
    console.log(`\nCopying what survived into "${COPY_TO}"…`);

    if (OVERWRITE_TARGET) {
      for (const c of await target.db.listCollections().toArray()) {
        if (c.name.startsWith('system.')) continue;
        await target.db.collection(c.name).deleteMany({});
      }
    }

    // Read in batches rather than .toArray() on the whole collection: a
    // master list can be large, and a script that dies of heap exhaustion
    // half way through a copy leaves a partial database behind.
    const BATCH = 500;
    for (const name of kept) {
      const cursor = db.collection(name).find({});
      let batch = [];
      let copied = 0;
      for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length >= BATCH) {
          await target.db.collection(name).insertMany(batch, { ordered: false });
          copied += batch.length;
          batch = [];
        }
      }
      if (batch.length) {
        await target.db.collection(name).insertMany(batch, { ordered: false });
        copied += batch.length;
      }
      console.log(`  ${name.padEnd(24)} ${copied} copied`);
    }
    console.log(
      `\n  "${COPY_TO}" now holds the master data only. Indexes are NOT copied —\n` +
      '  they are rebuilt from the schemas on first boot, and migrate-mongo up\n' +
      '  installs the rest. Run it against the new database before serving traffic.'
    );
  }

  console.log('\n✅ Done. Document numbering restarts at 1.');
  console.log('Restart the API so nothing stale is held in memory:');
  console.log('    sudo systemctl restart jarvis    # or: pm2 restart all\n');
  await mongoose.disconnect();
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
