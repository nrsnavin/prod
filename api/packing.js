"use strict";

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const Packing          = require("../models/Packing");
const JobOrder         = require("../models/JobOrder");
const Order            = require("../models/Order");
const Employee         = require("../models/Employee");
const Elastic          = require("../models/Elastic");
const StockMovement    = require("../models/StockMovement");
const { buildFingerprint, ACTION_CODES, actorFromRequest, stampFingerprint } = require("../utils/fingerprint");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { applyMovement } = require("../utils/elasticStock");
const { requireReason } = require("../utils/auditReason");

router.use(isAuthenticated);

function packingDetailQuery(query) {
  return query
    .populate("elastic", "name testingParameters")
    .populate("checkedBy", "name")
    .populate("packedBy",  "name")
    .populate({
      path: "job",
      select: "jobOrderNo customer order",
      populate: [
        { path: "customer", select: "name"       },
        { path: "order",    select: "po orderNo" },
      ],
    });
}

router.get(
  "/jobs-packing",
  catchAsyncErrors(async (req, res, next) => {
    const jobs = await JobOrder.find({
          status: { $in: ["weaving", "finishing", "checking"] },
        })
      .populate("customer", "name")
      .populate("elastics.elastic", "name")
      .select("_id jobOrderNo elastics customer");

    res.status(200).json({ success: true, jobs });
  })
);

router.get(
  "/grouped",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const grouped = await Packing.aggregate([
      { $group: { _id: "$job", totalBoxes: { $sum: 1 }, totalMeters: { $sum: "$meter" } } },
      { $project: { job: "$_id", totalBoxes: 1, totalMeters: 1, _id: 0 } },
    ]);

    const populated = await JobOrder.populate(grouped, {
      path:   "job",
      select: "jobOrderNo customer",
      populate: { path: "customer", select: "name" },
    });

    const result = populated.filter((e) => e.job !== null);

    res.status(200).json({ success: true, grouped: result });
  })
);

router.get(
  "/by-job/:jobId",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.params;

    const packings = await packingDetailQuery(
      Packing.find({ job: jobId })
    ).sort({ createdAt: -1 });

    res.status(200).json({ success: true, packings });
  })
);

router.get(
  "/detail/:id",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const packing = await packingDetailQuery(
      Packing.findById(req.params.id)
    );

    if (!packing) {
      return next(new ErrorHandler("Packing record not found", 404));
    }

    res.status(200).json({ success: true, packing });
  })
);

