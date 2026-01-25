const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");


const Employee = require("../models/Employee.js");
const Machine = require("../models/Machine.js");

const ShiftDetail = require("../models/ShiftDetail.js");
const ShiftPlan = require("../models/ShiftPlan.js");


const moment = require("moment");




router.post(
  "/create-shift",

  catchAsyncErrors(async (req, res, next) => {
    // console.log(req.body);
    const arr = [];
    try {

      const normalizedDate = new Date(req.body.date);
      console.log(req.body.date);
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
        shift: req.body.shift,
      });




      await Promise.all(Object.keys(req.body.plan).map(async (e) => {
        const machine = await Machine.findOne({ ID: e });
        console.log(machine);
        // console.log(req.body.plan[e]);
        const employee = await Employee.findById(req.body.plan[e]);

        const shiftDetail = await ShiftDetail.create({
          date: moment(normalizedDate),
          shift: req.body.shift,
          description: req.body.description,
          status: "open",
          machine: machine._id,
          employee: employee._id,
          shiftPlan: sp._id,
        });

        arr.push(shiftDetail._id);


      }))
      //  console.log(arr);

      sp.plan = arr;

      await sp.save();
      console.log(sp);
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


      return res.status(500).json({
        success: false,
        message: 'Unable to create shift plan',
        error: error.message
      });
    }



  })
);



router.get(
  "/shiftPlanToday",

  catchAsyncErrors(async (req, res, next) => {
    try {

      const now = new Date(req.query.date).setHours(0, 0, 0, 0);
const utc = new Date(now).toUTCString();
console.log(utc.toString()); // ignore the timezone
      const shift = await ShiftPlan.find({
        date: { $eq: new Date(new Date(utc)) },
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
  return d.getTime() + ( 5.5 * 60 * 60 * 1000 )
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

        const da=getISTTime(e.date);

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

    const shift = await ShiftDetail.findById(req.body.id);

    shift.production = req.body.production;
    shift.feedback = req.body.feedback;
    shift.status = "closed";
    shift.timer = req.body.timer;

    const machine = await Machine.findById(shift.machine);
    const emp = await Employee.findById(shift.employee);
    const sp = await ShiftPlan.findById(shift.shiftPlan);

    emp.shifts.push(shift._id);
    machine.shifts.push(shift._id);
    sp.totalProduction += req.body.production * machine.NoOfHead;


    await machine.save();
    await shift.save();
    await emp.save();
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

router.get(
  "/shiftDetail",

  catchAsyncErrors(async (req, res, next) => {
    try {


      const shift = await ShiftDetail.findById(req.query.id).populate('employee').populate('machine').exec();

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


module.exports = router;