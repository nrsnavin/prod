const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");


const Employee = require("../models/Employee.js");
const Machine = require("../models/Machine.js");
const Order = require("../models/Order.js");

const ShiftDetail = require("../models/ShiftDetail.js");
const ShiftPlan = require("../models/ShiftPlan.js");


const moment = require("moment");
const JobOrder = require("../models/JobOrder.js");




router.post(
  "/create-shift-plan",

  catchAsyncErrors(async (req, res, next) => {
    console.log(req.body);
    const arr = [];
    try {

      var normalizedDate = new Date(req.body.date);

      normalizedDate = normalizedDate.getTime();

      // console.log(normalizedDate);

      const check = await ShiftPlan.findOne({ date: normalizedDate, shift: req.body.shift });
      console.log(check);
      if (check !== null) {
        return res.status(409).json({
          success: false,
          message: `Shift plan already exists for ${req.body.shift} shift on selected date`
        });
      }


      const sp = await ShiftPlan.create({
        date: moment(normalizedDate),
        shift: req.body.shiftType,
      });





      await Promise.all(req.body.machines.map(async (e) => {
        const machine = await Machine.findById(e.machine);
        // console.log(machine);
        // console.log(req.body.plan[e]);
        const employee = await Employee.findById(e.operator);

        const job = await JobOrder.findOne({ jobOrderNo: e.jobOrderNo });

        const shiftDetail = await ShiftDetail.create({
          date: moment(normalizedDate),
          shift: req.body.shiftType,
          description: req.body.description,
          status: "open",
          machine: machine._id,
          employee: employee._id,
          shiftPlan: sp._id,
          elastics: machine.elastics,
        });
        arr.push(shiftDetail._id);
        machine.shifts.push(shiftDetail._id);
        employee.shifts.push(shiftDetail._id);
        job.shiftDetails.push(shiftDetail._id)
        await machine.save();
        await employee.save();

        await job.save();


      }))
      //  console.log(arr);

      sp.plan = arr;

      await sp.save();
      console.log(" Shift Plan created successfully");
      res.status(201).json({
        success: true,
        message: "Shifts created successfully",
        sp
      });
    } catch (error) {
      if (error.code === 11000) {
        console.log("Duplicate key error:", error.keyValue);
        return res.status(409).json({
          success: false,
          message: `Shift plan already exists for ${req.body.shiftType} shift on selected date`
        });
      }
      console.log(error);

      return res.status(500).json({
        success: false,
        message: 'Unable to create shift plan',
        error: error.message
      });
    }



  })
);


router.delete('/deletePlan', catchAsyncErrors(async (req, res, next) => {
  try {

    const sp = await ShiftPlan.findById(req.query.id);
    if (!sp) {
      return next(new ErrorHandler('Shift Plan not found', 404));
    }
    await Promise.all(sp.plan.map(async (e) => {
      const sd = await ShiftDetail.findById(e);
      const machine = await Machine.findById(sd.machine);
      const emp = await Employee.findById(sd.employee);

      machine.shifts = machine.shifts.filter((id) => id.toString() !== sd._id.toString());
      emp.shifts = emp.shifts.filter((id) => id.toString() !== sd._id.toString());
      await machine.save();
      await emp.save();
      await ShiftDetail.findByIdAndDelete(e);
    }))

    await ShiftPlan.findByIdAndDelete(req.query.id);

    res.status(200).json({
      success: true,
      message: 'Shift Plan deleted successfully'
    });

  }
  catch (error) {
    console.log(error);
    return next(new ErrorHandler(error, 400));
  }
}));

