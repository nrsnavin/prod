"use strict";

const express  = require("express");
const router   = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const Packing          = require("../models/Packing");
const JobOrder         = require("../models/JobOrder");
const Employee         = require("../models/Employee");
const Elastic          = require("../models/Elastic");

// ─────────────────────────────────────────────────────────────
//  SHARED POPULATE CHAIN for full Packing detail
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
//  1.  JOBS IN PACKING STATUS  (for Add Packing dropdown)
//      GET /packing/jobs-packing
//
//  FIX: .select("_id jobOrderNo elastics") excluded the customer
//       field despite populate("customer") — select must include it.
// ─────────────────────────────────────────────────────────────
router.get(
  "/jobs-packing",
  catchAsyncErrors(async (req, res, next) => {
    const jobs = await JobOrder.find({ status: "packing" })
      .populate("customer", "name")
      .populate("elastics.elastic", "name")
      .select("_id jobOrderNo elastics customer");

    res.status(200).json({ success: true, jobs });
  })
);

// ─────────────────────────────────────────────────────────────
//  2.  GROUPED OVERVIEW  (list page)
//      GET /packing/grouped
//
//  FIX: original had NO error handling — uncaught exceptions
//       crashed the server process.
//  FIX: JobOrder.populate() is a static method call on raw objects;
//       safe, but if job was deleted e.job is null → Flutter crash.
//       Added null filter + totalMeters aggregation.
// ─────────────────────────────────────────────────────────────
router.get(
  "/grouped",
  catchAsyncErrors(async (req, res, next) => {
    const grouped = await Packing.aggregate([
      {
        $group: {
          _id:         "$job",
          totalBoxes:  { $sum: 1 },
          totalMeters: { $sum: "$meter" },
        },
      },
      {
        $project: {
          job:         "$_id",
          totalBoxes:  1,
          totalMeters: 1,
          _id:         0,
        },
      },
    ]);

    const populated = await JobOrder.populate(grouped, {
      path:   "job",
      select: "jobOrderNo customer",
      populate: { path: "customer", select: "name" },
    });

    // FIX: filter out entries where the job was deleted
    const result = populated.filter((e) => e.job !== null);

    res.status(200).json({ success: true, grouped: result });
  })
);

// ─────────────────────────────────────────────────────────────
//  3.  PACKINGS FOR A SPECIFIC JOB  (list-by-job page)
//      GET /packing/by-job/:jobId
//
//  FIX: original GET /job/:jobNo used req.params.jobNo as the
//       MongoDB _id query filter (Packing.find({ job: jobNo })).
//       While this technically works for ObjectId strings, it
//       returned RAW documents with no populate → elastic.name
//       was always an ObjectId string, never the name.
//       New route populates elastic, checkedBy, packedBy, job.
// ─────────────────────────────────────────────────────────────
router.get(
  "/by-job/:jobId",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId } = req.params;

    const packings = await packingDetailQuery(
      Packing.find({ job: jobId })
    ).sort({ createdAt: -1 });

    res.status(200).json({ success: true, packings });
  })
);

// ─────────────────────────────────────────────────────────────
//  4.  PACKING DETAIL  (detail page)
//      GET /packing/detail/:id
//
//  FIX: original GET /:id did NOT populate "elastic" →
//       PackingDetailController got an ObjectId string for
//       elastic, so elasticName was always blank in the UI.
//  FIX: original route returned the document directly (no wrapper)
//       but Flutter code called res.data['packing'] → TypeError.
//       Now wrapped in { success, packing }.
// ─────────────────────────────────────────────────────────────
router.get(
  "/detail/:id",
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

// ─────────────────────────────────────────────────────────────
//  5.  CREATE PACKING
//      POST /packing/create-packing
//
//  FIX: original did Packing.create(req.body) passing the full
//       request body with no validation → type errors stored silently.
//  FIX: packedElastic findIndex used loose == on an ObjectId vs String.
//       Fixed to strict .toString() === comparison.
//  FIX: if elastic not found in packedElastic array, index === -1 and
//       packedElastic[-1] = undefined → TypeError. Added index guard.
// ─────────────────────────────────────────────────────────────
router.post(
  "/create-packing",
  catchAsyncErrors(async (req, res, next) => {
    const {
      job, elastic, meter, joints,
      tareWeight, netWeight, grossWeight,
      stretch, size, checkedBy, packedBy,
    } = req.body;

    // ── Validation ─────────────────────────────────────────
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

    // ── Validate references ────────────────────────────────
    const [jobDoc, elasticDoc] = await Promise.all([
      JobOrder.findById(job),
      Elastic.findById(elastic),
    ]);
    if (!jobDoc)     return next(new ErrorHandler("Job not found",     404));
    if (!elasticDoc) return next(new ErrorHandler("Elastic not found", 404));

    // ── Create packing ─────────────────────────────────────
    const packing = await Packing.create({
      job,
      elastic,
      meter:       Number(meter),
      joints:      Number(joints) || 0,
      tareWeight:  Number(tareWeight),
      netWeight:   Number(netWeight),
      grossWeight: Number(grossWeight),
      stretch:     stretch  || "",
      size:        size     || "",
      checkedBy,
      packedBy,
    });

    // ── Update job.packedElastic ───────────────────────────
    // FIX: was `e.id == req.body.elastic` (loose equality on ObjectId virtual)
    //      Fixed to strict string comparison.
    const idx = jobDoc.packedElastic.findIndex(
      (e) => e.elastic.toString() === elastic.toString()
    );

    if (idx >= 0) {
      jobDoc.packedElastic[idx].quantity += Number(meter);
    }
    // If not found in packedElastic array it means this elastic wasn't tracked;
    // don't crash — just log.

    jobDoc.packingDetails.push(packing._id);
    await jobDoc.save();

    console.log(
      `[packing/create] Job #${jobDoc.jobOrderNo} | elastic ${elasticDoc.name} | ${meter}m`
    );

    res.status(201).json({ success: true, packing });
  })
);

// ─────────────────────────────────────────────────────────────
//  6.  EMPLOYEES BY DEPARTMENT  (for form dropdowns)
//      GET /packing/employees-by-department/:dept
// ─────────────────────────────────────────────────────────────
router.get(
  "/employees-by-department/:dept",
  catchAsyncErrors(async (req, res, next) => {
    const employees = await Employee.find({
      department: req.params.dept,
    }).select("_id name").sort({ name: 1 });

    res.status(200).json({ success: true, employees });
  })
);

// ─────────────────────────────────────────────────────────────
//  7.  GET ALL PACKINGS  (admin / reporting)
//      GET /packing/all
// ─────────────────────────────────────────────────────────────
router.get(
  "/all",
  catchAsyncErrors(async (req, res, next) => {
    const { limit = 50, skip = 0 } = req.query;

    const packings = await packingDetailQuery(Packing.find())
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(skip));

    const total = await Packing.countDocuments();

    // FIX: was status 201 for a GET request
    res.status(200).json({ success: true, total, packings });
  })
);

// ─────────────────────────────────────────────────────────────
//  8.  DELETE PACKING  (admin use)
//      DELETE /packing/:id
// ─────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  catchAsyncErrors(async (req, res, next) => {
    const packing = await Packing.findById(req.params.id);
    if (!packing) {
      return next(new ErrorHandler("Packing record not found", 404));
    }

    // Reverse the packedElastic update on the job
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