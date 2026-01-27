const express = require("express");
const { isAuthenticated,isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const Machine = require("../models/Machine.js");




router.post(
  "/create-machine",
  
  catchAsyncErrors(async (req, res, next) => {
    try {
      console.log(req.body)
      const machineData = req.body;
      const machine = await Machine.create(machineData);
      res.status(201).json({
        success: true,
        machine,
      });
    } catch (error) {
      console.log(error);
      return next(new ErrorHandler(error, 400));
    }
  })
);

router.get(
    "/get-machines",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
      try {
        const machines = await Machine.find();
      console.log(machines)
        res.status(201).json({
          success: true,
          machines,
        });
      } catch (error) {
        return next(new ErrorHandler(error.message, 500));
      }
    })
  );


  router.put(
    "/updateOrder",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
      try {
        const machines = await Machine.findOne({ID:req.body.id});
        machines.elastics=req.body.elastics;
        await machines.save();
      console.log("machines updated")
        res.status(201).json({
          success: true,
          data:machines._id
        });
      } catch (error) {
        return next(new ErrorHandler(error.message, 500));
      }
    })
  );


function parseClockTimeToMinutes(timeStr) {
    if (!timeStr) return 0;

    const parts = timeStr.split(':').map(Number);

    const hours = parts[0] || 0;
    const minutes = parts[1] || 0;

    return hours * 60 + minutes;
}


  router.get(
      "/get-machine-detail",
      // isAuthenticated,
      catchAsyncErrors(async (req, res, next) => {
          try {
              const machine = await Machine.findOne({ _id: req.query.id })
                  .populate({
                      path: 'shifts',
                      populate: [{ path: 'employee', model: 'Employee' }],
                      options: {
                          limit: 20,
                          sort: { created: -1 },
                      }
  
                  }).exec();
  
  
              const result = machine.shifts.map(shift => {
                  
                  return {
                      id: shift._id,
                      date: shift.date,
                      shift: shift.shift,
                      description: shift.description,
                      feedback: shift.feedback,
                      employee: shift.employee.name,
                      runtimeMinutes: parseClockTimeToMinutes(shift.timer),
                      outputMeters: shift.production,
                      efficiency: (parseClockTimeToMinutes(shift.timer) / 720) * 100
                  };
              });
              console.log(result);
              res.status(201).json({
                  success: true,
                  machine:{
                      id: machine.ID,
                      status: machine.status,
                      elastics: machine.elastics,
                      manufacturer: machine.manufacturer,
                      result: result,
                      heads: machine.NoOfHead,
                      hooks: machine.NoOfHooks,
                  },
              });
          } catch (error) {
              console.log(error);
              return next(new ErrorHandler(error, 400));
          }
      })
  );
  
module.exports=router
