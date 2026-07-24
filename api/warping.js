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
const { buildFingerprint, ACTION_CODES, actorFromRequest, stampFingerprint } = require("../utils/fingerprint");
const { requireReason } = require("../utils/auditReason");
const { assertVersion } = require("../utils/versioning");
const { isAuthenticated, isAdmin, requireFeature } = require("../middleware/auth");

// All warping routes require login. Workers in the `warping` department
// need to read /list, /detail, /warpingPlan and /plan-context to monitor
// their assigned jobs in the employee app. Mutations stay admin-only.
router.use(isAuthenticated);
// Per-user feature gate (Phase 4): warping serves both the Warping and
// Covering screens, so either feature grants access. No-op for users
// without an explicit feature list (legacy) — see requireFeature.
router.use(requireFeature('/warping', '/covering'));

router.post("/create", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
  const { jobId, elasticOrdered } = req.body;
  if (!jobId) return next(new ErrorHandler("Job ID is required", 400));
  if (!mongoose.Types.ObjectId.isValid(jobId)) {
    return next(new ErrorHandler("Invalid job id", 400));
  }

  // Atomic claim: create the Warping and link it on the JobOrder in
  // the same transaction. The findOneAndUpdate filter `warping: null`
  // makes the link a CAS — two parallel POSTs on the same jobId can't
  // both create + link; the loser sees no matching JobOrder and rolls
  // back so we don't strand an orphan Warping doc.
  const session = await mongoose.startSession();
  let warping;
  let job;
  try {
    await session.withTransaction(async () => {
      const peek = await JobOrder.findById(jobId).session(session);
      if (!peek) throw new ErrorHandler("Job not found", 404);
      if (peek.warping) {
        throw new ErrorHandler(
          "Job already has a warping linked", 409
        );
      }
      const [created] = await Warping.create([{
        job:            jobId,
        elasticOrdered: elasticOrdered || peek.elastics,
      }], { session });
      warping = created;

      const claimed = await JobOrder.findOneAndUpdate(
        { _id: jobId, warping: null },
        { warping: warping._id },
        { new: true, session }
      );
      if (!claimed) {
        // Another request linked a Warping between our peek and CAS.
        // Throw to roll the transaction back so the new Warping doc
        // doesn't survive as an orphan.
        throw new ErrorHandler(
          "Job already has a warping linked", 409
        );
      }
      job = claimed;
    });
  } finally {
    await session.endSession();
  }

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
      .populate({ path: "elasticOrdered.elastic", select: "name" })
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

router.post("/start", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
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

router.post("/complete", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
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

      // FIX: pass the session so the helper sees the just-written
      // warping.status = "completed". Without this, the helper
      // reads the pre-write snapshot and the job never advances.
      const { advanced, jobStatus } = await checkAndAdvanceToWeaving(
        warping.job,
        session
      );

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

router.patch("/cancel/:id", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
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

router.post("/warpingPlan/create", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
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

// ─────────────────────────────────────────────────────────────────────────
// PUT /warpingPlan/:id — edit a plan's remarks (and optionally beams).
// Only while the parent warping is still open. Requires an audit reason;
// stamps a WARPING_PLAN_UPDATED fingerprint on the parent job.
// ─────────────────────────────────────────────────────────────────────────
router.put("/warpingPlan/:id", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new ErrorHandler("Invalid plan id", 400));
  }
  const auditReason = requireReason(req);
  if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));

  const { remarks, beams } = req.body;
  const plan = await WarpingPlan.findById(req.params.id);
  if (!plan) return next(new ErrorHandler("Warping plan not found", 404));
  // Optimistic lock: reject the edit if another user saved since this
  // client loaded the plan (409 → client reloads).
  assertVersion(plan, req);

  const warping = await Warping.findById(plan.warping);
  if (warping && warping.status !== "open") {
    return next(new ErrorHandler(`Plan can only be edited while warping is open (current: "${warping.status}").`, 400));
  }

  const before = { remarks: plan.remarks, noOfBeams: plan.noOfBeams };
  if (remarks !== undefined) plan.remarks = String(remarks);
  if (Array.isArray(beams) && beams.length > 0) { plan.beams = beams; plan.noOfBeams = beams.length; }
  plan.increment(); // bump __v so concurrent editors get a 409
  await plan.save();

  const job = await JobOrder.findById(plan.job);
  if (job) {
    stampFingerprint(job, ACTION_CODES.WARPING_PLAN_UPDATED, {
      req,
      meta: { planId: plan._id.toString(), auditReason, before, after: { remarks: plan.remarks, noOfBeams: plan.noOfBeams } },
    });
    await job.save();
  }

  const populated = await WarpingPlan.findById(plan._id)
    .populate("job", "jobOrderNo status")
    .populate("beams.sections.warpYarn", "name category");
  res.status(200).json({ success: true, plan: populated });
}));

// ─────────────────────────────────────────────────────────────────────────
// DELETE /warpingPlan/:id — remove a plan (only while warping is open) so a
// corrected one can be created. Requires an audit reason; stamps a
// WARPING_PLAN_DELETED fingerprint on the parent job.
// ─────────────────────────────────────────────────────────────────────────
router.delete("/warpingPlan/:id", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new ErrorHandler("Invalid plan id", 400));
  }
  const auditReason = requireReason(req);
  if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to delete", 400));

  const plan = await WarpingPlan.findById(req.params.id);
  if (!plan) return next(new ErrorHandler("Warping plan not found", 404));

  const warping = await Warping.findById(plan.warping);
  if (warping && warping.status !== "open") {
    return next(new ErrorHandler(`Plan can only be deleted while warping is open (current: "${warping.status}").`, 400));
  }

  const job = await JobOrder.findById(plan.job);
  if (job) {
    stampFingerprint(job, ACTION_CODES.WARPING_PLAN_DELETED, {
      req,
      meta: { planId: plan._id.toString(), auditReason, noOfBeams: plan.noOfBeams },
    });
    await job.save();
  }

  if (warping) { warping.warpingPlan = undefined; await warping.save(); }
  await plan.deleteOne();

  res.status(200).json({ success: true, message: "Warping plan deleted", id: plan._id });
}));

