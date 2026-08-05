"use strict";

const express          = require("express");
const router           = express.Router();
const mongoose         = require("mongoose");

const Warping          = require("../models/Warping");
const JobOrder         = require("../models/JobOrder");
const Order            = require("../models/Order");
const WarpingPlan      = require("../models/WarpingPlan");
const WarpingBatch     = require("../models/WarpingBatch");
const YarnLot          = require("../models/YarnLot");
const Elastic          = require("../models/Elastic");
const { nextNumber }   = require("../utils/sequence");
const { drawFromLot, returnToLot } = require("../services/yarnLotService");
const { buildBeamsFromTemplates } = require("../services/warpingTemplate");
const { plannedLotsForJob, distinctLots } = require("../services/yarnLotTrail");
const { checkWarpingIssued } = require("../services/warpingIssueReadiness");
const ErrorHandler     = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { checkAndAdvanceToWeaving } = require("../utils/jobStatusHelper");
const { buildFingerprint, ACTION_CODES, actorFromRequest, stampFingerprint } = require("../utils/fingerprint");
const { requireReason } = require("../utils/auditReason");
const { assertVersion } = require("../utils/versioning");
const { isAuthenticated, isAdmin, requireFeature, requireFeatureRead } = require("../middleware/auth");

// All warping routes require login. Workers in the `warping` department
// need to read /list, /detail, /warpingPlan and /plan-context to monitor
// their assigned jobs in the employee app. Mutations stay admin-only.
router.use(isAuthenticated);
// Per-user feature gate: warping serves both the Warping and Covering
// screens, so either feature grants access — reads included. No-op for
// users without an explicit feature list (legacy) — see requireFeature.
router.use(requireFeature('/warping', '/covering'));
router.use(requireFeatureRead('/warping', '/covering'));

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
      select: "name warpingPlanTemplate",
    });

    // Every elastic on the job contributes its beams, not just the first
    // one — a mixed job was previously planned as if it carried a single
    // product, and the rest of its beams were simply absent.
    const { beams, sources } = buildBeamsFromTemplates(jobFull?.elastics || []);

    if (beams.length > 0) {
      const from = sources.map((s) => s.elasticName).join(", ");
      autoPlan = await WarpingPlan.create({
        warping:   warping._id,
        job:       jobId,
        noOfBeams: beams.length,
        beams,
        remarks:   `Auto-created from the warping template of ${from}`,
      });
      warping.warpingPlan = autoPlan._id;
      await warping.save();
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
      populate: [
        { path: "beams.sections.warpYarn", select: "name category" },
        { path: "beams.elastic", select: "name" },
        { path: "beams.sections.yarnLot", select: "lotNo shade status" },
      ],
    });

  if (!warping) return next(new ErrorHandler("Warping not found", 404));

  // The lots this programme commits to, folded per (elastic, lot). The
  // beams below already carry them section by section; this is the same
  // fact at the size a person can read — and it names how many sections
  // are still open, which the beam list can only be counted for.
  const lotTrail = await plannedLotsForJob(warping.job?._id || warping.job);

  res.json({
    success: true,
    warping,
    yarnLots: {
      planned: lotTrail.entries,
      lots: distinctLots(lotTrail.entries),
      sections: lotTrail.sections,
      openBeamNos: lotTrail.openBeamNos,
    },
  });
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

  // An override, not a loophole. Warpings already in flight when this
  // rule arrived have beams on the floor and no issued batch behind
  // them, and refusing those forever would strand real work. It needs a
  // reason and it is recorded on the fingerprint, so a completion that
  // skipped the check is visible afterwards rather than indistinguishable
  // from one that passed it.
  const force = req.body?.force === true;
  const forceReason = String(req.body?.forceReason || "").trim();
  if (force && forceReason.length < 5) {
    return next(new ErrorHandler(
      "Completing without an issued batch needs a reason (min 5 chars).", 400
    ));
  }

  const session = await mongoose.startSession();
  try {
    let resp;
    await session.withTransaction(async () => {
      const warping = await Warping.findById(id).session(session);
      if (!warping) throw new ErrorHandler("Warping not found", 404);
      if (warping.status !== "in_progress")
        throw new ErrorHandler("Warping is not in progress", 400);

      // ── The yarn has to have left the rack ────────────────────────
      // Completing says the beams are built, and beams are built from
      // yarn that was issued against a warping batch. That issue is what
      // moves the lot balances and what ties the beam to the dye lot
      // inside it. Completing without it leaves the lot ledger claiming
      // yarn that is physically gone and the beam with no lot behind it
      // — a hole in the shade trail exactly where it exists to cover.
      //
      // Only bites where the programme actually named lots; see
      // services/warpingIssueReadiness.js for why.
      const issued = await checkWarpingIssued(warping._id, session);
      if (!issued.ready && !force) {
        const err = new ErrorHandler(
          `Warping cannot be completed yet — ${issued.reason}.`,
          409
        );
        err.code = "WARPING_YARN_NOT_ISSUED";
        err.details = {
          lotsPlanned: issued.lotsPlanned,
          batches: issued.batches,
          reason: issued.reason,
        };
        throw err;
      }

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
          // Both recorded, so a forced completion can be told from one
          // that met the rule.
          yarnIssued:    issued.batches.issued,
          ...(force && !issued.ready
            ? { forcedWithoutIssue: true, forceReason }
            : {}),
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
    .populate("beams.sections.warpYarn", "name category")
    .populate("beams.elastic", "name")
    .populate("beams.sections.yarnLot", "lotNo shade status receivedQty consumedQty");

  if (!plan) return res.json({ exists: false });
  res.json({ exists: true, plan });
}));

