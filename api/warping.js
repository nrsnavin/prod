"use strict";

const express          = require("express");
const router           = express.Router();
const mongoose         = require("mongoose");

const Warping          = require("../models/Warping");
const JobOrder         = require("../models/JobOrder");
const Order            = require("../models/Order");
const WarpingPlan      = require("../models/WarpingPlan");
const Elastic          = require("../models/Elastic");
const ErrorHandler     = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { checkAndAdvanceToWeaving } = require("../utils/jobStatusHelper");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");


// ── 1. CREATE WARPING ──────────────────────────────────────────
//  After creating the Warping doc, looks at every elastic in the
//  job for a warpingPlanTemplate. The FIRST elastic that has one
//  wins — its template is used to auto-create the WarpingPlan.
//  This is non-fatal: if no template is found, or creation fails,
//  the warping is still returned without a plan.
router.post("/create", catchAsyncErrors(async (req, res, next) => {
  const { jobId, elasticOrdered } = req.body;
  if (!jobId) return next(new ErrorHandler("Job ID is required", 400));

  const job = await JobOrder.findById(jobId);
  if (!job) return next(new ErrorHandler("Job not found", 404));

  const warping = await Warping.create({
    job:            jobId,
    elasticOrdered: elasticOrdered || job.elastics,
  });

  job.warping = warping._id;
  await job.save();

  // ── Auto-create WarpingPlan from elastic template ────────────
  let autoPlan = null;
  try {
    // Re-fetch job populated with elastic → warpingPlanTemplate
    const jobFull = await JobOrder.findById(jobId).populate({
      path:   "elastics.elastic",
      select: "warpingPlanTemplate",
    });

    for (const entry of (jobFull?.elastics || [])) {
      const tpl = entry?.elastic?.warpingPlanTemplate;
      if (
        tpl &&
        Array.isArray(tpl.beams) &&
        tpl.beams.length > 0 &&
        tpl.beams.some((b) => b.sections?.length > 0)
      ) {
        autoPlan = await WarpingPlan.create({
          warping:   warping._id,
          job:       jobId,
          noOfBeams: tpl.noOfBeams || tpl.beams.length,
          beams:     tpl.beams,
          remarks:   "Auto-created from elastic warping plan template",
        });
        warping.warpingPlan = autoPlan._id;
        await warping.save();
        break; // first-wins
      }
    }
  } catch (planErr) {
    // Non-fatal — operator can create plan manually
    console.warn("Auto warping plan creation failed:", planErr.message);
  }

  res.status(201).json({ success: true, warping, autoPlan });
}));


// ── 2. LIST WARPINGS ───────────────────────────────────────────
router.get("/list", catchAsyncErrors(async (req, res, next) => {
  const { status = "open", search = "", page = 1, limit = 20 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const filter = {};
  if (status && status !== "all") filter.status = status;

  if (search) {
    const num = parseInt(search, 10);
    if (!isNaN(num)) {
      const jobs = await JobOrder.find({ jobOrderNo: num }).select("_id");
      if (!jobs.length) {
        return res.json({
          success: true, data: [],
          pagination: { total: 0, page: Number(page), limit: Number(limit), hasMore: false },
        });
      }
      filter.job = { $in: jobs.map((j) => j._id) };
    }
  }

  const [warpings, total] = await Promise.all([
    Warping.find(filter)
      .populate({ path: "job", select: "jobOrderNo status date customer" })
      .populate("warpingPlan", "_id noOfBeams")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),
    Warping.countDocuments(filter),
  ]);

  res.json({
    success: true, data: warpings,
    pagination: {
      total, page: Number(page), limit: Number(limit),
      hasMore: skip + warpings.length < total,
    },
  });
}));


// ── 3. GET WARPING DETAIL ──────────────────────────────────────
router.get("/detail/:id", catchAsyncErrors(async (req, res, next) => {
  const warping = await Warping.findById(req.params.id)
    .populate({ path: "job", select: "jobOrderNo status date" })
    .populate({
      path: "elasticOrdered.elastic",
      populate: [
        { path: "warpSpandex.id",     select: "name category" },
        { path: "warpYarn.id",        select: "name category" },
        { path: "spandexCovering.id", select: "name category" },
        { path: "weftYarn.id",        select: "name category" },
      ],
    })
    .populate({
      path: "warpingPlan",
      populate: { path: "beams.sections.warpYarn", select: "name category" },
    });

  if (!warping) return next(new ErrorHandler("Warping not found", 404));
  res.json({ success: true, warping });
}));


