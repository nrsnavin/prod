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
const { isAuthenticated, isAdmin, requireFeature, requireFeatureRead } = require("../middleware/auth");

// All covering routes require login. Workers in the `covering` (and
// `warping`) departments need to read /list and /detail to monitor
// their jobs; covering operators also POST /beam-entry to record their
// own work. Mutations stay admin-only.
router.use(isAuthenticated);
// Per-user feature gate: the Covering data backs both the Warping and
// Covering screens, so either feature grants access — reads included.
router.use(requireFeature('/warping', '/covering'));
router.use(requireFeatureRead('/warping', '/covering'));

/**
 * The heaviest a single warp beam can plausibly be, in kg.
 *
 * Beam weights are keyed by hand off a floor scale, and producedWeight
 * is a running sum, so a slipped decimal is invisible the moment it
 * lands — there is no second figure anywhere to disagree with it.
 */
const BEAM_WEIGHT_MAX_KG = 2000;

router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
    const { status = "open", search = "" } = req.query;

    // Clamped. `page=0` produced a negative skip, which Mongo rejects
    // outright — the listing 500'd on a query string a paginator can
    // easily send while the user is still on the first page.
    const page  = Math.max(Number(req.query.page)  || 1,  1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const skip  = (page - 1) * limit;

    // "all" (the default tab in the web UI) means no status filter; any
    // other value must be a real status. Mirrors api/warping.js so the two
    // sibling list endpoints behave the same.
    const validStatuses = ["open", "in_progress", "completed", "cancelled"];
    const filter = {};
    if (status && status !== "all") {
      if (!validStatuses.includes(status)) {
        return next(new ErrorHandler(`Invalid status: ${status}`, 400));
      }
      filter.status = status;
    }

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
        .populate({ path: "elasticPlanned.elastic", select: "name" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Covering.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: { total, page, limit, hasMore: skip + data.length < total },
    });
  })
);

router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Covering ID is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid covering id", 400));
    }

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
  isAdmin('admin', 'production'),
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
  isAdmin('admin', 'production'),
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
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid covering id", 400));
    }

    const session = await mongoose.startSession();
    try {
      let covering;
      await session.withTransaction(async () => {
        covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status === "completed") {
          throw new ErrorHandler("Completed covering cannot be cancelled", 400);
        }
        // Cancelling an already-cancelled covering used to succeed and
        // stamp nothing, so the trail showed one cancellation for any
        // number of clicks — and said nothing about which one landed.
        if (covering.status === "cancelled") {
          throw new ErrorHandler("Covering is already cancelled", 400);
        }

        const previous = covering.status;
        covering.status = "cancelled";
        if (remarks?.trim()) covering.remarks = remarks.trim();
        await covering.save({ session });

        // Cancelling is the one covering transition that left no mark.
        // Start, complete and every beam entry write to the job's
        // timeline; the transition that stops the job advancing to
        // weaving — the one someone will come asking about — did not.
        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(buildFingerprint(ACTION_CODES.COVERING_CANCELLED, {
            entityId: covering.job,
            actor:    actorFromRequest(req),
            meta: {
              coveringId: covering._id.toString(),
              previousStatus: previous,
              remarks: remarks?.trim() || undefined,
            },
          }));
          await job.save({ session });
        }
      });
      res.status(200).json({ success: true, covering });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// Operators in the covering department record their own beam weights.
router.post(
  "/beam-entry",
  catchAsyncErrors(async (req, res, next) => {
    const { id, beamNo, weight, note = "" } = req.body;

    if (!id)     return next(new ErrorHandler("Covering ID required", 400));
    if (!beamNo) return next(new ErrorHandler("beamNo is required", 400));
    // Beams are counted, so the number has to be one. Unchecked it went
    // to the model as NaN and came back as a cast error — a 500 for a
    // mistyped field.
    const beam = Number(beamNo);
    if (!Number.isInteger(beam) || beam <= 0) {
      return next(new ErrorHandler("beamNo must be a positive whole number", 400));
    }

    const w = Number(weight);
    if (isNaN(w) || w <= 0) {
      return next(new ErrorHandler("weight must be a positive number (kg)", 400));
    }
    // A warp beam this size does not exist. The cap is the same idea as
    // the metre cap on a packing record: the figure is keyed by hand at
    // a scale, and a slipped decimal otherwise lands in producedWeight
    // with nothing downstream to catch it.
    if (w > BEAM_WEIGHT_MAX_KG) {
      return next(new ErrorHandler(
        `weight ${w} kg exceeds ${BEAM_WEIGHT_MAX_KG} kg for a single beam`, 400));
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

        // One beam, one weight. The same beam logged twice doubles
        // producedWeight for yarn that was covered once, and nothing
        // downstream can tell the pair apart from two real beams — the
        // number is a sum, so the duplicate simply disappears into it.
        // Correcting a weight means deleting the entry and re-adding it.
        const already = covering.beamEntries.find((e) => Number(e.beamNo) === beam);
        if (already) {
          throw new ErrorHandler(
            `Beam ${beam} is already recorded at ${already.weight} kg — ` +
            `delete that entry first if the weight was wrong`,
            409
          );
        }

        covering.beamEntries.push({
          beamNo:    beam,
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
            beamNo:         beam,
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
          `[covering/beam-entry] Covering ${id}: beam ${beam} = ${w} kg ` +
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
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { coveringId, entryId } = req.query;

    if (!coveringId) return next(new ErrorHandler("coveringId is required", 400));
    if (!entryId)    return next(new ErrorHandler("entryId is required", 400));
    // Unchecked, these reached the query as raw strings and Mongo threw
    // a cast error — a 500 for what is plainly a bad request.
    if (!mongoose.Types.ObjectId.isValid(coveringId)) {
      return next(new ErrorHandler("Invalid coveringId", 400));
    }
    if (!mongoose.Types.ObjectId.isValid(entryId)) {
      return next(new ErrorHandler("Invalid entryId", 400));
    }

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
        // `{ new: false }` — the PRE-pull document. The post-pull doc
        // cannot answer whether the entry was ever there: $pull removes
        // it when it matches and leaves the array alone when it doesn't,
        // and in both cases the entry is absent afterwards. The old
        // post-check looked for the entry in the post-pull array, which
        // is empty of it by construction, so its 404 could never fire
        // and deleting a beam entry that did not exist reported success
        // — with a recomputed weight, as if something had happened.
        const before = await Covering.findOneAndUpdate(
          { _id: coveringId, status: { $nin: ["completed", "cancelled"] } },
          { $pull: { beamEntries: { _id: entryId } } },
          { new: false, session }
        );
        if (!before) {
          throw new ErrorHandler(
            "Covering changed status before delete could apply", 409
          );
        }
        const existed = (before.beamEntries || []).some(
          (e) => e._id?.toString() === String(entryId)
        );
        if (!existed) {
          throw new ErrorHandler("Beam entry not found", 404);
        }

        const updated = await Covering.findById(coveringId).session(session);
        if (!updated) throw new ErrorHandler("Covering not found", 404);

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
