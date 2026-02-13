// const express = require("express");
// const router = express.Router();

// const catchAsyncErrors = require("../middleware/catchAsyncErrors");
// const ErrorHandler = require("../utils/ErrorHandler");

// const Order = require("../models/Order");
// const JobOrder = require("../models/JobOrder");
// const Machine = require("../models/Machine");
// const Warping = require("../models/Warping");
// const Covering = require("../models/Covering");


// router.post(
//   "/create",
//   catchAsyncErrors(async (req, res, next) => {
//     const { date, status, order, elastics, customer } = req.body;

//     if (!order || !elastics?.length) {
//       return next(new ErrorHandler("Invalid job data", 400));
//     }

//     const filtered = elastics.filter(e => e.quantity > 0);

//     const job = await JobOrder.create({
//       date: new Date(date),
//       status,
//       order,
//       customer,
//       elastics: filtered,
//       producedElastic: filtered.map(e => ({ id: e.id, quantity: 0 })),
//       packedElastic: filtered.map(e => ({ id: e.id, quantity: 0 })),
//       wastageElastic: filtered.map(e => ({ id: e.id, quantity: 0 })),
//     });

//     const orderDoc = await Order.findById(order);
//     if (!orderDoc) return next(new ErrorHandler("Order not found", 404));

//     for (const e of filtered) {
//       const prod = orderDoc.producedElastic.find(x => x.id.equals(e.id));
//       const pend = orderDoc.pendingElastic.find(x => x.id.equals(e.id));

//       if (prod) prod.quantity += e.quantity;
//       if (pend) pend.quantity -= e.quantity;
//     }

//     orderDoc.jobs.push({ id: job._id, no: job.jobOrderNo });
//     await orderDoc.save();

//     res.status(201).json({ success: true, job });
//   })
// );


// router.get(
//   "/:id",
//   catchAsyncErrors(async (req, res, next) => {
//     const job = await JobOrder.findById(req.params.id)
//       .populate("elastics.id")
//       .populate("shiftDetails")
//       .populate("warping")
//       .populate("covering")
//       .populate("machine");

//     if (!job) return next(new ErrorHandler("Job not found", 404));

//     const elastics = job.elastics.map(e => {
//       const id = e.id._id;
//       return {
//         id,
//         name: e.id.name,
//         ordered: e.quantity,
//         produced: job.producedElastic.find(x => x.id.equals(id))?.quantity || 0,
//         wastage: job.wastageElastic.find(x => x.id.equals(id))?.quantity || 0,
//         packed: job.packedElastic.find(x => x.id.equals(id))?.quantity || 0,
//       };
//     });

//     res.status(200).json({
//       success: true,
//       job: {
//         _id: job._id,
//         jobOrderNo: job.jobOrderNo.toString(),
//         date: job.date,
//         status: job.status,
//         customer: job.customer,
//         elastics,
//         machine: job.machine || "Not Assigned",
//         warping: job.warping || "Not Assigned",
//         covering: job.covering || "Not Assigned",
//       },
//     });
//   })
// );


// router.post(
//   "/approve-inventory/:id",
//   catchAsyncErrors(async (req, res, next) => {
//     const job = await JobOrder.findById(req.params.id);
//     if (!job) return next(new ErrorHandler("Job not found", 404));

//     const warping = await Warping.create({
//       date: new Date(),
//       elasticOrdered: job.elastics,
//       job: job._id,
//     });

//     const covering = await Covering.create({
//       date: new Date(),
//       elasticOrdered: job.elastics,
//       job: job._id,
//     });

//     job.warping = warping._id;
//     job.covering = covering._id;
//     job.status = "warping&covering";

//     await job.save();

//     res.status(200).json({ success: true, job });
//   })
// );


// router.post(
//   "/warping/complete/:id",
//   catchAsyncErrors(async (req, res) => {
//     const warping = await Warping.findById(req.params.id);
//     warping.status = "closed";
//     warping.completedDate = new Date();
//     await warping.save();
//     res.json({ success: true });
//   })
// );

