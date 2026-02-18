// const express = require("express");
// const { isAuthenticated, isAdmin } = require("../middleware/auth");
// const catchAsyncErrors = require("../middleware/catchAsyncErrors");
// const router = express.Router();
// const RawMaterial = require("../models/RawMaterial.js");
// const ErrorHandler = require("../utils/ErrorHandler");
// const Warping = require("../models/Warping.js");
// const Employee = require("../models/Employee.js");

// router.get(
//     "/get-open-warping",
//     // isAuthenticated,
//     catchAsyncErrors(async (req, res, next) => {
//         try {
//             const warping = await Warping.find({ status: 'open' }).populate('job').exec();
//             res.status(200).json({
//                 success: true,
//                 warping,
//             });
//         } catch (error) {
//             return next(new ErrorHandler(error.message, 500));
//         }
//     })
// );
// router.get(
//     "/get-closed-warping",
//     // isAuthenticated,
//     catchAsyncErrors(async (req, res, next) => {
//         try {
//             const warping = await Warping.find({ status: 'closed' }).populate('job').exec();
//             res.status(200).json({
//                 success: true,
//                 warping,
//             });
//         } catch (error) {
//             return next(new ErrorHandler(error.message, 500));
//         }
//     })
// );


// router.get(
//     "/get-warping-detail",
//     // isAuthenticated,
//     catchAsyncErrors(async (req, res, next) => {
//         try {
//             const warping = await Warping.findById(req.query.id).populate('job').populate('elasticOrdered.id').populate('closedBy').exec();
//             res.status(200).json({
//                 success: true,
//                 warping,
//             });
//         } catch (error) {
//             return next(new ErrorHandler(error.message, 500));
//         }
//     })
// );


// router.post(
//     "/warping-completed",
//     // isAuthenticated,
//     catchAsyncErrors(async (req, res, next) => {
//         try {
//             const warping = await Warping.findById(req.body.id);

//             warping.status = "closed";
//             warping.closedBy = req.body.closedBy;

//             warping.completedDate = Date.now();

//             await warping.save();

//             res.status(201).json({
//                 success: true,
//                 warping,
//             });
//         } catch (error) {
//             return next(new ErrorHandler(error.message, 500));
//         }
//     })
// );


// router.post(
//     "/login-employee",
//     catchAsyncErrors(async (req, res, next) => {
//         try {
//             const { userName, password } = req.body;

//             console.log(password);


//             if (!userName || !password) {
//                 return next(new ErrorHandler("Please provide the all fields!", 400));
//             }

//             const employee = await Employee.findOne({ userName }).select("+password");





//             if (!employee) {
//                 return next(new ErrorHandler("User doesn't exists!", 400));
//             }
//             if (employee.password == password && employee.Department == "warping") {
//                 //   const token = generateToken(employee);

//                 //   console.log(token);



//                 res
//                     .status(201)
//                     .json({
//                         username: employee.name,
//                         id: employee._id,
//                         role: employee.role,
//                         totalWastage: employee.totalWastage,
//                         totalProduction: employee.totalProduction,
//                         skill: employee.skill,
//                         Department: employee.Department,
//                         aadhar: employee.aadhar,
//                         totalShifts: employee.totalShifts,

//                         //   token: token,

//                     });
//             } else {
//                 res.status(401).json({ message: "Invalid Credentials" });
//             }
//         }

//         catch (error) {
//             return next(new ErrorHandler(error.message, 500));
//         }
//     })
// );

// module.exports = router;






const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Warping = require("../models/Warping");
const JobOrder = require("../models/JobOrder");
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const WarpingPlan = require("../models/WarpingPlan");
const { updateJobToWeavingIfReady } = require("../utils/jobStatusHelper");

/**
 * ✅ CREATE WARPING (usually called while creating JobOrder)
 */
router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, elasticOrdered } = req.body;

    if (!jobId) {
      return next(new ErrorHandler("Job ID is required", 400));
    }

    const job = await JobOrder.findById(jobId);
    if (!job) {
      return next(new ErrorHandler("Job not found", 404));
    }

    const warping = await Warping.create({
      job: jobId,
      elasticOrdered: elasticOrdered || job.elastics,
    });

    // link warping to job
    job.warping = warping._id;
    await job.save();

    res.status(201).json({
      success: true,
      warping,
    });
  })
);

/**
 * 📄 LIST WARPINGS
 * Filters:
 *  - status
 *  - search (jobOrderNo)
 *  - pagination
 */
router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
    const {
      status = "open",
      search = "",
      page = 1,
      limit = 20,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    // 🔎 find job ids by jobOrderNo
    let jobFilter = {};
    if (search) {
      const jobs = await JobOrder.find({
        jobOrderNo: { $regex: search, $options: "i" },
      }).select("_id");

      jobFilter.job = { $in: jobs.map((j) => j._id) };
    }

    const filter = {
      status,
      ...jobFilter,
    };

    const warpings = await Warping.find(filter)
      .populate({
        path: "job",
        select: "jobOrderNo status",
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    const total = await Warping.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: warpings,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        hasMore: skip + warpings.length < total,
      },
    });
  })
);

