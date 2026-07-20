'use strict';
// ══════════════════════════════════════════════════════════════
//  PRODUCTION RESET — wipe test/trial data, keep the masters.
//
//  Usage (from the repo root on the server):
//
//    node scripts/reset-for-production.js                # DRY RUN — shows what would be deleted
//    node scripts/reset-for-production.js --yes          # actually delete
//    node scripts/reset-for-production.js --yes --reset-stock
//                                                        # also zero Elastic + RawMaterial stock
//
//  ⚠️  BACK UP FIRST. There is no undo:
//    mongodump --uri "$MONGO_URL" --out ~/backup-$(date +%F)
//
//  KEPT (master data — untouched documents):
//    Users (logins), Employees*, Customers, Suppliers, Machines*,
//    Elastics* (+ Costing), Elastic Groups, Raw Materials*,
//    Payroll settings, Bonus config, Notification settings.
//    * = counters/links derived from wiped transactions are reset:
//      Employee.shifts[], Machine.shifts[]/orderRunning/status,
//      Elastic.quantityProduced/reservedStock (+stock with --reset-stock),
//      RawMaterial.stock (only with --reset-stock).
//
//  CLEARED (transactional data):
//    Orders, Job Orders, Delivery Challans, Warping (+plans), Covering,
//    Packing, Shift Plans + Shift Details, Attendance, Payroll runs,
//    Advances, Yearly bonus, Bonus records, Wastage, Material inward/out,
//    Stock movements, Purchase Orders, Leaves, Machine issues,
//    Announcements, Complaints, Feedback, QC records, Production docs,
//    Production plans, Notifications, Outbox, Idempotency keys,
//    learned ETA rates, and document-number Counters (numbering restarts
//    at 1 for a clean production ledger).
// ══════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../config/.env') });
const mongoose = require('mongoose');

const EXECUTE     = process.argv.includes('--yes');
const RESET_STOCK = process.argv.includes('--reset-stock');

// Transactional collections to clear completely (model file → label).
const CLEAR = [
  ['Order',           '../models/Order'],
  ['JobOrder',        '../models/JobOrder'],
  ['DeliveryChallan', '../models/DeliveryChallan'],
  ['Warping',         '../models/Warping'],
  ['WarpingPlan',     '../models/WarpingPlan'],
  ['Covering',        '../models/Covering'],
  ['Packing',         '../models/Packing'],
  ['ShiftPlan',       '../models/ShiftPlan'],
  ['ShiftDetail',     '../models/ShiftDetail'],
  ['Attendance',      '../models/Attendence'],
  ['Payroll',         '../models/Payroll'],
  ['AdvanceRequest',  '../models/Advance'],
  ['YearlyBonus',     '../models/YearlyBonus'],
  ['BonusRecord',     '../models/BonusRecord'],
  ['Wastage',         '../models/Wastage'],
  ['MaterialInward',  '../models/MaterialInward'],
  ['MaterialOut',     '../models/MaterialOut.cjs'],
  ['StockMovement',   '../models/StockMovement'],
  ['PurchaseOrder',   '../models/PurchaseOrder'],
  ['LeaveRequest',    '../models/LeaveRequest'],
  ['MachineIssue',    '../models/MachineIssue'],
  ['Announcement',    '../models/Announcement'],
  ['Complaints',      '../models/Complaints'],
  ['EmployeeFeedback','../models/EmployeeFeedback'],
  ['QcRecord',        '../models/QcRecord'],
  ['Production',      '../models/Production'],
  ['ProductionPlan',  '../models/ProductionPlan'],
  ['Notification',    '../models/Notification'],
  ['Outbox',          '../models/Outbox'],
  ['IdempotencyKey',  '../models/IdempotencyKey'],
  ['EtaRatePosterior','../models/EtaRatePosterior'],
  ['Counter',         '../models/Counter'], // doc numbering restarts at 1
];