// router.post(
//   "/covering/complete/:id",
//   catchAsyncErrors(async (req, res) => {
//     const covering = await Covering.findById(req.params.id);
//     covering.status = "closed";
//     covering.completedDate = new Date();
//     await covering.save();
//     res.json({ success: true });
//   })
// );


// router.post(
//   "/weaving-plan",
//   catchAsyncErrors(async (req, res, next) => {
//     const { jobId, machineId, elastics } = req.body;

//     const job = await JobOrder.findById(jobId);
//     const machine = await Machine.findById(machineId);

//     if (!job || !machine) {
//       return next(new ErrorHandler("Invalid job or machine", 400));
//     }

//     job.machine = machineId;
//     job.status = "weaving";
//     await job.save();

//     machine.elastics = elastics;
//     machine.orderRunning = jobId;
//     machine.status = "running";
//     await machine.save();

//     res.status(200).json({ success: true });
//   })
// );


// router.post(
//   "/weaving-plan",
//   catchAsyncErrors(async (req, res, next) => {
//     const { jobId, machineId, elastics } = req.body;

//     const job = await JobOrder.findById(jobId);
//     const machine = await Machine.findById(machineId);

//     if (!job || !machine) {
//       return next(new ErrorHandler("Invalid job or machine", 400));
//     }

//     job.machine = machineId;
//     job.status = "weaving";
//     await job.save();

//     machine.elastics = elastics;
//     machine.orderRunning = jobId;
//     machine.status = "running";
//     await machine.save();

//     res.status(200).json({ success: true });
//   })
// );


// router.get(
//   "/running",
//   catchAsyncErrors(async (req, res) => {
//     const jobs = await JobOrder.find({
//       status: { $ne: "closed" },
//     });
//     res.status(200).json({ success: true, jobs });
//   })
// );

// router.post(
//   "/approve-inventory/:jobId",
//   // isAuthenticated,
//   catchAsyncErrors(async (req, res, next) => {
//     const { jobId } = req.params;

//     // 1️⃣ Fetch Job
//     const jobOrder = await JobOrder.findById(jobId);
//     if (!jobOrder) {
//       return next(new ErrorHandler("JobOrder not found", 404));
//     }

//     // 2️⃣ Prevent double approval
//     if (jobOrder.warping || jobOrder.covering) {
//       return next(
//         new ErrorHandler("Inventory already approved for this job", 409)
//       );
//     }

//     // 3️⃣ Create Warping
//     const warping = await Warping.create({
//       date: new Date(),
//       elasticOrdered: jobOrder.elastics,
//       job: jobOrder._id,
//     });

//     // 4️⃣ Create Covering
//     const covering = await Covering.create({
//       date: new Date(),
//       elasticOrdered: jobOrder.elastics,
//       job: jobOrder._id,
//     });

//     // 5️⃣ Update JobOrder
//     jobOrder.warping = warping._id;
//     jobOrder.covering = covering._id;
//     jobOrder.status = "warping&covering";

//     await jobOrder.save();

//     res.status(200).json({
//       success: true,
//       message: "Inventory approved successfully",
//       data: {
//         jobId: jobOrder._id,
//         warping: warping._id,
//         covering: covering._id,
//       },
//     });
//   })
// );

// router.post(
//   "/weaving/complete/:jobId",
//   catchAsyncErrors(async (req, res, next) => {
//     const job = await JobOrder.findById(req.params.jobId);
//     if (!job) return next(new ErrorHandler("Job not found", 404));

//     if (job.status !== "weaving") {
//       return next(
//         new ErrorHandler("Job is not in weaving stage", 400)
//       );
//     }

//     // Release machine
//     if (job.machine) {
//       const machine = await Machine.findById(job.machine);
//       if (machine) {
//         machine.status = "free";
//         machine.orderRunning = null;
//         await machine.save();
//       }
//     }