router.get(
  "/shiftPlanToday",

  catchAsyncErrors(async (req, res, next) => {
    try {

      console.log(new Date(new Date(req.query.date).setHours(0, 0, 0, 0) + (5.5 * 60 * 60 * 1000)));
      // ignore the timezone
      const shift = await ShiftPlan.find({
        date: { $eq: new Date(new Date(req.query.date).setHours(0, 0, 0, 0)) },
      }).populate({
        path: 'plan',
        populate: [{ path: 'employee', model: 'Employee' }, { path: 'machine', model: 'Machine' }]
      }).exec();

      console.log(shift);

      console.log(req.query.date);
      res.status(201).json({
        success: true,
        shift,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);


router.get("/today", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const plans = await ShiftPlan.find({
      date: { $gte: today, $lt: tomorrow },
    })
      .populate({
        path: "plan",
        populate: [
          { path: "machine" },
          { path: "employee" },
        ],
      })
      .lean();

    const getShiftData = (shiftType) => {
      const shift =
        plans.find((p) => p.shift === shiftType) || null;

      if (!shift) {
        return {
          id: "test",
          shift: shiftType,
          production: 0,
          machinesRunning: 0,
          operatorCount: 0,
          status: "open",
          plan: [],
        };
      }

      const production = shift.plan.reduce(
        (sum, detail) => sum + (detail.production || 0),
        0
      );

      const uniqueOperators = new Set(
        shift.plan.map((d) =>
          d.employee ? d.employee._id.toString() : null
        )
      );

      return {
        ...shift,
        production,
        machinesRunning: shift.plan.length,
        operatorCount: uniqueOperators.size,
      };
    };

    res.status(200).json({
      success: true,
      data: {
        dayShift: getShiftData("DAY"),
        nightShift: getShiftData("NIGHT"),
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});



router.get(
  "/shiftPlanById", async (req, res) => {
    try {
      const { id } = req.query;
      console.log(id);

      const shiftPlan = await ShiftPlan.findById(id)
        .populate({
          path: "plan",
          populate: [
            {
              path: "machine",
              model: "Machine",
            },
            {
              path: "employee",
              model: "Employee",
            },
          ],
        });

      if (!shiftPlan) {
        return res.status(404).json({
          success: false,
          message: "Shift Plan not found",
        });
      }

      let totalProduction = 0;

      const machines = await Promise.all(
        shiftPlan.plan.map(async (detail) => {
          totalProduction += detail.production || 0;

          // Fetch Job from Machine
          const machine = await Machine.findById(detail.machine._id)
            .populate("orderRunning");

          let jobOrderNo = "";

          if (machine && machine.orderRunning) {
            const job = await JobOrder.findById(machine.orderRunning);
            jobOrderNo = job ? job.jobOrderNo.toString() : "";
          }

          return {
            machineId: detail.machine._id,
            machineName: detail.machine.ID || detail.machine.manufacturer + " " + detail.machine.ID,
            jobOrderNo,
            operatorName: detail.employee.name,
            production: detail.production,
            timer: detail.timer,
            status: detail.status,
          };
        })
      );

      const operatorCount = shiftPlan.plan.length;

      res.status(200).json({
        success: true,
        data: {
          _id: shiftPlan._id,
          date: shiftPlan.date,
          shift: shiftPlan.shift,
          description: shiftPlan.description,
          totalProduction,
          operatorCount,
          machines,
        },
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: "Server Error",
      });
    }
  });

router.get(
  "/shiftPLan",

  catchAsyncErrors(async (req, res, next) => {
    try {
      const shift = await ShiftPlan.findById(req.query.id).populate({
        path: 'plan',
        populate: [{ path: 'employee', model: 'Employee' }, { path: 'machine', model: 'Machine' }]
      }).exec();

      res.status(201).json({
        success: true,
        shift,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);



const getISTTime = (e) => {
  let d = new Date(e)
  return d.getTime() + (5.5 * 60 * 60 * 1000)
}
router.get(
  "/get-in-range",
  catchAsyncErrors(async (req, res, next) => {
    try {
      console.log(req.query.start);
      console.log(req.query.less);
      const shifts = await ShiftPlan.find(
        { date: { $gte: moment(req.query.start, "YYYY-MM-DD"), $lte: moment(req.query.less, "YYYY-MM-DD") } }
      )


      var p = new Map();
      console.log(shifts);

      shifts.forEach(((e) => {

        const da = getISTTime(e.date);

        const date = new Date(da).toISOString().slice(0, 10).split('-').reverse().join('-');
        if (p.get(date) != null) {

          p.set(date, p.get(date) + e.totalProduction);
        }

        else {


          p.set(date, e.totalProduction)
        }

      }));

      let array = Array.from(p, ([date, production]) => ({ date, production }));

      console.log(array);

      res.status(201).json({
        array,
        success: true,

      });

    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  })
);


router.post('/enter-shift-production', catchAsyncErrors(async (req, res, next) => {
  try {

    // const shift = await ShiftDetail.findById(req.body.id);

    console.log(req.body);
    const shift = await ShiftDetail.findById(req.body.id)
      .populate("machine")
      .populate({
        path: "machine",
        populate: {
          path: "orderRunning",
        },
      });

    const machine = await Machine.findById(shift.machine);
    const sp = await ShiftPlan.findById(shift.shiftPlan);


    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

    const jobId = shift.machine.orderRunning._id;

    const job = await JobOrder.findById(jobId);

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    const elasticProductionMap = {};

    for (const head of shift.machine.elastics) {
      const id = head.elastic.toString();

      if (!elasticProductionMap[id]) {
        elasticProductionMap[id] = 0;
      }

      elasticProductionMap[id] += req.body.production;
    }

    for (const elasticId in elasticProductionMap) {
      const index = job.producedElastic.findIndex(
        (e) => e.elastic.toString() === elasticId
      );

      if (index >= 0) {
        job.producedElastic[index].quantity += elasticProductionMap[elasticId];
      } else {
        job.producedElastic.push({
          elastic: elasticId,
          quantity: elasticProductionMap[elasticId],
        });
      }
    }



    job.elastics.forEach((e, index) => {
      const produced = job.producedElastic[index].quantity;
      const planned = e.quantity;

      const pending = planned - produced;
      if (pending < 0) job.producedElastic[index].quantity = planned;
    });


    console.log(job);

    await job.save();

    // 📦 Also Update Order Pending
    const order = await Order.findById(job.order);

    job.producedElastic.forEach((p) => {
      const orderItem = order.producedElastic.find(
        (o) => o.elastic.toString() === p.elastic.toString()
      );

      if (orderItem) {
        orderItem.quantity += p.quantity;
      }
    });

    order.pendingElastic.forEach((p) => {
      const produced = order.producedElastic.find(
        (o) => o.elastic.toString() === p.elastic.toString()
      );

      if (produced) {
        p.quantity =
          order.elasticOrdered.find(
            (e) => e.elastic.toString() === p.elastic.toString()
          ).quantity - produced.quantity;
      }
    });

    console.log(order);

    await order.save();


    shift.productionMeters = req.body.production;
    shift.feedback = req.body.feedback;
    shift.status = "closed";

    shift.timer = req.body.timer;

    await shift.save();

    console.log(shift);



    sp.totalProduction += req.body.production * machine.NoOfHead;


    await shift.save();
    await sp.save();


    res.status(201).json({
      success: true,
      shift,
    });


  } catch (error) {
    console.log(error);
    return next(new ErrorHandler(error, 400));
  }
})
)


router.post("/job/update-status", async (req, res) => {
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

    if (allowedTransitions[job.status] !== nextStatus) {
      return res.status(400).json({
        message: `Invalid transition from ${job.status} to ${nextStatus}`,
      });
    }

    job.status = nextStatus;

    await job.save();

    res.json({
      success: true,
      job,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});




router.get(
  "/all-open-shifts",

  catchAsyncErrors(async (req, res, next) => {
    try {

      const shifts = await ShiftDetail.find({ status: 'open' }).populate('employee').populate('machine').populate('job').exec();

      res.status(201).json({
        success: true,
        shifts,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);

router.post("/update", async (req, res) => {
  const { shiftId, production, timer, feedback } = req.body;

  const shift = await ShiftDetail.findById(shiftId);

  shift.production = production;
  shift.timer = timer;
  shift.feedback = feedback;
  shift.status = "closed";

  await shift.save();

  res.json({ success: true, shift });
});


router.get("/open", async (req, res) => {
  const shifts = await ShiftDetail.find({
    status: "open",
  })
    .populate("employee")
    .populate({
      path: "machine",
      populate: {
        path: "orderRunning",
      },
    })
    .sort({ date: -1 });

  res.json({ success: true, shifts });
});


router.get(
  "/shiftDetail",

  catchAsyncErrors(async (req, res, next) => {
    try {

      console.log(req.query.id)


      const shift = await ShiftDetail.findById(req.query.id).populate('employee').populate({ path: 'elastics', populate: { path: 'elastic' } }).populate({
        path: "machine",
        populate: {
          path: "orderRunning",
        },

      }).exec();

      res.status(201).json({
        success: true,
        shift,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);




router.get(
  "/employee-open-shifts",

  catchAsyncErrors(async (req, res, next) => {
    try {

      const shifts = await ShiftDetail.find({ status: 'open', employee: req.query.id }).populate('employee').populate('machine').populate('job').exec();

      res.status(201).json({
        success: true,
        shifts,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);


router.get(
  "/employee-closed-shifts",

  catchAsyncErrors(async (req, res, next) => {
    try {

      const shifts = await ShiftDetail.find({ status: 'closed', employee: req.query.id }).sort({ createdAt: -1 }).limit(30).populate('employee').populate('machine').populate('job').exec();

      res.status(201).json({
        success: true,
        shifts,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);


router.get(
  "/shiftPlanOnDate",

  catchAsyncErrors(async (req, res, next) => {
    try {
      const shift = await ShiftPlan.find(
        { date: { $gte: moment(req.query.date, "DD-MM-YYYY"), $lt: moment(req.query.date, "DD-MM-YYYY").add(1, 'days') } }
      ).populate({
        path: 'plan',
        populate: [{ path: 'employee', model: 'Employee' }, { path: 'machine', model: 'Machine' }]
      }).exec();

      console.log(shift);

      res.status(201).json({
        success: true,
        shift,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);




/**
 * ✅ CREATE SHIFT DETAIL (Assign Operator + Machine)
 */



module.exports = router;