/**
 * Validate the dye lot named on each beam section and stamp the lot
 * number onto it.
 *
 * The snapshot matters more than it looks: the programme sheet is the
 * copy that goes to the machine and gets filed, and it has to still read
 * correctly when someone digs it out two years later — by which time the
 * lot may be archived, or renumbered, or long gone.
 *
 * A lot belonging to a different yarn is refused rather than quietly
 * dropped. That mismatch means the picker was filtered on one yarn and
 * submitted against another, and it would ruin the trace silently.
 */
async function resolveSectionLots(beams) {
  const lotIds = [];
  for (const beam of beams || []) {
    for (const s of beam.sections || []) {
      if (s.yarnLot) {
        if (!mongoose.Types.ObjectId.isValid(s.yarnLot)) {
          throw new ErrorHandler("Invalid yarn lot id on a beam section", 400);
        }
        lotIds.push(s.yarnLot);
      }
    }
  }

  // Running without a nominated lot is normal and allowed — an undyed or
  // untracked yarn has none, and a plan may be programmed before the lot
  // is decided. But a form sends an unfilled picker as "", which is not
  // an ObjectId: returning the beams untouched here (as this did when NO
  // section had a lot) let those empty strings reach the model and fail
  // to cast, so a whole plan was rejected for the one thing that is
  // meant to be optional. Normalise first, always.
  const blankLots = (bs) =>
    (bs || []).map((beam) => ({
      ...beam,
      sections: (beam.sections || []).map((s) => ({
        ...s, yarnLot: null, lotNo: "", shade: "",
      })),
    }));

  if (lotIds.length === 0) return blankLots(beams);

  const lots = await YarnLot.find({ _id: { $in: lotIds } });
  const byId = new Map(lots.map((l) => [String(l._id), l]));

  return (beams || []).map((beam) => ({
    ...beam,
    sections: (beam.sections || []).map((s) => {
      if (!s.yarnLot) return { ...s, yarnLot: null, lotNo: "", shade: "" };
      const lot = byId.get(String(s.yarnLot));
      if (!lot) throw new ErrorHandler("Yarn lot not found", 404);
      if (String(lot.rawMaterial) !== String(s.warpYarn)) {
        throw new ErrorHandler(
          `Lot ${lot.lotNo} does not belong to the yarn on that section`, 400
        );
      }
      // A quarantined lot must not reach the machine. Programming is
      // exactly where to catch that — before the beam is built.
      if (lot.status === "quarantined") {
        throw new ErrorHandler(`Lot ${lot.lotNo} is quarantined and cannot be programmed`, 409);
      }
      return { ...s, yarnLot: lot._id, lotNo: lot.lotNo, shade: lot.shade || "" };
    }),
  }));
}

