// ══════════════════════════════════════════════════════════════
//  SEED DEMO WORKERS
//  One-shot script that creates ONE demo Worker Portal account per
//  department so the dept-aware home screen can be exercised end-to-end.
//
//  Run from the prod repo root:
//    node scripts/seed-demo-workers.js
//
//  Idempotent. Re-running prints "existing" for each user and does NOT
//  re-hash the password (which the pre-save hook would do unconditionally
//  on a vanilla `user.save()`).
//
//  Credentials produced (all share the same password):
//    Password : worker123
//    warping  : warper@demo.local
//    covering : coverer@demo.local
//    checking : checker@demo.local
//    packing  : packer@demo.local
//
//  These are demo accounts with role='employee' — they CANNOT hit any
//  admin-gated endpoint. Use them to log in to the Worker Portal only.
// ══════════════════════════════════════════════════════════════

"use strict";

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../config/.env"),
});

const mongoose = require("mongoose");

// Register the audit plugin (matches app.js bootstrap) so any pre-save
// hooks that depend on createdBy/updatedBy don't blow up.
const auditFields = require("../models/plugins/auditFields.js");
mongoose.plugin(auditFields);

const Employee = require("../models/Employee");
const User     = require("../models/User");

const PASSWORD = "worker123";

const DEMOS = [
  { dept: "warping",  name: "Demo Warper",  email: "warper@demo.local",  phone: "9000000001", role: "operator" },
  { dept: "covering", name: "Demo Coverer", email: "coverer@demo.local", phone: "9000000002", role: "operator" },
  { dept: "checking", name: "Demo Checker", email: "checker@demo.local", phone: "9000000003", role: "operator" },
  { dept: "packing",  name: "Demo Packer",  email: "packer@demo.local",  phone: "9000000004", role: "operator" },
];

async function main() {
  if (!process.env.MONGO_URL) {
    throw new Error(
      "MONGO_URL is not set. Did config/.env load? Run from the repo root."
    );
  }

  await mongoose.connect(process.env.MONGO_URL, {});
  console.log(`Connected: ${mongoose.connection.host}\n`);

  for (const d of DEMOS) {
    // ── Employee ────────────────────────────────────
    // Look up by phone (the admin /create-employee endpoint dedupes by phone).
    let emp = await Employee.findOne({ phoneNumber: d.phone });
    if (!emp) {
      emp = await Employee.create({
        name:        d.name,
        phoneNumber: d.phone,
        department:  d.dept,
        role:        d.role,
        hourlyRate:  0,
        skill:       0,
        performance: 0,
      });
      console.log(`[employee] created ${emp.name.padEnd(15)} dept=${d.dept.padEnd(8)} _id=${emp._id}`);
    } else {
      console.log(`[employee] existing ${emp.name.padEnd(15)} dept=${emp.department.padEnd(8)} _id=${emp._id}`);
    }

    // ── User ─────────────────────────────────────────
    // Email is unique. Pre-save hook hashes password unconditionally
    // (it doesn't actually short-circuit on `isModified === false`), so
    // we only call create() when the user is brand-new; reconciliation
    // of the employee link uses updateOne() to bypass the hook entirely.
    let user = await User.findOne({ email: d.email });
    if (!user) {
      user = await User.create({
        name:     d.name,
        email:    d.email,
        password: PASSWORD,
        role:     "employee",
        employee: emp._id,
      });
      console.log(`[user]     created ${user.email.padEnd(25)} pwd="${PASSWORD}"  _id=${user._id}`);
    } else {
      const needsLink =
        !user.employee || user.employee.toString() !== emp._id.toString();
      if (needsLink) {
        await User.updateOne({ _id: user._id }, { $set: { employee: emp._id } });
        console.log(`[user]     re-linked ${user.email.padEnd(25)} → employee ${emp._id}`);
      } else {
        console.log(`[user]     existing  ${user.email.padEnd(25)} _id=${user._id}`);
      }
    }
    console.log("");
  }

  console.log("═".repeat(60));
  console.log("Demo Worker Portal credentials");
  console.log("═".repeat(60));
  console.log(`  Password: ${PASSWORD}\n`);
  for (const d of DEMOS) {
    console.log(`  ${d.dept.padEnd(10)} ${d.email}`);
  }
  console.log("═".repeat(60));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
