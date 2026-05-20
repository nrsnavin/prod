"use strict";

// ══════════════════════════════════════════════════════════════
//  utils/jobStatusHelper.js
//
//  checkAndAdvanceToWeaving(jobId, session?)
//  ─────────────────────────────────────────
//  Called after EITHER warping OR covering is marked completed.
//  Looks up the job's linked warping and covering docs; if BOTH
//  are in "completed" status AND the job is still "preparatory",
//  advances the job to "weaving".
//
//  CRITICAL: callers run inside `session.withTransaction(...)` and
//  save their warping/covering doc with `{ session }`. That write
//  is NOT visible to a different (default) session until the
//  outer transaction commits. If we don't share the session here,
//  this helper reads the PRE-write state of warping/covering and
//  decides "not both completed yet" — so the job never advances
//  and the Flutter Assign Machine button (gated on job.status ===
//  "weaving") never appears.
//
//  The session is optional so the helper can still be invoked
//  outside a transaction (e.g. from a one-off script).
//
//  Returns: { advanced: Boolean, jobStatus: String }
// ══════════════════════════════════════════════════════════════

const JobOrder = require("../models/JobOrder");
const Warping  = require("../models/Warping");
const Covering = require("../models/Covering");

/**
 * Check if both warping and covering for a job are completed.
 * If so, and if the job is still "preparatory", advance it to
 * "weaving".
 *
 * @param {ObjectId|string}             jobId
 * @param {mongoose.ClientSession|null} [session] active session
 *        if the caller is inside `session.withTransaction(...)`.
 *        Required so the helper sees the in-flight warping /
 *        covering write that just set status to "completed".
 * @returns {{ advanced: boolean, jobStatus: string }}
 */
async function checkAndAdvanceToWeaving(jobId, session = null) {
  // Helper to attach the session only when present — keeps the
  // .session(null) noise out of the standalone-script path.
  const withSession = (q) => (session ? q.session(session) : q);

  const job = await withSession(
    JobOrder.findById(jobId).select("status warping covering")
  ).lean();

  if (!job) {
    console.warn(`[jobStatusHelper] Job not found: ${jobId}`);
    return { advanced: false, jobStatus: "unknown" };
  }

  // Job must be in "preparatory" to advance — if it's already
  // weaving or beyond, nothing to do.
  if (job.status !== "preparatory") {
    return { advanced: false, jobStatus: job.status };
  }

  // Job must have BOTH a warping and a covering linked.
  if (!job.warping || !job.covering) {
    return { advanced: false, jobStatus: job.status };
  }

  // Fetch both docs in parallel — share the session so we read
  // the latest in-transaction state.
  const [warping, covering] = await Promise.all([
    withSession(Warping.findById(job.warping).select("status")).lean(),
    withSession(Covering.findById(job.covering).select("status")).lean(),
  ]);

  const warpingDone  = warping?.status  === "completed";
  const coveringDone = covering?.status === "completed";

  if (!warpingDone || !coveringDone) {
    console.info(
      `[jobStatusHelper] Job ${jobId} not ready yet — ` +
      `warping: ${warping?.status ?? "missing"}, ` +
      `covering: ${covering?.status ?? "missing"}`
    );
    return { advanced: false, jobStatus: job.status };
  }

  // Both done — advance to weaving (still inside the same session
  // so the write is part of the same atomic commit). The filter
  // re-asserts `status: "preparatory"` so a concurrent transition
  // (e.g. the sibling warping/covering /complete arriving moments
  // later) can't overwrite a status that has already moved past
  // weaving — the second call no-ops.
  const updated = await withSession(
    JobOrder.findOneAndUpdate(
      { _id: jobId, status: "preparatory" },
      { status: "weaving" },
      { new: true, select: "status" }
    )
  );

  if (!updated) {
    // Someone else won the race — the job is no longer preparatory.
    // Re-read the current status so callers see truth.
    const current = await withSession(
      JobOrder.findById(jobId).select("status")
    ).lean();
    return { advanced: false, jobStatus: current?.status ?? "unknown" };
  }

  console.info(`[jobStatusHelper] Job ${jobId} advanced → weaving`);
  return { advanced: true, jobStatus: updated.status };
}

module.exports = { checkAndAdvanceToWeaving };