router.post("/warpingPlan/create", isAdmin('admin', 'production'), catchAsyncErrors(async (req, res, next) => {
  const { warpingId, beams, remarks } = req.body;
  if (!warpingId)     return next(new ErrorHandler("warpingId is required", 400));
  if (!beams?.length) return next(new ErrorHandler("At least one beam is required", 400));

  const warping = await Warping.findById(warpingId);
  if (!warping)            return next(new ErrorHandler("Warping not found", 404));
  if (warping.warpingPlan) return next(new ErrorHandler("Warping plan already exists", 400));

  let resolvedBeams;
  try {
    resolvedBeams = await resolveSectionLots(beams);
  } catch (err) {
    return next(err);
  }

  // A beam may name the elastic it is warping — the form carries it
  // through when the plan was filled from a template, so a hand-saved
  // plan keeps the same attribution an auto-created one gets. Only the
  // job's own elastics are accepted; anything else is dropped rather
  // than stored, since it would be a claim nobody could act on.
  const jobDoc = await JobOrder.findById(warping.job).select("elastics.elastic").lean();
  const jobElastics = new Set(
    (jobDoc?.elastics || []).map((e) => String(e.elastic)).filter(Boolean)
  );
  const tapeOf = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  resolvedBeams = resolvedBeams.map((b) => ({
    ...b,
    elastic: b.elastic && jobElastics.has(String(b.elastic)) ? b.elastic : null,
    tapeNo: tapeOf(b.tapeNo),
  }));

  const plan = await WarpingPlan.create({
    warping:   warping._id,
    job:       warping.job,
    noOfBeams: beams.length,
    beams:     resolvedBeams,
    remarks:   remarks || "",
  });

  warping.warpingPlan = plan._id;
  await warping.save();

  const populated = await WarpingPlan.findById(plan._id)
    .populate("job", "jobOrderNo status")
    .populate("beams.sections.warpYarn", "name category")
    .populate("beams.elastic", "name")
    .populate("beams.sections.yarnLot", "lotNo shade status receivedQty consumedQty");

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
  if (Array.isArray(beams) && beams.length > 0) {
    try {
      plan.beams = await resolveSectionLots(beams);
    } catch (err) {
      return next(err);
    }
    plan.noOfBeams = beams.length;
  }
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
    .populate("beams.sections.warpYarn", "name category")
    .populate("beams.elastic", "name")
    .populate("beams.sections.yarnLot", "lotNo shade status receivedQty consumedQty");
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

  // The beams a plan would be built with, merged across every elastic on
  // the job exactly as auto-creation does. `prefillTemplate` above is the
  // first elastic only; a form filled from that would disagree with the
  // plan the same job gets when the warping raises one by itself, which
  // is the sort of difference nobody notices until the floor does.
  const merged = buildBeamsFromTemplates(job.elastics || []);
  const elasticNameById = new Map(
    (job.elastics || [])
      .filter((e) => e.elastic)
      .map((e) => [String(e.elastic._id), e.elastic.name || "Elastic"])
  );
  const templateBeams = merged.beams.map((b) => ({
    beamNo:      b.beamNo,
    totalEnds:   b.totalEnds,
    elasticId:   b.elastic ? String(b.elastic) : null,
    elasticName: b.elastic ? (elasticNameById.get(String(b.elastic)) || "") : "",
    sections:    b.sections.map((s) => {
      const id = s.warpYarn && typeof s.warpYarn === "object"
        ? String(s.warpYarn._id)
        : String(s.warpYarn);
      return {
        warpYarnId: id,
        // The template's section is populated here, so its own name is
        // the reliable one; warpMap only covers yarns listed on the
        // elastic, and a template may name one that is not.
        warpYarnName:
          (s.warpYarn && typeof s.warpYarn === "object" ? s.warpYarn.name : null)
          ?? warpMap.get(id)?.name
          ?? "",
        ends:      s.ends,
        maxMeters: s.maxMeters ?? 0,
      };
    }),
  }));

  // ── Lot-wise stock for each warp yarn ──────────────────────────────
  // Programming a beam is where the lot decision is actually made: a beam
  // wants to come off one lot, so the planner needs to see whether any
  // single lot can carry it before committing the section. Aggregate
  // stock cannot answer that — 300 kg spread over six lots of 50 is a
  // very different thing from 300 kg on one.
  const yarnIds = Array.from(warpMap.keys());
  const openLots = yarnIds.length
    ? await YarnLot.find({
        rawMaterial: { $in: yarnIds },
        status: "open",
        $expr: { $gt: [{ $subtract: ["$receivedQty", "$consumedQty"] }, 0] },
      }).sort({ receivedDate: -1 })
    : [];

  const lotsByYarn = new Map(yarnIds.map((id) => [id, []]));
  for (const lot of openLots) {
    lotsByYarn.get(String(lot.rawMaterial))?.push({
      id: String(lot._id),
      lotNo: lot.lotNo,
      shade: lot.shade || "",
      balance: lot.balance,
    });
  }

  const lotStock = yarnIds.map((id) => {
    const lots = lotsByYarn.get(id) || [];
    return {
      warpYarnId: id,
      warpYarnName: warpMap.get(id)?.name || "",
      lots,
      // The two numbers a planner weighs against each other.
      totalAvailable: lots.reduce((s, l) => s + l.balance, 0),
      largestLot: lots.reduce((m, l) => Math.max(m, l.balance), 0),
    };
  });

  res.json({
    success:          true,
    jobId:            job._id,
    warpYarns:        Array.from(warpMap.values()),
    prefillTemplate,
    elasticTemplates,
    templateBeams,
    lotStock,
  });
}));

