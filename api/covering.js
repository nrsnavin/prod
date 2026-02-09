// const express = require("express");
// const router = express.Router();

// const catchAsyncErrors = require("../middleware/catchAsyncErrors");
// const ErrorHandler = require("../utils/ErrorHandler");

// const Covering = require("../models/Covering");
// const JobOrder = require("../models/JobOrder");
// const Employee = require("../models/Employee");

// /**
//  * 🔹 GET OPEN COVERING
//  */
// router.get(
//   "/open",
//   catchAsyncErrors(async (req, res, next) => {
//     const coverings = await Covering.find({ status: "open" })
//       .populate("job")
//       .populate("machine")
//       .populate("operator")
//       .exec();

//     res.status(200).json({
//       success: true,
//       count: coverings.length,
//       data: coverings,
//     });
//   })
// );

// /**
//  * 🔹 GET COMPLETED COVERING
//  */
// router.get(
//   "/completed",
//   catchAsyncErrors(async (req, res, next) => {
//     const coverings = await Covering.find({ status: "completed" })
//       .populate("job")
//       .populate("machine")
//       .populate("closedBy")
//       .exec();

//     res.status(200).json({
//       success: true,
//       count: coverings.length,
//       data: coverings,
//     });
//   })
// );

// /**
//  * 🔹 GET COVERING DETAIL
//  * ?id=coveringId
//  */
// router.get(
//   "/detail",
//   catchAsyncErrors(async (req, res, next) => {
//     const { id } = req.query;

//     if (!id) {
//       return next(new ErrorHandler("Covering ID required", 400));
//     }

//     const covering = await Covering.findById(id)
//       .populate("job")
//       .populate("machine")
//       .populate("elasticPlanned.elastic")
//       .populate("elasticCovered.elastic")
//       .populate("wastageElastic.elastic")
//       .populate("operator")
//       .populate("closedBy")
//       .exec();

//     if (!covering) {
//       return next(new ErrorHandler("Covering not found", 404));
//     }

//     res.status(200).json({
//       success: true,
//       data: covering,
//     });
//   })
// );

// /**
//  * 🔹 MARK COVERING AS COMPLETED
//  */
// router.post(
//   "/complete",
//   catchAsyncErrors(async (req, res, next) => {
//     const { coveringId, closedBy } = req.body;

//     if (!coveringId || !closedBy) {
//       return next(
//         new ErrorHandler("Covering ID and closedBy are required", 400)
//       );
//     }

//     const covering = await Covering.findById(coveringId);

//     if (!covering) {
//       return next(new ErrorHandler("Covering not found", 404));
//     }

//     covering.status = "completed";
//     covering.closedBy = closedBy;
//     covering.completedDate = new Date();

//     await covering.save();

//     res.status(200).json({
//       success: true,
//       message: "Covering completed successfully",
//       data: covering,
//     });
//   })
// );

// module.exports = router;
    

const express = require("express");
const router = express.Router();
const Covering = require("../models/Covering");
const JobOrder = require("../models/JobOrder");
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");

// LIST COVERING
router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
   try {
     const {
      status = "open",
      search = "",
      page = 1,
      limit = 20,
    } = req.query;

    const skip = (page - 1) * limit;

    console.log("cover")

    let jobFilter = {};
    if (search) {
      const jobs = await JobOrder.find({
        jobOrderNo: { $regex: search, $options: "i" },
      }).select("_id");

      jobFilter.job = { $in: jobs.map(j => j._id) };
    }

    const filter = { status, ...jobFilter };


    console.log("filter", filter)
    const data = await Covering.find(filter)
      .populate({
        path: "job",
        select: "jobOrderNo status",
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

      // console.log("data", data) 

    const total = await Covering.countDocuments(filter);

    console.log("total", total) 

    res.status(200).json({
      success: true,
      data,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        hasMore: skip + data.length < total,
      },
    });
   } catch (error) {
    console.error("Error fetching coverings:", error);
    return next(new ErrorHandler("Failed to fetch coverings", 500));
   }
  })
);


// GET COVERING DETAIL
// GET /api/covering/detail?id=...
router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;

    if (!id) {
      return next(new ErrorHandler("Covering ID is required", 400));
    }

    const covering = await Covering.findById(id)
      // 🔗 Populate Job → Customer + Order
      .populate({
        path: "job",
        populate: [
          { path: "customer", select: "name" },
          { path: "order", select: "orderNo po" },
        ],
      })

      // 🧵 Populate Elastic technical details
      .populate({
        path: "elasticPlanned.elastic",
        populate: [
          { path: "warpSpandex.id", select: "name category" },
          { path: "spandexCovering.id", select: "name category" },
        ],
      })
      .lean();

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    res.status(200).json({
      success: true,
      covering,
    });
  })
);


// POST /api/covering/start
router.post(
  "/start",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.body;

    if (!id) {
      return next(new ErrorHandler("Covering ID required", 400));
    }

    const covering = await Covering.findById(id);

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    if (covering.status !== "open") {
      return next(
        new ErrorHandler("Only OPEN covering can be started", 400)
      );
    }

    covering.status = "in_progress";
    await covering.save();

    res.status(200).json({
      success: true,
      covering,
    });
  })
);


// POST /api/covering/complete
router.post(
  "/complete",
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;

    if (!id) {
      return next(new ErrorHandler("Covering ID required", 400));
    }

    const covering = await Covering.findById(id);

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    if (covering.status !== "in_progress") {
      return next(
        new ErrorHandler("Only IN-PROGRESS covering can be completed", 400)
      );
    }

    covering.status = "completed";
    covering.completedDate = new Date();
    covering.remarks = remarks || "";

    await covering.save();

    res.status(200).json({
      success: true,
      covering,
    });
  })
);




module.exports = router;
