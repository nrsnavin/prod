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
const { isAuthenticated, isAdmin } = require("../middleware/auth");

// All warping routes require login. Workers in the `warping` department
// need to read /list, /detail, /warpingPlan and /plan-context to monitor
// their assigned jobs in the employee app. Mutations stay admin-only.
router.use(isAuthenticated);

router.post("/create", isAdmin('admin'), catchAsyncErrors(async (req, res, next) => {
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

  let autoPlan = null;
  try {
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
        break;
      }
    }
  } catch (planErr) {
    console.warn("Auto warping plan creation failed:", planErr.message);
  }

  res.status(201).json({ success: true, warping, autoPlan });
}));

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

router.post("/start", isAdmin('admin'), catchAsyncErrors(async (req, res, next) => {
  const id = req.body.id ?? req.query.id;
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

router.post("/complete", isAdmin('admin'), catchAsyncErrors(async (req, res, next) => {
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

router.patch("/cancel/:id", isAdmin('admin'), catchAsyncErrors(async (req, res, next) => {
  const warping = await Warping.findById(req.params.id);
  if (!warping) return next(new ErrorHandler("Warping not found", 404));
  warping.status = "cancelled";
  await warping.save();
  res.json({ success: true, warping });
}));

router.get("/warpingPlan", catchAsyncErrors(async (req, res, next) => {
  if (!req.query.id) return next(new ErrorHandler("id is required", 400));

  const plan = await WarpingPlan.findOne({ warping: req.query.id })
    .populate("job", "jobOrderNo status")
    .populate("beams.sections.warpYarn", "name category");

  if (!plan) return res.json({ exists: false });
  res.json({ exists: true, plan });
}));

router.post("/warpingPlan/create", isAdmin('admin'), catchAsyncErrors(async (req, res, next) => {
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

  const prefillTemplate = elasticTemplates.length > 0 ? elasticTemplates[0] : null;

  res.json({
    success:          true,
    jobId:            job._id,
    warpYarns:        Array.from(warpMap.values()),
    prefillTemplate,
    elasticTemplates,
  });
}));

module.exports = router;
