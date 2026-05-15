"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const Covering          = require("../models/Covering");
const JobOrder          = require("../models/JobOrder");
const Order             = require("../models/Order");
const Elastic           = require("../models/Elastic");   // keeps model in registry for nested populate
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { checkAndAdvanceToWeaving } = require("../utils/jobStatusHelper");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");

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

// ═════════════════════════════════════════════════════════════
//  COVERING DETAIL
//  Populates beamEntries.enteredBy.name so the admin app can print
//  the operator on each beam label.
// ═════════════════════════════════════════════════════════════
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

        const { advanced, jobStatus } = await checkAndAdvanceToWeaving(covering.job);

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

// ═════════════════════════════════════════════════════════════
//  ADD BEAM ENTRY
//  Stores enteredBy = req.user._id so the printed beam label can
//  show the operator's name. Returns the new entry with enteredBy
//  populated so the admin app doesn't need a second round-trip.
// ═════════════════════════════════════════════════════════════
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
          // Server-trusted operator from the auth gate. Admins printing
          // the label want to see who actually weighed the beam.
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

        // Hydrate the new entry's enteredBy so the response carries
        // the operator name without a second round-trip.
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
  catchAsyncErrors(async (req, res, next) => {
    const { coveringId, entryId } = req.query;

    if (!coveringId) return next(new ErrorHandler("coveringId is required", 400));
    if (!entryId)    return next(new ErrorHandler("entryId is required", 400));

    const covering = await Covering.findById(coveringId);
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    if (covering.status === "completed" || covering.status === "cancelled") {
      return next(
        new ErrorHandler(
          `Cannot remove beam entry from a ${covering.status} covering`, 400
        )
      );
    }

    const before = covering.beamEntries.length;
    covering.beamEntries = covering.beamEntries.filter(
      (e) => e._id.toString() !== entryId
    );

    if (covering.beamEntries.length === before) {
      return next(new ErrorHandler("Beam entry not found", 404));
    }

    covering.producedWeight = covering.beamEntries.reduce(
      (sum, e) => sum + e.weight,
      0
    );

    await covering.save();

    res.status(200).json({
      success:        true,
      producedWeight: covering.producedWeight,
      totalBeams:     covering.beamEntries.length,
    });
  })
);

module.exports = router;