router.post(
  "/create-packing",
  catchAsyncErrors(async (req, res, next) => {
    const {
      job, elastic, meter, joints,
      tareWeight, netWeight, grossWeight,
      stretch, size, checkedBy, packedBy,
      requestId,
    } = req.body;

    // Idempotency: a retried submit (flaky factory network, double-tap)
    // must not create a second box and double-count stock. Fast path
    // here; the unique index on requestId is the guarantee under race.
    if (requestId) {
      const existing = await Packing.findOne({ requestId }).lean();
      if (existing) {
        return res.status(200).json({
          success: true, duplicate: true, packing: existing,
          message: "Already recorded (duplicate submit ignored)",
        });
      }
    }

    if (!job)        return next(new ErrorHandler("job is required",     400));
    if (!elastic)    return next(new ErrorHandler("elastic is required", 400));
    // Cap at 50000 m — a single packing record well beyond the
    // weaving capacity of any machine in a shift. Without this a
    // typo (999999999) silently lands and corrupts stock + ledger.
    const PACKING_METER_MAX = 50000;
    if (!meter || isNaN(Number(meter)) || Number(meter) <= 0) {
      return next(new ErrorHandler("meter must be a positive number",    400));
    }
    if (Number(meter) > PACKING_METER_MAX) {
      return next(new ErrorHandler(
        `meter ${meter} exceeds ${PACKING_METER_MAX}m per record`, 400));
    }
    if (!netWeight   || isNaN(Number(netWeight)))   {
      return next(new ErrorHandler("netWeight is required",   400));
    }
    if (!tareWeight  || isNaN(Number(tareWeight)))  {
      return next(new ErrorHandler("tareWeight is required",  400));
    }
    if (!grossWeight || isNaN(Number(grossWeight))) {
      return next(new ErrorHandler("grossWeight is required", 400));
    }
    if (!checkedBy) return next(new ErrorHandler("checkedBy is required", 400));
    if (!packedBy)  return next(new ErrorHandler("packedBy is required",  400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const [jobDoc, elasticDoc] = await Promise.all([
          JobOrder.findById(job).session(session),
          Elastic.findById(elastic).session(session),
        ]);
        if (!jobDoc)     throw new ErrorHandler("Job not found",     404);
        if (!elasticDoc) throw new ErrorHandler("Elastic not found", 404);

        const [packing] = await Packing.create([{
          job, elastic,
          meter:       Number(meter),
          joints:      Number(joints) || 0,
          tareWeight:  Number(tareWeight),
          netWeight:   Number(netWeight),
          grossWeight: Number(grossWeight),
          stretch:     stretch  || "",
          size:        size     || "",
          checkedBy, packedBy,
          ...(requestId ? { requestId } : {}),
        }], { session });

        const idx = jobDoc.packedElastic.findIndex(
          (e) => e.elastic.toString() === elastic.toString()
        );
        if (idx >= 0) {
          jobDoc.packedElastic[idx].quantity += Number(meter);
        }
        jobDoc.packingDetails.push(packing._id);

        const actor = actorFromRequest(req);
        const fp = buildFingerprint(ACTION_CODES.PACKING_CREATED, {
          entityId: jobDoc._id,
          actor,
          meta: {
            packingId:   packing._id.toString(),
            elasticId:   elastic.toString(),
            elasticName: elasticDoc.name,
            meter:       Number(meter),
            joints:      Number(joints) || 0,
            netWeight:   Number(netWeight),
            grossWeight: Number(grossWeight),
            size:        size || undefined,
            stretch:     stretch || undefined,
          },
        });
        jobDoc.fingerprints.push(fp);
        await jobDoc.save({ session });

        if (jobDoc.order) {
          const order = await Order.findById(jobDoc.order).session(session);
          if (order) {
            order.fingerprints.push(buildFingerprint(ACTION_CODES.PACKING_CREATED, {
              entityId: order._id, actor,
              meta: {
                jobId:          jobDoc._id.toString(),
                jobOrderNo:     jobDoc.jobOrderNo,
                elasticName:    elasticDoc.name,
                meter:          Number(meter),
                relatedHash:    fp.hash,
                relatedShortId: fp.shortId,
              },
            }));
            await order.save({ session });
          }
        }

        // ── Stock IN — packing increases on-hand stock and the
        //    cumulative quantityProduced counter (same delta).
        //    Inward packing can never clamp (stock can only go up),
        //    so applied === requested === meter; safe to bump
        //    quantityProduced by the same amount.
        await applyMovement(session, {
          elasticId:       elastic,
          type:            "PACKING_INWARD",
          quantity:        +Number(meter),
          refType:         "Packing",
          refId:           packing._id,
          by:              req.user?._id,
          alsoIncProduced: true,
        });

        console.log(
          `[packing/create] Job #${jobDoc.jobOrderNo} | elastic ${elasticDoc.name} | ${meter}m`
        );

        resp = { packing, fingerprint: fp };
      });
      res.status(201).json({ success: true, ...resp });
    } catch (err) {
      // Race with a concurrent duplicate submit: the unique requestId
      // index aborted this transaction, so NOTHING here was applied —
      // the winner's create did the work. Report success idempotently.
      if (err?.code === 11000 && requestId) {
        const existing = await Packing.findOne({ requestId }).lean();
        if (existing) {
          return res.status(200).json({
            success: true, duplicate: true, packing: existing,
            message: "Already recorded (duplicate submit ignored)",
          });
        }
      }
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.get(
  "/employees-by-department/:dept",
  catchAsyncErrors(async (req, res, next) => {
    const employees = await Employee.find({
      department: req.params.dept,
    }).select("_id name").sort({ name: 1 });

    res.status(200).json({ success: true, employees });
  })
);

router.get(
  "/all",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { limit = 50, skip = 0 } = req.query;

    const packings = await packingDetailQuery(Packing.find())
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(skip));

    const total = await Packing.countDocuments();

    res.status(200).json({ success: true, total, packings });
  })
);