// ═══════════════════════════════════════════════════════════════════════
//  WARPING BATCHES — running a plan from known yarn lots
//
//  A plan says what to build; a batch records which lots were actually
//  drawn to build it, and when. One plan is routinely run over several
//  sittings from different lots, which is exactly what makes the lot
//  worth recording.
//
//  Issuing a batch moves lot balances and deliberately leaves
//  RawMaterial.stock alone — that was already debited at order approval.
//  See models/YarnLot.js.
// ═══════════════════════════════════════════════════════════════════════

/** Beam numbers the plan actually defines, for validating a batch. */
function planBeamNumbers(plan) {
  return new Set(
    (plan?.beams || [])
      .map((b) => Number(b.beamNo))
      .filter((n) => Number.isFinite(n))
  );
}

/**
 * Normalise and check the allocations on a create/update.
 * Returns [{ rawMaterial, yarnLot, quantity }] or throws.
 */
function parseAllocations(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ErrorHandler("At least one lot allocation is required", 400);
  }
  const seen = new Set();
  return raw.map((a, i) => {
    const at = `Allocation ${i + 1}`;
    if (!mongoose.Types.ObjectId.isValid(a?.rawMaterial)) {
      throw new ErrorHandler(`${at}: a valid rawMaterial is required`, 400);
    }
    if (!mongoose.Types.ObjectId.isValid(a?.yarnLot)) {
      throw new ErrorHandler(`${at}: a valid yarnLot is required`, 400);
    }
    const quantity = Number(a.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ErrorHandler(`${at}: quantity must be greater than zero`, 400);
    }
    // The same lot twice in one batch would draw it down twice for a
    // single physical issue. Merging silently would hide a keying slip,
    // so say so and let the operator decide which line is right.
    const key = String(a.yarnLot);
    if (seen.has(key)) {
      throw new ErrorHandler(
        `${at}: this lot is already allocated to the batch — combine the two lines`,
        400
      );
    }
    seen.add(key);
    return { rawMaterial: a.rawMaterial, yarnLot: a.yarnLot, quantity };
  });
}

/** Snapshot lot + material names onto the allocations, for the record. */
async function decorateAllocations(allocations, session) {
  const lotIds = allocations.map((a) => a.yarnLot);
  const q = YarnLot.find({ _id: { $in: lotIds } }).populate("rawMaterial", "name");
  if (session) q.session(session);
  const lots = await q;
  const byId = new Map(lots.map((l) => [String(l._id), l]));

  return allocations.map((a) => {
    const lot = byId.get(String(a.yarnLot));
    if (!lot) throw new ErrorHandler("Yarn lot not found", 404);
    // A lot belonging to a different material means the picker was
    // filtered on one material and submitted against another — the kind
    // of mismatch that silently ruins a trace months later.
    if (String(lot.rawMaterial?._id || lot.rawMaterial) !== String(a.rawMaterial)) {
      throw new ErrorHandler(
        `Lot ${lot.lotNo} does not belong to the selected material`,
        400
      );
    }
    return {
      ...a,
      lotNo: lot.lotNo,
      shade: lot.shade || "",
      materialName: lot.rawMaterial?.name || "",
    };
  });
}