// ── 4. START WARPING ───────────────────────────────────────────
//
//  CHANGED: was PUT — switched to POST so the actor body always
//  reaches the server (some reverse proxies strip PUT bodies).
//  `id` now rides in the body too.
router.post("/start", catchAsyncErrors(async (req, res, next) => {
  const id = req.body.id ?? req.query.id;            // accept both for compat
  if (!id) return next(new ErrorHandler("id is required", 400));

  const session = await mongoose.startSession();
  try {
    let resp;
    await session.withTransaction(async () => {
      const warping = await Warping.findById(id).session(session);
      if (!warping) throw new ErrorHandler("Warping not found", 404);

      if (!warping.warpingPlan)
        throw new ErrorHandler("Create a warping plan before starting", 400);
      if (warping.status !== "open")
        throw new ErrorHandler("Warping already started or completed", 400);

      warping.status = "in_progress";
      await warping.save({ session });

      // 🪪 Fingerprint on the parent JobOrder (in-tx via .save())
      const fp = buildFingerprint(ACTION_CODES.WARPING_STARTED, {
        entityId: warping.job,
        actor:    actorFromRequest(req),
        meta:     { warpingId: warping._id.toString() },
      });
      const job = await JobOrder.findById(warping.job).session(session);
      if (job) {
        job.fingerprints.push(fp);
        await job.save({ session });
      }

      resp = { warping, fingerprint: fp };
    });
    res.json({ success: true, ...resp });
  } catch (err) {
    return next(err);
  } finally {
    session.endSession();
  }
}));


// ── 5. COMPLETE WARPING ────────────────────────────────────────
//
//  CHANGED: PUT → POST (same proxy reasoning as /start).
//  ROLLUP : on completion, mirror a WARPING_COMPLETED fingerprint
//           onto the parent Order so the order timeline shows the
//           milestone too. Granular events stay on the job only.
router.post("/complete", catchAsyncErrors(async (req, res, next) => {
  const id = req.body.id ?? req.query.id;
  if (!id) return next(new ErrorHandler("id is required", 400));

  const session = await mongoose.startSession();
  try {
    let resp;
    await session.withTransaction(async () => {
      const warping = await Warping.findById(id).session(session);
      if (!warping) throw new ErrorHandler("Warping not found", 404);
      if (warping.status !== "in_progress")
        throw new ErrorHandler("Warping is not in progress", 400);

      warping.status        = "completed";
      warping.completedDate = new Date();
      await warping.save({ session });

      // checkAndAdvanceToWeaving runs its own writes — keep it inside
      // the session window so any side-effects participate in the tx.
      const { advanced, jobStatus } = await checkAndAdvanceToWeaving(warping.job);

      const actor = actorFromRequest(req);
      const fp = buildFingerprint(ACTION_CODES.WARPING_COMPLETED, {
        entityId: warping.job,
        actor,
        meta: {
          warpingId:     warping._id.toString(),
          completedDate: warping.completedDate,
          jobAdvanced:   advanced,
          jobStatus,
        },
      });

      const job = await JobOrder.findById(warping.job).session(session);
      if (job) {
        job.fingerprints.push(fp);
        await job.save({ session });

        // 🪪 Mirror milestone onto parent Order timeline
        if (job.order) {
          const order = await Order.findById(job.order).session(session);
          if (order) {
            order.fingerprints.push(buildFingerprint(ACTION_CODES.WARPING_COMPLETED, {
              entityId: order._id,
              actor,
              meta: {
                jobId:          job._id.toString(),
                jobOrderNo:     job.jobOrderNo,
                warpingId:      warping._id.toString(),
                relatedHash:    fp.hash,
                relatedShortId: fp.shortId,
              },
            }));
            await order.save({ session });
          }
        }
      }

      resp = {
        warping,
        job:         { advanced, status: jobStatus },
        fingerprint: fp,
      };
    });
    res.json({ success: true, ...resp });
  } catch (err) {
    return next(err);
  } finally {
    session.endSession();
  }
}));


// ── 6. CANCEL WARPING ──────────────────────────────────────────
router.patch("/cancel/:id", catchAsyncErrors(async (req, res, next) => {
  const warping = await Warping.findById(req.params.id);
  if (!warping) return next(new ErrorHandler("Warping not found", 404));
  warping.status = "cancelled";
  await warping.save();
  res.json({ success: true, warping });
}));