//     job.status = "finishing";
//     await job.save();

//     res.status(200).json({
//       success: true,
//       message: "Weaving completed",
//       jobId: job._id,
//     });
//   })
// );


// router.post(
//   "/finishing/complete/:jobId",
//   catchAsyncErrors(async (req, res, next) => {
//     const job = await JobOrder.findById(req.params.jobId);
//     if (!job) {
//       return next(new ErrorHandler("Job not found", 404));
//     }

//     if (job.status !== "finishing") {
//       return next(
//         new ErrorHandler("Job is not in finishing stage", 400)
//       );
//     }

//     job.status = "checking";
//     await job.save();

//     res.status(200).json({
//       success: true,
//       message: "Finishing completed, moved to checking",
//       jobId: job._id,
//     });
//   })
// );



// router.post(
//   "/checkingAssign",
//   // isAuthenticated,
//   catchAsyncErrors(async (req, res, next) => {
//     const { jobId, employeeId } = req.body;

//     if (!jobId || !employeeId) {
//       return next(
//         new ErrorHandler("jobId and employeeId are required", 400)
//       );
//     }

//     const job = await JobOrder.findById(jobId);
//     if (!job) {
//       return next(new ErrorHandler("JobOrder not found", 404));
//     }

//     // Optional: prevent reassignment
//     if (job.checking) {
//       return next(
//         new ErrorHandler("Checking already assigned for this job", 409)
//       );
//     }

//     const employee = await Employee.findById(employeeId);
//     if (!employee) {
//       return next(new ErrorHandler("Employee not found", 404));
//     }

//     // Optional: enforce department/role
//     if (employee.department !== "checking") {
//       return next(
//         new ErrorHandler("Employee is not from checking department", 400)
//       );
//     }

//     // Optional: enforce job state
//     if (!["finishing", "checking"].includes(job.status)) {
//       return next(
//         new ErrorHandler(
//           "Checking can be assigned only after finishing stage",
//           400
//         )
//       );
//     }

//     job.checking = employeeId;
//     job.status = "checking"; // normalize state transition
//     await job.save();

//     res.status(200).json({
//       success: true,
//       message: "Checking assigned successfully",
//       data: {
//         jobId: job._id,
//         checking: employeeId,
//       },
//     });
//   })
// );


// router.post(
//   "/checking/complete/:jobId",
//   catchAsyncErrors(async (req, res, next) => {
//     const job = await JobOrder.findById(req.params.jobId);
//     if (!job) {
//       return next(new ErrorHandler("Job not found", 404));
//     }

//     if (job.status !== "checking") {
//       return next(
//         new ErrorHandler("Job is not in checking stage", 400)
//       );
//     }

//     job.status = "packing";
//     await job.save();

//     res.status(200).json({
//       success: true,
//       message: "Checking completed, moved to packing",
//       jobId: job._id,
//     });
//   })
// );


// router.post(
//   "/packing/complete/:jobId",
//   catchAsyncErrors(async (req, res, next) => {
//     const job = await JobOrder.findById(req.params.jobId);
//     if (!job) {
//       return next(new ErrorHandler("Job not found", 404));
//     }

//     if (job.status !== "packing") {
//       return next(
//         new ErrorHandler("Job is not in packing stage", 400)
//       );
//     }

//     job.status = "closed";
//     await job.save();

//     res.status(200).json({
//       success: true,
//       message: "Packing completed, job closed",
//       jobId: job._id,
//     });
//   })
// );



// module.exports = router;

const express = require("express");
const router = express.Router();
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");

const JobOrder = require("../models/JobOrder");
const Order = require("../models/Order");
const Warping = require("../models/Warping");
const Covering = require("../models/Covering");
const Wastage = require("../models/Wastage");
const Packing = require("../models/Packing");

