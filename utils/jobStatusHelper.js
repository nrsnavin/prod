const JobOrder = require("../models/JobOrder");
const Warping = require("../models/Warping");
const Covering = require("../models/Covering");

/**
 * 🔁 Move Job to WEAVING when BOTH Warping & Covering are completed
 *
 * Rules:
 * - Warping.status === completed
 * - Covering.status === completed
 * - Job.status === preparatory
 */
exports.updateJobToWeavingIfReady = async (jobId) => {
  if (!jobId) return;

  // Fetch job with preparatory processes
  const job = await JobOrder.findById(jobId);

  if (!job) return;

  // Only auto-move from preparatory
  if (job.status !== "preparatory") return;

  // Fetch related processes
  const [warping, covering] = await Promise.all([
    Warping.findOne({ job: jobId }),
    Covering.findOne({ job: jobId }),
  ]);

  if (!warping || !covering) return;

  const warpingDone = warping.status === "completed";
  const coveringDone = covering.status === "completed";

  // ✅ BOTH COMPLETED → MOVE TO WEAVING
  if (warpingDone && coveringDone) {
    job.status = "weaving";
    await job.save();

    console.log(
      `[JOB FLOW] Job ${job.jobOrderNo} moved to WEAVING`
    );
  }
};
