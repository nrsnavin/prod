#!/usr/bin/env node
// scripts/backfill-stuck-jobs.js
// ─────────────────────────────────────────────────────────────
//  One-shot, idempotent backfill of jobs that should have
//  advanced to "weaving" but were left in "preparatory" by the
//  jobStatusHelper session bug (fixed in prod#23).
//
//  For every JobOrder still in "preparatory", we check whether
//  the linked Warping AND Covering are both `status === "completed"`.
//  If yes, we advance the job to "weaving" and stamp a
//  JOB_STAGE_UPDATED fingerprint tagged `backfill: true` so the
//  audit trail makes the source of the transition obvious.
//
//  Idempotent — jobs already past "preparatory" are skipped.
//  Safe to re-run.
//
//  Run from the repo root once MONGO_URI / DB_URL is set:
//    node scripts/backfill-stuck-jobs.js
//
//  Dry-run mode prints which jobs would advance without writing:
//    node scripts/backfill-stuck-jobs.js --dry-run
// ─────────────────────────────────────────────────────────────
"use strict";

try { require("dotenv").config(); } catch (_) { /* dotenv optional */ }

const mongoose = require("mongoose");

const JobOrder = require("../models/JobOrder");
const Warping  = require("../models/Warping");
const Covering = require("../models/Covering");
const { buildFingerprint, ACTION_CODES } = require("../utils/fingerprint");

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGO_URI || process.env.DB_URL || process.env.MONGO_URL;
  if (!uri) {
    console.error("MONGO_URI / DB_URL / MONGO_URL not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(
    `Connected.${DRY_RUN ? " (dry-run — no writes will be made)" : ""}`
  );

  const jobs = await JobOrder.find({ status: "preparatory" })
    .select("_id jobOrderNo warping covering")
    .lean();

  console.log(`Scanning ${jobs.length} jobs still in "preparatory".`);

  let advanced     = 0;
  let missingRef   = 0;
  let notReady     = 0;
  let alreadyDone  = 0; // shouldn't happen, but guard against races
  const advancedJobs = [];

  for (const job of jobs) {
    if (!job.warping || !job.covering) {
      missingRef++;
      continue;
    }

    const [w, c] = await Promise.all([
      Warping.findById(job.warping).select("status").lean(),
      Covering.findById(job.covering).select("status").lean(),
    ]);

    const warpingDone  = w?.status === "completed";
    const coveringDone = c?.status === "completed";

    if (!warpingDone || !coveringDone) {
      notReady++;
      continue;
    }

    if (DRY_RUN) {
      advancedJobs.push({
        id:         job._id,
        jobOrderNo: job.jobOrderNo,
      });
      advanced++;
      continue;
    }

    // Stamp a backfill fingerprint so the timeline shows where
    // this transition came from.
    const fp = buildFingerprint(ACTION_CODES.JOB_STAGE_UPDATED, {
      entityId: job._id,
      actor:    { id: "system", name: "Backfill", role: "system" },
      meta: {
        previousStage: "preparatory",
        newStage:      "weaving",
        jobOrderNo:    job.jobOrderNo,
        backfill:      true,
        reason:        "stuck-job recovery after prod#23 session fix",
      },
    });

    const res = await JobOrder.findOneAndUpdate(
      { _id: job._id, status: "preparatory" },
      {
        $set:  { status: "weaving" },
        $push: { fingerprints: fp },
      },
      { new: true, select: "_id jobOrderNo status" }
    );

    if (res?.status === "weaving") {
      advanced++;
      advancedJobs.push({
        id:         res._id,
        jobOrderNo: res.jobOrderNo,
      });
    } else {
      // Another writer advanced the job between our read and write.
      alreadyDone++;
    }
  }

  console.log(`\n${DRY_RUN ? "[dry-run] would advance" : "Advanced"} ${advanced} job(s).`);
  console.log(`Missing warping/covering ref: ${missingRef}.`);
  console.log(`Not both completed yet:      ${notReady}.`);
  if (alreadyDone > 0) {
    console.log(`Already advanced by another writer: ${alreadyDone}.`);
  }

  if (advancedJobs.length > 0) {
    console.log(`\n${DRY_RUN ? "Would advance" : "Advanced"} jobs:`);
    for (const j of advancedJobs) {
      console.log(`  job #${j.jobOrderNo}  (${j.id})`);
    }
  }

  if (DRY_RUN) {
    console.log(
      "\nRe-run without --dry-run to apply these transitions."
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
