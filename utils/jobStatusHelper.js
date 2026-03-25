"use strict";

// ══════════════════════════════════════════════════════════════
//  utils/jobStatusHelper.js
//
//  checkAndAdvanceToWeaving(jobId)
//  ─────────────────────────────
//  Called after EITHER warping OR covering is marked completed.
//  Looks up the job's linked warping and covering docs; if BOTH
//  are in "completed" status AND the job is still "preparatory",
//  advances the job to "weaving".
//
//  Returns: { advanced: Boolean, jobStatus: String }
//
//  Why here and not inline?
//  Both warping.js and covering.js need to call the same logic.
//  Centralising avoids duplication and drift.
// ══════════════════════════════════════════════════════════════

const JobOrder = require("../models/JobOrder");
const Warping  = require("../models/Warping");
const Covering = require("../models/Covering");

/**
 * Check if both warping and covering for a job are completed.
 * If so, and if the job is still "preparatory", advance it to "weaving".
 *
 * @param {ObjectId|string} jobId
 * @returns {{ advanced: boolean, jobStatus: string }}
 */
async function checkAndAdvanceToWeaving(jobId) {
  // Fetch the job with its warping and covering refs
  const job = await JobOrder.findById(jobId)
    .select("status warping covering")
    .lean();

  if (!job) {
    console.warn(`[jobStatusHelper] Job not found: ${jobId}`);
    return { advanced: false, jobStatus: "unknown" };
  }

  // Job must be in "preparatory" to advance — if it's already weaving
  // or beyond, nothing to do.
  if (job.status !== "preparatory") {
    return { advanced: false, jobStatus: job.status };
  }

  // Job must have BOTH a warping and a covering linked
  if (!job.warping || !job.covering) {
    return { advanced: false, jobStatus: job.status };
  }

  // Fetch both docs in parallel — only need the status field
  const [warping, covering] = await Promise.all([
    Warping.findById(job.warping).select("status").lean(),
    Covering.findById(job.covering).select("status").lean(),
  ]);

  const warpingDone  = warping?.status  === "completed";
  const coveringDone = covering?.status === "completed";

  if (!warpingDone || !coveringDone) {
    // One or both still pending — log for debugging
    console.info(
      `[jobStatusHelper] Job ${jobId} not ready yet — ` +
      `warping: ${warping?.status ?? "missing"}, ` +
      `covering: ${covering?.status ?? "missing"}`
    );
    return { advanced: false, jobStatus: job.status };
  }

  // Both done — advance to weaving
  const updated = await JobOrder.findByIdAndUpdate(
    jobId,
    { status: "weaving" },
    { new: true, select: "status" }
  );

  console.info(`[jobStatusHelper] Job ${jobId} advanced → weaving`);
  return { advanced: true, jobStatus: updated?.status ?? "weaving" };
}

module.exports = { checkAndAdvanceToWeaving };