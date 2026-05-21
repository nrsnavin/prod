"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const Covering          = require("../models/Covering");
const JobOrder          = require("../models/JobOrder");
const Order             = require("../models/Order");
const Elastic           = require("../models/Elastic");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { checkAndAdvanceToWeaving } = require("../utils/jobStatusHelper");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

// All covering routes require login. Workers in the `covering` (and
// `warping`) departments need to read /list and /detail to monitor
// their jobs; covering operators also POST /beam-entry to record their
// own work. Mutations stay admin-only.
router.use(isAuthenticated);

router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
    const {
      status = "open",
      search = "",
      page   = 1,
      limit  = 20,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const validStatuses = ["open", "in_progress", "completed", "cancelled"];
    if (!validStatuses.includes(status)) {
      return next(new ErrorHandler(`Invalid status: ${status}`, 400));
    }

    let filter = { status };

    if (search && search.trim()) {
      const jobNo = parseInt(search.trim(), 10);
      if (!isNaN(jobNo)) {
        const matchedJobs = await JobOrder.find({ jobOrderNo: jobNo }).select("_id");
        filter.job = { $in: matchedJobs.map((j) => j._id) };
      }
    }

    const [data, total] = await Promise.all([
      Covering.find(filter)
        .populate({
          path:   "job",
          select: "jobOrderNo status customer",
          populate: { path: "customer", select: "name" },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Covering.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page:    Number(page),
        limit:   Number(limit),
        hasMore: skip + data.length < total,
      },
    });
  })
);

router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Covering ID is required", 400));

    const covering = await Covering.findById(id)
      .populate({
        path: "job",
        populate: [
          { path: "customer", select: "name" },
          { path: "order",    select: "orderNo po status" },
        ],
      })
      .populate({
        path: "elasticPlanned.elastic",
        populate: [
          { path: "warpSpandex.id",    model: "RawMaterial", select: "name category" },
          { path: "spandexCovering.id", model: "RawMaterial", select: "name category" },
        ],
      })
      .populate({
        path:   "beamEntries.enteredBy",
        select: "name role",
      })
      .lean();

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    res.status(200).json({ success: true, covering });
  })
);

router.post(
  "/start",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status !== "open") {
          throw new ErrorHandler(
            `Only OPEN covering can be started (current: ${covering.status})`, 400
          );
        }

        covering.status = "in_progress";
        await covering.save({ session });

        const fp = buildFingerprint(ACTION_CODES.COVERING_STARTED, {
          entityId: covering.job,
          actor:    actorFromRequest(req),
          meta:     { coveringId: covering._id.toString() },
        });
        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(fp);
          await job.save({ session });
        }

        resp = { covering, fingerprint: fp };
      });
      res.status(200).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.post(
  "/complete",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status !== "in_progress") {
          throw new ErrorHandler(
            `Only IN-PROGRESS covering can be completed (current: ${covering.status})`, 400
          );
        }

        covering.status        = "completed";
        covering.completedDate = new Date();
        if (remarks?.trim()) covering.remarks = remarks.trim();
        await covering.save({ session });

        // FIX: pass the session so the helper sees the just-written
        // covering.status = "completed". Without this, the helper
        // reads the pre-write snapshot and the job never advances.
        const { advanced, jobStatus } = await checkAndAdvanceToWeaving(
          covering.job,
          session
        );

        const actor = actorFromRequest(req);
        const fp = buildFingerprint(ACTION_CODES.COVERING_COMPLETED, {
          entityId: covering.job,
          actor,
          meta: {
            coveringId:    covering._id.toString(),
            completedDate: covering.completedDate,
            jobAdvanced:   advanced,
            jobStatus,
          },
        });

        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(fp);
          await job.save({ session });

          if (job.order) {
            const order = await Order.findById(job.order).session(session);
            if (order) {
              order.fingerprints.push(buildFingerprint(ACTION_CODES.COVERING_COMPLETED, {
                entityId: order._id,
                actor,
                meta: {
                  jobId:          job._id.toString(),
                  jobOrderNo:     job.jobOrderNo,
                  coveringId:     covering._id.toString(),
                  relatedHash:    fp.hash,
                  relatedShortId: fp.shortId,
                },
              }));
              await order.save({ session });
            }
          }
        }

        resp = {
          covering,
          job: { advanced, status: jobStatus },
          fingerprint: fp,
        };
      });
      res.status(200).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.post(
  "/cancel",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const covering = await Covering.findById(id);
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    if (covering.status === "completed") {
      return next(
        new ErrorHandler("Completed covering cannot be cancelled", 400)
      );
    }

    covering.status  = "cancelled";
    if (remarks?.trim()) covering.remarks = remarks.trim();
    await covering.save();

    res.status(200).json({ success: true, covering });
  })
);

