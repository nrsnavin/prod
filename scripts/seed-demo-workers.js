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
//  Accounts produced:
//    warping  : warper@demo.local
//    covering : coverer@demo.local
//    checking : checker@demo.local
//    packing  : packer@demo.local
//
//  THE PASSWORD is made for the run and printed once (or set
//  DEMO_WORKER_PASSWORD to choose it). It used to be one fixed word,
//  written here — so every database this was ever run against held four
//  logins whose password anyone with the code could read. And it ran
//  against whatever MONGO_URL named; it now refuses a database that
//  looks live, as the other demo seed does (scripts/lib/demoTarget.js).
//
//  These are demo accounts with role='employee' — they CANNOT hit any
//  admin-gated endpoint. Use them to log in to the Worker Portal only.
// ══════════════════════════════════════════════════════════════

"use strict";

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../config/.env"),
});

const crypto   = require("crypto");
const mongoose = require("mongoose");
const { assertSafeTarget } = require("./lib/demoTarget.js");

// Register the audit plugin (matches app.js bootstrap) so any pre-save
// hooks that depend on createdBy/updatedBy don't blow up.
const auditFields = require("../models/plugins/auditFields.js");
mongoose.plugin(auditFields);

const Employee = require("../models/Employee");
const User     = require("../models/User");

const PASSWORD = process.env.DEMO_WORKER_PASSWORD || crypto.randomBytes(12).toString("base64url");

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

  assertSafeTarget(process.env.MONGO_URL, {
    log: (...a) => console.log("[demo-workers]", ...a),
    what: [
      "This script creates four demo employees and four logins that anyone",
      "holding the password printed at the end can sign in with.",
    ],
    command: "node scripts/seed-demo-workers.js",
  });

  await mongoose.connect(process.env.MONGO_URL, {});
  console.log(`Connected: ${mongoose.connection.host}\n`);

  const created = [];

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
      created.push(d);
      console.log(`[user]     created ${user.email.padEnd(25)} _id=${user._id}`);
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
  console.log("Demo Worker Portal accounts");
  console.log("═".repeat(60));
  // Said only for the accounts this run made: one that was already
  // there keeps the password it had, which this run does not know.
  if (created.length) {
    console.log(`  Password: ${PASSWORD}`);
    console.log(`  (for the ${created.length} account(s) created just now — it is not kept anywhere)\n`);
  } else {
    console.log("  All four were already there; their passwords are unchanged.");
    console.log("  Set a new one with scripts/set-password.js if it is not known.\n");
  }
  for (const d of DEMOS) {
    console.log(`  ${d.dept.padEnd(10)} ${d.email}${created.includes(d) ? "   (new)" : ""}`);
  }
  console.log("═".repeat(60));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