// ── POST /warping/batch/create ────────────────────────────────
router.post("/batch/create", isAdmin("admin", "production"), catchAsyncErrors(async (req, res, next) => {
  const { warpingId, beamNos, allocations, remarks, machine, elastics } = req.body;

  if (!mongoose.Types.ObjectId.isValid(warpingId)) {
    return next(new ErrorHandler("A valid warpingId is required", 400));
  }
  if (machine && !mongoose.Types.ObjectId.isValid(machine)) {
    return next(new ErrorHandler("Invalid machine id", 400));
  }

  const warping = await Warping.findById(warpingId);
  if (!warping) return next(new ErrorHandler("Warping not found", 404));
  // Only a warping that is still running can take a batch. Against a
  // completed one the beams are already off the machine, so a draw
  // recorded here never physically happened.
  if (warping.status !== "open" && warping.status !== "in_progress") {
    return next(new ErrorHandler(
      `Warping is ${warping.status} — no further batches can be raised against it`, 400
    ));
  }

  const plan = await WarpingPlan.findOne({ warping: warping._id });
  if (!plan) {
    return next(new ErrorHandler("Create a warping plan before batching", 400));
  }

  const beams = Array.isArray(beamNos) ? beamNos.map(Number).filter(Number.isFinite) : [];
  const known = planBeamNumbers(plan);
  const unknown = beams.filter((n) => !known.has(n));
  if (unknown.length) {
    return next(new ErrorHandler(
      `Beam ${unknown.join(", ")} is not in this warping plan`, 400
    ));
  }

  let parsed;
  try {
    parsed = await decorateAllocations(parseAllocations(allocations));
  } catch (err) {
    return next(err);
  }

  // A beam already covered by a live batch must not be claimed again.
  // Two batches on one beam means the yarn is issued twice for it, and
  // the trail then shows two lots inside a single beam — precisely the
  // thing lot tracking exists to rule out. A cancelled batch drew
  // nothing in the end, so it releases its beams.
  if (beams.length) {
    const live = await WarpingBatch.find({
      warping: warping._id,
      status: { $ne: "cancelled" },
    }).select("batchNo beamNos").lean();
    const taken = new Map();
    for (const b of live) {
      for (const n of b.beamNos || []) taken.set(Number(n), b.batchNo);
    }
    const clash = beams.filter((n) => taken.has(n));
    if (clash.length) {
      return next(new ErrorHandler(
        `Beam ${clash.join(", ")} is already on batch ` +
        `${[...new Set(clash.map((n) => taken.get(n)))].join(", ")}`,
        409
      ));
    }
  }

  // The programme already named a lot for some sections. Drawing a
  // different one leaves the sheet the warper actually followed and the
  // trail telling different stories, and the sheet is the one that was
  // acted on. Sections programmed without a lot constrain nothing.
  const mismatch = [];
  for (const beam of plan.beams || []) {
    if (!beams.includes(Number(beam.beamNo))) continue;
    for (const sec of beam.sections || []) {
      if (!sec.yarnLot) continue;
      const line = parsed.find(
        (a) => String(a.rawMaterial) === String(sec.warpYarn)
      );
      if (line && String(line.yarnLot) !== String(sec.yarnLot)) {
        mismatch.push(
          `beam ${beam.beamNo} is programmed to run off lot ${sec.lotNo || sec.yarnLot}, ` +
          `not ${line.lotNo}`
        );
      }
    }
  }
  if (mismatch.length) {
    return next(new ErrorHandler(
      `${mismatch.join("; ")}. Change the programme, or draw the lot it names.`,
      400
    ));
  }

  // Which elastic is this batch warping for? Answering it is what turns
  // "this lot went into job 812" into "this lot is in this roll".
  const job = await JobOrder.findById(warping.job).select("elastics").lean();
  const jobElastics = (job?.elastics || [])
    .map((e) => String(e.elastic))
    .filter(Boolean);

  let forElastics = [];
  if (Array.isArray(elastics) && elastics.length) {
    const bad = elastics.filter((e) => !mongoose.Types.ObjectId.isValid(e));
    if (bad.length) return next(new ErrorHandler("Invalid elastic id", 400));
    const foreign = elastics.filter((e) => !jobElastics.includes(String(e)));
    if (foreign.length) {
      return next(new ErrorHandler(
        "An elastic on this batch is not on the job", 400
      ));
    }
    forElastics = elastics;
  } else if (jobElastics.length === 1) {
    // Unambiguous — no point making someone tick the only box there is.
    forElastics = jobElastics;
  }

  const seq = await nextNumber("warpingBatchNo", async () => {
    // Seed from the highest existing number so batches created before
    // the counter existed are not re-issued.
    //
    // Parsed, not sorted: `batchNo` is a string, so "WB-9999" sorts above
    // "WB-10000" and a descending sort would seed the counter BACKWARDS
    // once the numbers pass four digits — handing out a number already
    // taken. This runs once, on first allocation, so the scan is cheap.
    const rows = await WarpingBatch.find({ batchNo: /^WB-\d+$/ })
      .select("batchNo").lean();
    return rows.reduce(
      (max, r) => Math.max(max, Number(String(r.batchNo).slice(3)) || 0), 0
    );
  });

  const batch = await WarpingBatch.create({
    batchNo: `WB-${String(seq).padStart(4, "0")}`,
    warping: warping._id,
    job: warping.job,
    beamNos: beams,
    elastics: forElastics,
    allocations: parsed,
    machine: machine || undefined,
    remarks: remarks ? String(remarks).trim() : "",
    createdBy: req.user?._id,
  });

  res.status(201).json({ success: true, batch });
}));

