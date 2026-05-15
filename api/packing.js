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
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

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
  isAdmin('admin'),
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
  isAdmin('admin'),
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
  isAdmin('admin'),
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
  isAdmin('admin'),
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

// Floor entry — packers (employees) record their own work.
router.post(
  "/create-packing",
  catchAsyncErrors(async (req, res, next) => {
    const {
      job, elastic, meter, joints,
      tareWeight, netWeight, grossWeight,
      stretch, size, checkedBy, packedBy,
    } = req.body;

    if (!job)        return next(new ErrorHandler("job is required",     400));
    if (!elastic)    return next(new ErrorHandler("elastic is required", 400));
    if (!meter || isNaN(Number(meter)) || Number(meter) <= 0) {
      return next(new ErrorHandler("meter must be a positive number",    400));
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

        console.log(
          `[packing/create] Job #${jobDoc.jobOrderNo} | elastic ${elasticDoc.name} | ${meter}m`
        );

        resp = { packing, fingerprint: fp };
      });
      res.status(201).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.get(
  "/employees-by-department/:dept",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const employees = await Employee.find({
      department: req.params.dept,
    }).select("_id name").sort({ name: 1 });

    res.status(200).json({ success: true, employees });
  })
);

router.get(
  "/all",
  isAdmin('admin'),
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

router.delete(
  "/:id",
  isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const packing = await Packing.findById(req.params.id);
    if (!packing) {
      return next(new ErrorHandler("Packing record not found", 404));
    }

    const job = await JobOrder.findById(packing.job);
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
      await job.save();
    }

    await packing.deleteOne();

    res.status(200).json({ success: true, message: "Packing record deleted" });
  })
);

module.exports = router;