const Machine = require("../models/Machine.js");

/**
 * 🧾 CREATE JOB ORDER + PREPARATORY (WARPING & COVERING)
 */
router.post(
  "/create",
  catchAsyncErrors(async (req, res, next) => {


    try {
      const { orderId, date, elastics } = req.body;

      console.log("create JOb")

      if (!orderId || !date || !elastics?.length) {
        return next(new ErrorHandler("Invalid payload", 400));
      }

      const order = await Order.findById(orderId);
      if (!order) {
        return next(new ErrorHandler("Order not found", 404));
      }

      if (!["Open", "InProgress"].includes(order.status)) {
        return next(
          new ErrorHandler("Job cannot be created for this order status", 400)
        );
      }

      // 🔍 Validate against pending quantities
      for (const e of elastics) {
        const pending = order.pendingElastic.find(
          (p) => p.elastic.toString() === e.elastic
        );

        if (!pending || pending.quantity < e.quantity) {
          return next(
            new ErrorHandler(
              "Job quantity exceeds pending order quantity",
              400
            )
          );
        }
      }

      // 🔄 Initialize tracking arrays
      const zeroed = elastics.map((e) => ({
        elastic: e.elastic,
        quantity: 0,
      }));

      // 🧾 CREATE JOB ORDER
      const job = await JobOrder.create({
        date,
        order: order._id,
        customer: order.customer,
        status: "preparatory",
        elastics,
        producedElastic: zeroed,
        packedElastic: zeroed,
        wastageElastic: zeroed,
      });

      // 🧶 CREATE WARPING PROGRAM
      const warping = await Warping.create({
        date: Date.now(),
        job: job._id,
        elasticOrdered: elastics,
      });

      // 🧵 CREATE COVERING PROGRAM
      const covering = await Covering.create({
        date: Date.now(),
        job: job._id,
        elasticPlanned: elastics,
      });

      // 🔗 LINK PREPARATORY TO JOB
      job.warping = warping._id;
      job.covering = covering._id;
      await job.save();

      // 🔄 UPDATE ORDER
      order.jobs.push({
        job: job._id,
        no: job.jobOrderNo,
      });

      elastics.forEach((e) => {
        const pending = order.pendingElastic.find(
          (p) => p.elastic.toString() === e.elastic
        );
        pending.quantity -= e.quantity;
      });

      order.status = "InProgress";
      await order.save();


      console.log("Created job order with preparatory programs");



      res.status(201).json({
        success: true,
        message: "Job Order with preparatory programs created",
        job,
        warping,
        covering,
      });
    } catch (e) {
      console.error(e);
      return next(new ErrorHandler("Server Error", 500));
    }

  })
);


router.post(
  "/job-orders/assign-machine",
  catchAsyncErrors(async (req, res) => {
    const jobId = req.query.id;
    const { machineId } = req.body;

    const job = await JobOrder.findById(jobId);
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    if (job.status !== "weaving") {
      return res.status(400).json({
        message: "Job is not ready for weaving",
      });
    }

    if (job.machine) {
      return res.status(400).json({
        message: "Machine already assigned",
      });
    }

    const machine = await Machine.findById(machineId);
    if (!machine || machine.status !== "free") {
      return res.status(400).json({
        message: "Machine is not available",
      });
    }

    // 🔁 ASSIGN
    job.machine = machine._id;
    await job.save();

    machine.status = "running";
    machine.orderRunning = job._id;
    await machine.save();

    res.json({
      success: true,
      job,
      machine,
    });
  })
);

router.post("/update-status", async (req, res) => {
  try {
    const { jobId, nextStatus } = req.body;

    const job = await JobOrder.findById(jobId);

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const allowedTransitions = {
      weaving: "finishing",
      finishing: "checking",
      checking: "packing",
      packing: "completed",
    };


    console.log(`Attempting to transition job ${jobId} from ${job.status} to ${nextStatus}`);

    if (allowedTransitions[job.status] !== nextStatus) {
      return res.status(400).json({
        message: `Invalid transition from ${job.status} to ${nextStatus}`,
      });
    }

    job.status = nextStatus;

     

    await job.save();

    console.log(`Job ${jobId} status updated to ${nextStatus}`);

    res.json({
      success: true,
      job,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message });
  }
});