// ── 7. GET WARPING PLAN BY WARPING ID ─────────────────────────
router.get("/warpingPlan", catchAsyncErrors(async (req, res, next) => {
  if (!req.query.id) return next(new ErrorHandler("id is required", 400));

  const plan = await WarpingPlan.findOne({ warping: req.query.id })
    .populate("job", "jobOrderNo status")
    .populate("beams.sections.warpYarn", "name category");

  if (!plan) return res.json({ exists: false });
  res.json({ exists: true, plan });
}));


// ── 8. CREATE WARPING PLAN (manual) ───────────────────────────
router.post("/warpingPlan/create", catchAsyncErrors(async (req, res, next) => {
  const { warpingId, beams, remarks } = req.body;
  if (!warpingId)     return next(new ErrorHandler("warpingId is required", 400));
  if (!beams?.length) return next(new ErrorHandler("At least one beam is required", 400));

  const warping = await Warping.findById(warpingId);
  if (!warping)            return next(new ErrorHandler("Warping not found", 404));
  if (warping.warpingPlan) return next(new ErrorHandler("Warping plan already exists", 400));

  const plan = await WarpingPlan.create({
    warping:   warping._id,
    job:       warping.job,
    noOfBeams: beams.length,
    beams,
    remarks:   remarks || "",
  });

  warping.warpingPlan = plan._id;
  await warping.save();

  const populated = await WarpingPlan.findById(plan._id)
    .populate("job", "jobOrderNo status")
    .populate("beams.sections.warpYarn", "name category");

  res.status(201).json({ success: true, plan: populated });
}));


// ── 9. PLAN CONTEXT — WARP YARNS + PREFILL TEMPLATE FOR JOB ──
router.get("/plan-context/:jobId", catchAsyncErrors(async (req, res, next) => {
  const job = await JobOrder.findById(req.params.jobId)
    .populate({
      path: "elastics.elastic",
      populate: [
        { path: "warpYarn.id", model: "RawMaterial" },
        {
          path: "warpingPlanTemplate.beams.sections.warpYarn",
          model: "RawMaterial",
          select: "name category",
        },
      ],
    });

  if (!job) return next(new ErrorHandler("Job not found", 404));

  // ── Collect all unique warp yarns across all elastics ──────
  const warpMap = new Map();
  job.elastics.forEach((e) => {
    if (!e.elastic) return;
    (e.elastic.warpYarn || []).forEach((w) => {
      if (w.id?._id) {
        warpMap.set(w.id._id.toString(), {
          id: w.id._id.toString(), name: w.id.name,
        });
      }
    });
  });

  // ── Normalise helper ───────────────────────────────────────
  const normaliseBeams = (tpl, warpMap) => {
    return (tpl.beams || []).map((beam) => ({
      beamNo:    beam.beamNo,
      totalEnds: beam.totalEnds,
      sections:  (beam.sections || [])
        .filter((s) => s.warpYarn && s.ends > 0)
        .map((s) => {
          const isPopulated = s.warpYarn && typeof s.warpYarn === "object" && s.warpYarn.name;
          return {
            warpYarnId:   isPopulated ? s.warpYarn._id.toString() : s.warpYarn.toString(),
            warpYarnName: isPopulated ? s.warpYarn.name : (warpMap.get(s.warpYarn.toString())?.name ?? ""),
            ends:         s.ends,
            maxMeters:    s.maxMeters ?? 0,
          };
        }),
    })).filter((b) => b.sections.length > 0);
  };

  // ── Collect per-elastic templates (ALL elastics that have one) ─
  const elasticTemplates = [];
  for (const entry of (job.elastics || [])) {
    const elastic = entry?.elastic;
    if (!elastic) continue;
    const tpl = elastic.warpingPlanTemplate;
    if (!tpl || !tpl.beams || tpl.beams.length === 0) continue;
    const normalisedBeams = normaliseBeams(tpl, warpMap);
    if (normalisedBeams.length === 0) continue;
    elasticTemplates.push({
      elasticId:   elastic._id.toString(),
      elasticName: elastic.name ?? "Elastic",
      beams:       normalisedBeams,
    });
  }

  // First elastic template also used as the auto-prefill
  const prefillTemplate = elasticTemplates.length > 0 ? elasticTemplates[0] : null;

  res.json({
    success:          true,
    jobId:            job._id,
    warpYarns:        Array.from(warpMap.values()),
    prefillTemplate,   // first elastic's template — used to auto-fill on page open
    elasticTemplates,  // all elastic templates — used for per-elastic copy buttons
  });
}));


module.exports = router;