// ── POST /warping/batch/:id/issue ─────────────────────────────
// Draw the allocated yarn off the rack. Every lot moves or none does.
router.post("/batch/:id/issue", isAdmin("admin", "production"), catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new ErrorHandler("Invalid batch id", 400));
  }

  const session = await mongoose.startSession();
  try {
    let batch;
    await session.withTransaction(async () => {
      // The status guard is part of the claim, not a separate read: two
      // clicks on Issue would otherwise both see "planned" and both draw
      // the lots down. The loser matches nothing and is told why.
      const claimed = await WarpingBatch.findOneAndUpdate(
        { _id: req.params.id, status: "planned" },
        { $set: { status: "issued", issuedDate: new Date() } },
        { new: true, session }
      );
      if (!claimed) {
        const exists = await WarpingBatch.findById(req.params.id).session(session);
        if (!exists) throw new ErrorHandler("Batch not found", 404);
        throw new ErrorHandler(`Batch ${exists.batchNo} is already ${exists.status}`, 409);
      }

      // Re-checked here, not just at create: a warping can be cancelled or
      // completed in the gap between planning a batch and issuing it, and
      // drawing yarn against beams that are off the machine records a
      // movement that never happened. Inside the transaction, so the lot
      // draws below roll back with it.
      const live = await Warping.findById(claimed.warping)
        .select("status").session(session);
      if (!live || (live.status !== "open" && live.status !== "in_progress")) {
        throw new ErrorHandler(
          `Warping is ${live ? live.status : "missing"} — batch ${claimed.batchNo} cannot be issued`,
          409
        );
      }

      for (const a of claimed.allocations) {
        // Name the batch on the lot's own ledger, so a lot can say where
        // its yarn went rather than only how much of it is left.
        await drawFromLot(a.yarnLot, a.quantity, session, {
          warpingBatch: claimed._id, refNo: claimed.batchNo,
        });
      }
      batch = claimed;
    });

    const fp = buildFingerprint(ACTION_CODES.WARPING_STARTED, {
      entityId: batch.job,
      actor: actorFromRequest(req),
      meta: {
        batchNo: batch.batchNo,
        beamNos: batch.beamNos,
        lots: batch.allocations.map((a) => `${a.lotNo} (${a.quantity})`),
      },
    });
    // Best-effort: the yarn has moved either way, and losing the audit
    // line is not worth failing the issue and stranding the lot draws.
    try {
      await JobOrder.updateOne({ _id: batch.job }, { $push: { fingerprints: fp } });
    } catch (fpErr) {
      console.warn("Batch issue fingerprint failed:", fpErr.message);
    }

    res.json({ success: true, batch, fingerprint: fp });
  } catch (err) {
    return next(err);
  } finally {
    session.endSession();
  }
}));