router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { id } = req.query;

      if (!id) {
        return next(new ErrorHandler("Job ID is required", 400));
      }

      const job = await JobOrder.findById(id)
        // 🧵 Elastics
        .populate("elastics.elastic", "name")
        .populate("producedElastic.elastic", "name")
        .populate("packedElastic.elastic", "name")
        .populate("wastageElastic.elastic", "name")

        // 🧶 Preparatory
        .populate({
          path: "warping",
          populate: {
            path: "elasticOrdered.elastic",
            select: "name",
          },
        })
        .populate({
          path: "covering",
          populate: {
            path: "elasticPlanned.elastic",
            select: "name",
          },
        })

        // 🏭 Machine
        .populate("machine")

        // ⏱ Shift details
        .populate({
          path: "shiftDetails",
          populate: {
            path: "employee",
            select: "name",
          },
        })

        // ♻️ Wastage
        .populate({
          path: "wastages",
          populate: [
            { path: "elastic", select: "name" },
            { path: "employee", select: "name" },
          ],
        })

        // 📦 Packing
        .populate({
          path: "packingDetails",
          populate: [
            { path: "elastic", select: "name" },
            { path: "packedBy", select: "name" },
            { path: "checkedBy", select: "name" },
          ],
        })
        .exec();

      if (!job) {
        return next(new ErrorHandler("Job not found", 404));
      }

      console.log("Fetched detailed job info", job);
      res.status(200).json({
        success: true,
        job,
      });
    } catch (error) {
      console.error(error);
      return next(new ErrorHandler("Server Error", 500));
    }
  })
);
router.post(
  "/plan-weaving",
  catchAsyncErrors(async (req, res, next) => {

    try {
      const { jobId, machineId, headElasticMap } = req.body;
      console.log(req.body);
      if (!jobId || !machineId || !headElasticMap) {
        return next(new ErrorHandler("Missing required fields", 400));
      }

      // 🔹 Fetch Job
      const job = await JobOrder.findById(jobId);
      console.log(job)
      if (!job) {
        return next(new ErrorHandler("JobOrder not found", 404));
      }

      if (job.status !== "preparatory") {
        return next(
          new ErrorHandler("Job is not ready for weaving", 400)
        );
      }

      // 🔹 Fetch Machine
      const machine = await Machine.findById(machineId);
      if (!machine) {

        return next(new ErrorHandler("Machine not found", 404));
      }

      if (machine.status !== "free") {
        return next(
          new ErrorHandler("Machine is already running another job", 400)
        );
      }

      // 🔹 Convert headElasticMap → array
      const elasticAssignments = Object.keys(headElasticMap).map((head) => ({
        head: Number(head) + 1, // human-readable head no
        elastic: headElasticMap[head],
      }));

      if (elasticAssignments.length === 0) {
        return next(
          new ErrorHandler("No elastics assigned to machine heads", 400)
        );
      }

      // 🔹 UPDATE MACHINE
      machine.status = "running";
      machine.orderRunning = job._id;
      machine.elastics = elasticAssignments;

      await machine.save();

      // 🔹 UPDATE JOB
      job.status = "weaving";
      job.machine = machine._id;

      await job.save();

      console.log("done")

      res.status(200).json({
        success: true,
        message: "Weaving planned successfully",
        job: {
          id: job._id,
          status: job.status,
        },
        machine: {
          id: machine._id,
          status: machine.status,
          elastics: machine.elastics,
        },
      });
    } catch (error) {
      console.log(error)
    }

  })
);



module.exports = router;