/**
 * 🔍 GET WARPING DETAIL
 */
router.get(
  "/detail/:id",
  catchAsyncErrors(async (req, res, next) => {
    const warping = await Warping.findById(req.params.id)
      .populate({
        path: "job",
        select: "jobOrderNo status",
      })
      .populate({
        path: "elasticOrdered.elastic",
        populate: [
          { path: "warpSpandex.id", select: "name category" },
          { path: "warpYarn.id", select: "name category" },
          { path: "spandexCovering.id", select: "name category" },
          { path: "weftYarn.id", select: "name category" },
        ],
      });

    if (!warping) {
      return next(new ErrorHandler("Warping not found", 404));
    }

    res.status(200).json({
      success: true,
      warping,
    });
  })
);



/**
 * ✅ COMPLETE WARPING
 */


/**
 * ❌ CANCEL WARPING
 */
router.patch(
  "/cancel/:id",
  catchAsyncErrors(async (req, res, next) => {
    const warping = await Warping.findById(req.params.id);

    if (!warping) {
      return next(new ErrorHandler("Warping not found", 404));
    }

    warping.status = "cancelled";
    await warping.save();

    res.status(200).json({
      success: true,
      warping,
    });
  })
);


router.put(
  "/start",
  catchAsyncErrors(async (req, res) => {
    const warping = await Warping.findById(req.query.id);

    console.log("war")

    if (!warping) {
      return res.status(404).json({ message: "Warping not found" });
    }

    if (!warping.warpingPlan) {
      return res.status(400).json({
        message: "Create warping plan before starting",
      });
    }

    if (warping.status !== "open") {
      return res.status(400).json({
        message: "Warping already started or completed",
      });
    }

    warping.status = "in_progress";
    await warping.save();

    console.log("starts")

    res.json({
      success: true,
      warping,
    });
  })
);




router.put(
  "/complete",
  catchAsyncErrors(async (req, res) => {
    const warping = await Warping.findById(req.query.id);

    if (!warping) {
      return res.status(404).json({ message: "Warping not found" });
    }

    if (warping.status !== "in_progress") {
      return res.status(400).json({
        message: "Warping is not in progress",
      });
    }

    warping.status = "completed";
    warping.completedDate = new Date();
    await warping.save();

    // 🔁 Check if job can move to WEAVING
    await updateJobToWeavingIfReady(warping.job);

    res.json({
      success: true,
      warping,
    });
  })
);


router.get(
  "/warpingPlan",
  catchAsyncErrors(async (req, res) => {

    
    const plan = await WarpingPlan.findOne({
      _id: req.query.id,
    })
      .populate("job")
      .populate("beams.sections.warpYarn");
console.log(plan);
    if (!plan) {
      return res.json({ exists: false });
    }

    res.json({
      exists: true,
      plan,
    });
  })
);





router.post(
  "/warpingPlan/create",
  catchAsyncErrors(async (req, res) => {
   try {
     const warpingId = req.body.warpingId;

    const warping = await Warping.findById(warpingId);
    if (!warping) {
      return res.status(404).json({ message: "Warping not found" });
    }

    // 🔒 Prevent duplicate plan
    if (warping.warpingPlan) {
      return res.status(400).json({
        message: "Warping plan already exists",
      });
    }

    const plan = await WarpingPlan.create({
      warping: warping._id,
      job: warping.job,
      noOfBeams: req.body.noOfBeams,
      beams: req.body.beams,
      remarks: req.body.remarks,
    });

    warping.warpingPlan = plan._id;
    await warping.save();

    res.status(201).json({
      success: true,
      plan,
    });
   } catch (error) {
    console.log(error);
    res.status(500).json({ success: false, message: error.message });
   }
  })
);

router.get("/detail/:id", async (req, res) => {
  try {
   const warping = await Warping.findById(req.params.id)
      .populate("job")
      .populate("elasticOrdered.elastic")
      .populate({
        path: "warpingPlan",
        populate: {
          path: "beams.sections.warpYarn",
        },
      });

    if (!warping) {
      return res.status(404).json({ message: "Warping not found" });
    }

    res.json({
      success: true,
      warping,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});



router.get(
  "/plan-context/:jobId",
  catchAsyncErrors(async (req, res) => {

    console.log("Fetching plan context for job:", req.params.jobId);
    const job = await JobOrder.findById(req.params.jobId)
      .populate({
        path: "elastics.elastic",
        populate: {
          path: "warpYarn.id",
          model: "RawMaterial",
        },
      })
      .exec();

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    // 🔑 Extract unique warp yarns
    const warpMap = new Map();

    job.elastics.forEach(e => {
      e.elastic.warpYarn.forEach(w => {
        if (w.id && w.id.category === "warp") {
          warpMap.set(w.id._id.toString(), {
            id: w.id._id,
            name: w.id.name,
          });
        }
      });
    });

    res.json({
      success: true,
      jobId: job._id,
      warpYarns: Array.from(warpMap.values()),
    });
  })
);


module.exports = router;
