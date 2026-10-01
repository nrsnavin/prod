'use strict';
// ══════════════════════════════════════════════════════════════════
//  SEAL EXISTING AADHAAR NUMBERS
//
//  Once AADHAAR_KEY is set (config/.env), every Aadhaar number saved
//  from then on is encrypted. Numbers saved before stay readable but
//  plain until someone edits them. This seals them all now:
//
//    node scripts/encrypt-aadhaar.js            # report only
//    node scripts/encrypt-aadhaar.js --apply    # seal them
//
//  Safe to run again: sealed numbers are skipped. It also clears the
//  literal "Not Provided" an old edit form used to save as a number.
//  Each sealed value is opened again and compared before it is written,
//  so a wrong key fails loudly here instead of losing a number.
// ══════════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');
const aadhaar = require('../utils/aadhaar');

async function sealAll({ apply }) {
  if (!process.env.AADHAAR_KEY) throw new Error('Set AADHAAR_KEY in config/.env first (openssl rand -base64 32)');
  const Employee = require('../models/Employee');
  const docs = await Employee.find({ aadhar: { $exists: true, $nin: [null, ''] } }).select('name +aadhar').lean();
  let sealed = 0, cleared = 0, already = 0;
  for (const d of docs) {
    if (aadhaar.isSealed(d.aadhar)) { already++; continue; }
    if (d.aadhar.trim() === 'Not Provided') {
      cleared++;
      if (apply) await Employee.updateOne({ _id: d._id }, { $unset: { aadhar: 1 } });
      continue;
    }
    const value = aadhaar.seal(d.aadhar);
    if (aadhaar.open(value) !== d.aadhar.trim()) throw new Error(`Round trip failed for ${d.name}; nothing written for them`);
    sealed++;
    if (apply) await Employee.updateOne({ _id: d._id }, { $set: { aadhar: value } });
  }
  return { total: docs.length, sealed, cleared, already };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  (async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const r = await sealAll({ apply });
    console.log(`${apply ? 'Sealed' : 'Would seal'} ${r.sealed}, ${apply ? 'cleared' : 'would clear'} ${r.cleared} "Not Provided", ${r.already} already sealed, of ${r.total}.`);
    if (!apply) console.log('Run again with --apply to write.');
    await mongoose.disconnect();
  })().catch(async (err) => {
    console.error(err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { sealAll };