// ─────────────────────────────────────────────────────────────────────────
// GET /optimize-layout/:warpingId?capacity=600
//
// Proposes an optimised beam layout for a warping. Treats it as bin-packing:
// each warp yarn needs a number of ends; beams have a fixed ends capacity.
// A first-fit-decreasing pack keeps small yarns whole (no changeover) and
// only splits a yarn when it exceeds a beam, minimising both beam count and
// yarn changeovers vs a naive one-yarn-per-beam layout. Deterministic; the
// admin reviews and applies via /warpingPlan/create.
// ─────────────────────────────────────────────────────────────────────────
function _packBeams(items, capacity) {
  const C = Math.max(1, Number(capacity) || 600);
  const beams = [];
  const newBeam = () => { const b = { capacityLeft: C, totalEnds: 0, sections: [] }; beams.push(b); return b; };
  const place = (beam, item, take) => {
    const existing = beam.sections.find((s) => s.warpYarnId === item.yarnId);
    if (existing) existing.ends += take;
    else beam.sections.push({ warpYarnId: item.yarnId, warpYarnName: item.yarnName, ends: take });
    beam.capacityLeft -= take; beam.totalEnds += take;
  };
  // Largest yarns first.
  const sorted = [...items].sort((a, b) => b.ends - a.ends);
  for (const item of sorted) {
    const whole = beams.find((b) => b.capacityLeft >= item.ends);
    if (whole) { place(whole, item, item.ends); continue; }
    let remaining = item.ends;
    while (remaining > 0) {
      const b = beams.find((x) => x.capacityLeft > 0) || newBeam();
      const take = Math.min(remaining, b.capacityLeft);
      place(b, item, take);
      remaining -= take;
    }
  }
  return { beams, capacity: C };
}

router.get("/optimize-layout/:warpingId", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.warpingId)) {
    return next(new ErrorHandler("Invalid warping id", 400));
  }
  const warping = await Warping.findById(req.params.warpingId);
  if (!warping) return next(new ErrorHandler("Warping not found", 404));

  const job = await JobOrder.findById(warping.job)
    .populate({ path: "elastics.elastic", populate: [
      { path: "warpYarn.id", select: "name" },
      { path: "warpSpandex.id", select: "name" },
    ] });
  if (!job) return next(new ErrorHandler("Job not found for this warping", 404));

  // Aggregate required ends per warp yarn across the job's elastics.
  const byYarn = new Map();
  const add = (id, name, ends) => {
    if (!id || !(ends > 0)) return;
    const key = id.toString();
    const cur = byYarn.get(key) || { yarnId: key, yarnName: name || "Yarn", ends: 0 };
    cur.ends += Number(ends);
    byYarn.set(key, cur);
  };
  for (const line of job.elastics || []) {
    const el = line.elastic;
    if (!el || typeof el !== "object") continue;
    if (el.warpSpandex?.id) add(el.warpSpandex.id._id || el.warpSpandex.id, el.warpSpandex.id?.name || "Spandex", el.warpSpandex.ends);
    for (const w of el.warpYarn || []) if (w.id) add(w.id._id || w.id, w.id?.name, w.ends);
  }
  const items = [...byYarn.values()];
  if (items.length === 0) {
    return res.json({ success: true, warpingId: warping._id.toString(), items: [], message: "No warp-yarn ends found on this warping's elastics." });
  }

  const capacity = Math.min(Math.max(Number(req.query.capacity) || 600, 20), 5000);
  const { beams } = _packBeams(items, capacity);

  const totalEnds = items.reduce((s, i) => s + i.ends, 0);
  const totalSections = beams.reduce((s, b) => s + b.sections.length, 0);
  // Naive baseline: one yarn group per beam (each yarn split only by capacity).
  const baselineBeams = items.reduce((s, i) => s + Math.ceil(i.ends / capacity), 0);
  const fillRate = beams.length > 0 ? Math.round((totalEnds / (beams.length * capacity)) * 100) : 0;

  const proposedBeams = beams.map((b, i) => ({
    beamNo: i + 1,
    totalEnds: b.totalEnds,
    fillPct: Math.round((b.totalEnds / capacity) * 100),
    sections: b.sections.map((s) => ({ warpYarnId: s.warpYarnId, warpYarnName: s.warpYarnName, ends: s.ends })),
  }));

  res.json({
    success: true,
    warpingId: warping._id.toString(),
    jobOrderNo: job.jobOrderNo,
    capacity,
    metrics: {
      beamsUsed: beams.length,
      baselineBeams,
      beamsSaved: Math.max(0, baselineBeams - beams.length),
      totalEnds,
      totalYarns: items.length,
      changeovers: Math.max(0, totalSections - beams.length),
      fillRate,
    },
    beams: proposedBeams,
    assumptions: [
      `Beam capacity ${capacity} ends (adjust for your warping frame).`,
      "Largest yarns are placed first; small yarns share a beam to cut changeovers.",
      "A yarn only splits across beams when it exceeds one beam's capacity.",
      "Applying creates the warping plan — you can still edit beams before starting.",
    ],
  });
}));

router.get("/plan-context/:jobId", catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.jobId)) {
    return next(new ErrorHandler("Invalid job id", 400));
  }
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