// ── POST /warping/batch/:id/complete ──────────────────────────
router.post("/batch/:id/complete", isAdmin("admin", "production"), catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new ErrorHandler("Invalid batch id", 400));
  }
  const batch = await WarpingBatch.findOneAndUpdate(
    { _id: req.params.id, status: "issued" },
    { $set: { status: "completed", completedDate: new Date() } },
    { new: true }
  );
  if (!batch) {
    const exists = await WarpingBatch.findById(req.params.id);
    if (!exists) return next(new ErrorHandler("Batch not found", 404));
    return next(new ErrorHandler(
      `Only an issued batch can be completed — ${exists.batchNo} is ${exists.status}`, 409
    ));
  }
  res.json({ success: true, batch });
}));

// ── PATCH /warping/batch/:id/cancel ───────────────────────────
// Cancelling a batch that was issued puts the yarn back on the rack.
// A completed batch is history and cannot be cancelled — the beams exist.
router.patch("/batch/:id/cancel", isAdmin("admin", "production"), catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new ErrorHandler("Invalid batch id", 400));
  }

  const session = await mongoose.startSession();
  try {
    let batch;
    await session.withTransaction(async () => {
      const claimed = await WarpingBatch.findOneAndUpdate(
        { _id: req.params.id, status: { $in: ["planned", "issued"] } },
        { $set: { status: "cancelled" } },
        { new: true, session }
      );
      if (!claimed) {
        const exists = await WarpingBatch.findById(req.params.id).session(session);
        if (!exists) throw new ErrorHandler("Batch not found", 404);
        throw new ErrorHandler(
          `Batch ${exists.batchNo} is ${exists.status} and cannot be cancelled`, 409
        );
      }
      // `status` has already been overwritten with "cancelled", so it can
      // no longer say whether the yarn ever left the rack. `issuedDate`
      // survives the update untouched and answers that instead.
      if (claimed.issuedDate) {
        for (const a of claimed.allocations) {
          await returnToLot(a.yarnLot, a.quantity, session, {
            warpingBatch: claimed._id, refNo: claimed.batchNo,
            reason: 'batch cancelled',
          });
        }
      }
      batch = claimed;
    });
    res.json({ success: true, batch });
  } catch (err) {
    return next(err);
  } finally {
    session.endSession();
  }
}));

// ── GET /warping/batch/list?warpingId= | ?jobId= ──────────────
router.get("/batch/list", catchAsyncErrors(async (req, res, next) => {
  const { warpingId, jobId, status } = req.query;
  const filter = {};
  if (warpingId) {
    if (!mongoose.Types.ObjectId.isValid(warpingId)) {
      return next(new ErrorHandler("Invalid warpingId", 400));
    }
    filter.warping = warpingId;
  }
  if (jobId) {
    if (!mongoose.Types.ObjectId.isValid(jobId)) {
      return next(new ErrorHandler("Invalid jobId", 400));
    }
    filter.job = jobId;
  }
  if (status && status !== "all") filter.status = status;

  const batches = await WarpingBatch.find(filter)
    .populate("job", "jobOrderNo status")
    .populate("elastics", "name")
    .populate("machine", "ID")
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ success: true, batches });
}));

// ── GET /warping/batch/:id ────────────────────────────────────
router.get("/batch/:id", catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return next(new ErrorHandler("Invalid batch id", 400));
  }
  const batch = await WarpingBatch.findById(req.params.id)
    .populate("job", "jobOrderNo status")
    .populate("elastics", "name")
    .populate("machine", "ID")
    .populate("allocations.yarnLot", "lotNo shade status receivedQty consumedQty");
  if (!batch) return next(new ErrorHandler("Batch not found", 404));
  res.json({ success: true, batch });
}));

module.exports = router;