async function main() {
  if (!process.env.MONGO_URL) {
    console.error('MONGO_URL is not set (config/.env). Aborting.');
    process.exit(1);
  }
  // A maintenance script has no business (re)building indexes or creating
  // collections — requiring ~35 models would otherwise fire a storm of
  // index builds on connect.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(process.env.MONGO_URL, {});
  const dbName = mongoose.connection.name;
  console.log(`Connected to database: ${dbName}`);
  console.log(EXECUTE ? '\n⚠️  EXECUTE MODE — data WILL be deleted.\n'
                      : '\n🔍 DRY RUN — nothing will be deleted. Re-run with --yes to execute.\n');

  // Masters whose derived counters get reset (loaded for both modes).
  const Employee    = require('../models/Employee');
  const Machine     = require('../models/Machine');
  const Elastic     = require('../models/Elastic');
  const RawMaterial = require('../models/RawMaterial');
  const User        = require('../models/User');

  let totalDocs = 0;
  const plan = [];
  for (const [label, file] of CLEAR) {
    let Model;
    try {
      Model = require(file);
      if (Model && typeof Model.countDocuments !== 'function' && Model.default) {
        Model = Model.default; // ES-module style export (e.g. Complaints)
      }
      if (typeof Model.countDocuments !== 'function') throw new Error('module does not export a mongoose model');
    }
    catch (e) { console.warn(`  (skipping ${label} — model not loadable: ${e.message})`); continue; }
    const count = await Model.countDocuments({});
    totalDocs += count;
    plan.push({ label, Model, count });
  }

  console.log('WILL CLEAR:');
  for (const p of plan) console.log(`  ${p.label.padEnd(18)} ${p.count} docs`);
  console.log(`  ${'TOTAL'.padEnd(18)} ${totalDocs} docs\n`);

  const [users, emps, machines, elastics, materials] = await Promise.all([
    User.countDocuments({}), Employee.countDocuments({}), Machine.countDocuments({}),
    Elastic.countDocuments({}), RawMaterial.countDocuments({}),
  ]);
  console.log('WILL KEEP (documents untouched):');
  console.log(`  Users ${users} · Employees ${emps} · Machines ${machines} · Elastics ${elastics} · RawMaterials ${materials}`);
  console.log('  + Customers, Suppliers, Elastic groups, Costings, Payroll/Bonus/Notification settings\n');
  console.log('WILL RESET on kept docs:');
  console.log('  Employee.shifts[] · Machine.shifts[]/orderRunning/status · Elastic.quantityProduced/reservedStock');
  console.log(RESET_STOCK
    ? '  --reset-stock: Elastic.stock and RawMaterial.stock will be ZEROED\n'
    : '  (Elastic.stock / RawMaterial.stock kept AS-IS — pass --reset-stock to zero them)\n');

  if (!EXECUTE) {
    console.log('Dry run complete. Nothing was changed.');
    await mongoose.disconnect();
    return;
  }

  console.log('Deleting…');
  for (const p of plan) {
    const r = await p.Model.deleteMany({});
    console.log(`  cleared ${p.label} (${r.deletedCount})`);
  }

  console.log('Resetting derived fields on masters…');
  await Employee.updateMany({}, { $set: { shifts: [] } });
  await Machine.updateMany({}, { $set: { shifts: [], orderRunning: null, status: 'free' } });
  const elasticReset = { quantityProduced: 0, reservedStock: 0 };
  if (RESET_STOCK) elasticReset.stock = 0;
  await Elastic.updateMany({}, { $set: elasticReset });
  if (RESET_STOCK) await RawMaterial.updateMany({}, { $set: { stock: 0 } });

  console.log('\n✅ Reset complete. Masters kept; transactions cleared; numbering restarts at 1.');
  console.log('Restart the API so any in-memory state is fresh:  sudo systemctl restart jarvis');
  await mongoose.disconnect();
}

main().catch((err) => { console.error('FAILED:', err); process.exit(1); });