// Operators in the covering department record their own beam weights.
router.post(
  "/beam-entry",
  catchAsyncErrors(async (req, res, next) => {
    const { id, beamNo, weight, note = "" } = req.body;

    if (!id)     return next(new ErrorHandler("Covering ID required", 400));
    if (!beamNo) return next(new ErrorHandler("beamNo is required", 400));

    const w = Number(weight);
    if (isNaN(w) || w <= 0) {
      return next(new ErrorHandler("weight must be a positive number (kg)", 400));
    }

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status === "completed" || covering.status === "cancelled") {
          throw new ErrorHandler(
            `Cannot add beam entry to a ${covering.status} covering`, 400
          );
        }

        covering.beamEntries.push({
          beamNo:    Number(beamNo),
          weight:    w,
          note:      note?.trim() || "",
          enteredAt: new Date(),
          enteredBy: req.user?._id || undefined,
        });

        covering.producedWeight = covering.beamEntries.reduce(
          (sum, e) => sum + e.weight,
          0
        );

        await covering.save({ session });

        const fp = buildFingerprint(ACTION_CODES.COVERING_BEAM_ENTRY, {
          entityId: covering.job,
          actor:    actorFromRequest(req),
          meta: {
            coveringId:     covering._id.toString(),
            beamNo:         Number(beamNo),
            weight:         w,
            unit:           'kg',
            producedWeight: covering.producedWeight,
            totalBeams:     covering.beamEntries.length,
            note:           note?.trim() || undefined,
          },
        });
        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(fp);
          await job.save({ session });
        }

        console.log(
          `[covering/beam-entry] Covering ${id}: beam ${beamNo} = ${w} kg ` +
          `| total = ${covering.producedWeight.toFixed(3)} kg`
        );

        const refreshed = await Covering.findById(covering._id)
          .populate({ path: "beamEntries.enteredBy", select: "name role" })
          .session(session)
          .lean();
        const newest = refreshed.beamEntries[refreshed.beamEntries.length - 1];

        resp = {
          beamEntry:      newest,
          producedWeight: covering.producedWeight,
          totalBeams:     covering.beamEntries.length,
          fingerprint:    fp,
        };
      });
      res.status(201).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.delete(
  "/beam-entry",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { coveringId, entryId } = req.query;

    if (!coveringId) return next(new ErrorHandler("coveringId is required", 400));
    if (!entryId)    return next(new ErrorHandler("entryId is required", 400));

    // Status check before opening a session — cheap pre-condition.
    const peek = await Covering.findById(coveringId).select("status").lean();
    if (!peek) return next(new ErrorHandler("Covering not found", 404));
    if (peek.status === "completed" || peek.status === "cancelled") {
      return next(
        new ErrorHandler(
          `Cannot remove beam entry from a ${peek.status} covering`, 400
        )
      );
    }

    // Atomic $pull so two concurrent deletes of different entryIds
    // can't race on a stale in-memory `beamEntries` array. The
    // findOneAndUpdate returns the post-pull doc so we can recompute
    // producedWeight in the same transaction.
    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const updated = await Covering.findOneAndUpdate(
          { _id: coveringId, status: { $nin: ["completed", "cancelled"] } },
          { $pull: { beamEntries: { _id: entryId } } },
          { new: true, session }
        );
        if (!updated) {
          throw new ErrorHandler(
            "Covering changed status before delete could apply", 409
          );
        }
        // $pull returns the post-update doc unchanged when nothing
        // matched; detect missing entry by post-check.
        const stillHasEntry = updated.beamEntries.find(
          (e) => e._id.toString() === entryId
        );
        if (stillHasEntry) {
          throw new ErrorHandler("Beam entry not found", 404);
        }

        updated.producedWeight = updated.beamEntries.reduce(
          (sum, e) => sum + (e.weight || 0),
          0
        );
        await updated.save({ session });

        resp = {
          success:        true,
          producedWeight: updated.producedWeight,
          totalBeams:     updated.beamEntries.length,
        };
      });
      res.status(200).json(resp);
    } catch (err) {
      return next(err);
    } finally {
      await session.endSession();
    }
  })
);

module.exports = router;