// ═══════════════════════════════════════════════════════════
//  DELETE PACKING — admin undo
//
//  P0-3: split the stock reversal from the quantityProduced
//  decrement. The clamped `applied` on PACKING_REVERSE is correct
//  for stock (max -current), but quantityProduced should reflect
//  the full original production — so we decrement it by the
//  source PACKING_INWARD's `applied` independent of the clamp.
//
//  Without this split, deleting a 10 m packing against a current
//  stock of 5 would only knock 5 off quantityProduced, leaving
//  the counter 5 above truth.
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
//  EDIT PACKING — correct the packed meters. Applies the delta to
//  the job counter, the stock ledger (PACKING_INWARD / _REVERSE)
//  and Elastic.quantityProduced, then stamps a fingerprint.
// ═══════════════════════════════════════════════════════════
router.put(
  "/:id",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));

    const { meter } = req.body;
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const packing = await Packing.findById(req.params.id).session(session);
        if (!packing) throw new ErrorHandler("Packing record not found", 404);

        const oldMeter = Number(packing.meter || 0);
        const newMeter = meter != null ? Number(meter) : oldMeter;
        if (!Number.isFinite(newMeter) || newMeter <= 0) throw new ErrorHandler("Meter must be > 0", 400);
        const delta = newMeter - oldMeter;

        if (delta !== 0) {
          const job = await JobOrder.findById(packing.job).session(session);
          if (job) {
            const idx = job.packedElastic.findIndex(
              (e) => e.elastic.toString() === packing.elastic.toString()
            );
            if (idx >= 0) job.packedElastic[idx].quantity = Math.max(0, (job.packedElastic[idx].quantity || 0) + delta);
          }

          if (delta > 0) {
            await applyMovement(session, {
              elasticId: packing.elastic, type: "PACKING_INWARD", quantity: +delta,
              refType: "Packing", refId: packing._id, alsoIncProduced: true,
              reason: `packing edit +${delta} (${auditReason})`, by: req.user?._id,
            });
          } else {
            await applyMovement(session, {
              elasticId: packing.elastic, type: "PACKING_REVERSE", quantity: delta,
              refType: "Packing", refId: packing._id,
              reason: `packing edit ${delta} (${auditReason})`, by: req.user?._id,
            });
            await Elastic.updateOne({ _id: packing.elastic }, { $inc: { quantityProduced: delta } }, { session });
          }

          packing.meter = newMeter;
          await packing.save({ session });

          if (job) {
            stampFingerprint(job, ACTION_CODES.PACKING_UPDATED, {
              req,
              meta: { packingId: packing._id.toString(), auditReason, before: { meter: oldMeter }, after: { meter: newMeter } },
            });
            await job.save({ session });
          }
        }
        result = packing.toObject();
      });
      res.status(200).json({ success: true, message: "Packing updated", packing: result });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.delete(
  "/:id",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to delete", 400));

    const session = await mongoose.startSession();
    try {
      let packingId;
      await session.withTransaction(async () => {
        const packing = await Packing.findById(req.params.id).session(session);
        if (!packing) {
          throw new ErrorHandler("Packing record not found", 404);
        }
        packingId = packing._id;

        const job = await JobOrder.findById(packing.job).session(session);
        if (job) {
          const idx = job.packedElastic.findIndex(
            (e) => e.elastic.toString() === packing.elastic.toString()
          );
          if (idx >= 0 && job.packedElastic[idx].quantity >= packing.meter) {
            job.packedElastic[idx].quantity -= packing.meter;
          }
          job.packingDetails = job.packingDetails.filter(
            (id) => id.toString() !== packing._id.toString()
          );
          stampFingerprint(job, ACTION_CODES.PACKING_DELETED, {
            req,
            meta: { packingId: packing._id.toString(), auditReason, elastic: packing.elastic?.toString(), meter: packing.meter },
          });
          await job.save({ session });
        }

        // Look up the original PACKING_INWARD so we know how much
        // production was originally credited. quantityProduced is
        // decremented by THAT, not by the (possibly clamped) stock
        // delta of this reversal.
        const original = await StockMovement.findOne({
          refType: "Packing",
          refId:   packing._id,
          elastic: packing.elastic,
          type:    "PACKING_INWARD",
        }).session(session);

        // Reverse the stock side. alsoIncProduced is OFF here —
        // the produced counter is corrected below independently.
        await applyMovement(session, {
          elasticId: packing.elastic,
          type:      "PACKING_REVERSE",
          quantity:  -Number(packing.meter),
          refType:   "Packing",
          refId:     packing._id,
          reason:    original
            ? `reversal of PACKING_INWARD ${original._id}`
            : "reversal (no source PACKING_INWARD found)",
          by:        req.user?._id,
        });

        // Correct quantityProduced by the full original inward
        // amount. Falls back to `packing.meter` for legacy packings
        // that predate the ledger.
        const producedDelta = original
          ? Number(original.applied || 0)
          : Number(packing.meter || 0);

        if (producedDelta > 0) {
          await Elastic.updateOne(
            { _id: packing.elastic },
            { $inc: { quantityProduced: -producedDelta } },
            { session }
          );
        }

        await packing.deleteOne({ session });
      });
      res.status(200).json({ success: true, message: "Packing record deleted", id: packingId });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

module.exports = router;
