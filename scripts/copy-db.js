'use strict';
// ══════════════════════════════════════════════════════════════════
//  COPY A DATABASE — backup and restore without mongodump
//
//  mongodump ships separately from the MongoDB server (it is in the
//  "MongoDB Database Tools" package), so it is routinely missing on the
//  box where you need it. This does the same job with the driver the
//  app already has.
//
//  Back up before a destructive change:
//    node scripts/copy-db.js --from test --to test_backup_2026_08_07
//
//  Put it back:
//    node scripts/copy-db.js --from test_backup_2026_08_07 --to test --overwrite
//
//  List what is on the cluster:
//    node scripts/copy-db.js --list
//
//  ⚠️  Same cluster, so this does not survive losing the cluster itself.
//  It is an undo button, not an offsite backup. When you can, also:
//     sudo apt-get install -y mongodb-database-tools
//     mongodump --uri "$MONGO_URL" --out ~/backup-$(date +%F)
//
//  Indexes are not copied; mongoose rebuilds them from the schemas on
//  boot, and `migrate-mongo up` installs the rest. Run it against a
//  restored database before serving traffic.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');
const { copyDatabase, countDocuments } = require('../db/copyDatabase');

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null);
};

const FROM = valueOf('--from');
const TO = valueOf('--to');
const OVERWRITE = argv.includes('--overwrite');
const LIST = argv.includes('--list');

const bail = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };

async function main() {
  if (!process.env.MONGO_URL) bail('MONGO_URL is not set (config/.env). Aborting.');

  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGO_URL, {});
  const admin = mongoose.connection.getClient().db().admin();

  if (LIST) {
    const { databases } = await admin.listDatabases();
    console.log('\nDatabases on this cluster:');
    for (const d of databases) {
      console.log(`  ${d.name.padEnd(28)} ${(d.sizeOnDisk / 1e6).toFixed(1)} MB`);
    }
    console.log('');
    await mongoose.disconnect();
    return;
  }

  if (!FROM || !TO) {
    bail('Usage: node scripts/copy-db.js --from <db> --to <db> [--overwrite]\n' +
         '       node scripts/copy-db.js --list');
  }
  if (FROM === TO) bail(`--from and --to are the same database ("${FROM}").`);

  const source = mongoose.connection.useDb(FROM, { useCache: true }).db;
  const target = mongoose.connection.useDb(TO, { useCache: true }).db;

  const sourceDocs = await countDocuments(source);
  const targetDocs = await countDocuments(target);

  console.log(`\nFrom  ${FROM}  (${sourceDocs} documents)`);
  console.log(`To    ${TO}  (${targetDocs} documents)\n`);

  if (sourceDocs === 0) {
    bail(`"${FROM}" is empty. Check the name — copying nothing over something is not a backup.`);
  }
  if (targetDocs > 0 && !OVERWRITE) {
    bail(`Refusing: "${TO}" already holds ${targetDocs} document(s).\n` +
         'Merging gives you a database that is neither one nor the other.\n' +
         'Add --overwrite to empty it first, or pick another name.');
  }
  if (targetDocs > 0) console.log(`--overwrite: "${TO}" will be EMPTIED first.\n`);

  console.log('Copying…');
  const result = await copyDatabase(source, target, {
    overwrite: OVERWRITE,
    log: (line) => console.log(line),
  });

  console.log(`\n✅ ${result.documents} document(s) in ${result.collections} collection(s) copied to "${TO}".`);
  console.log('Indexes were not copied — they are rebuilt on boot, and migrate-mongo up');
  console.log('installs the rest. Run it before serving traffic from a restored database.\n');
  await mongoose.disconnect();
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
