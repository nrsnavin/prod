const express = require("express");

const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const Employee = require("../models/Employee.js");
const e = require("express");

const bcrypt = require("bcryptjs");

const ErrorHandler = require("../utils/ErrorHandler");

const router = express.Router();


router.post(
  "/login",
  catchAsyncErrors(async (req, res, next) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return next(new ErrorHandler("Username and password required", 400));
    }

    const employee = await Employee.findOne({ username })
      .select("+passwordHash");

    if (!employee) {
      return next(new ErrorHandler("Invalid credentials", 401));
    }

    if (!employee.isActive) {
      return next(new ErrorHandler("Account disabled", 403));
    }

    const isMatch = await bcrypt.compare(
      password,
      employee.passwordHash
    );

    if (!isMatch) {
      return next(new ErrorHandler("Invalid credentials", 401));
    }

    employee.lastLogin = new Date();
    await employee.save();

    res.status(200).json({
      success: true,
      data: {
        id: employee._id,
        name: employee.name,
        role: employee.role,
        department: employee.department,
        skill: employee.skill,
        performance: employee.performance,
        phoneNumber: employee.phoneNumber,
        aadhar: employee.aadhar,
      },
    });
  })
);

// create product
router.post(
    "/create-employee",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            console.log(req.body);
            const employee = await Employee.create(req.body);

            console.log(employee);

            res.status(201).json({
                success: true,
                employee,
            });
        } catch (error) {
            console.log(error);
            return next(new ErrorHandler(error, 400));
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
    "/get-employee-detail",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const employee = await Employee.findOne({ _id: req.query.id })
                .populate({
                    path: 'shifts',
                    populate: [{ path: 'machine', model: 'Machine' }],
                    options: {
                        limit: 30,
                        sort: { created: -1 },
                    }

                }).exec();


            const result = employee.shifts.map(shift => {
                
                return {
                    id: shift._id,
                    date: shift.date,
                    shift: shift.shift,
                    description: shift.description,
                    feedback: shift.feedback,
                    machine: shift.machine.ID,
                    runtimeMinutes: parseClockTimeToMinutes(shift.timer),
                    outputMeters: shift.production,
                    efficiency: (parseClockTimeToMinutes(shift.timer) / 720) * 100
                };
            });
            console.log(result);
            res.status(201).json({
                success: true,
                employee:{
                    id: employee._id,
                    name: employee.name,
                    role: employee.role,
                    aadhar: employee.aadhar,
                    department: employee.department,
                    result: result,
                    phoneNumber: employee.phoneNumber,
                },
            });
        } catch (error) {
            console.log(error);
            return next(new ErrorHandler(error, 400));
        }
    })
);

router.get(
    "/get-employee-weave",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const employees = await Employee.find({ 'department': 'weaving' }).sort({
                createdAt: -1,
            });
            res.status(201).json({
                success: true,
                employees,
            });
        } catch (error) {
            console.log(error);
            return next(new ErrorHandler(error, 400));
        }
    })
);


router.get(
    "/get-employees",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const employees = await Employee.find().sort({
                createdAt: -1,
            });
            res.status(201).json({
                success: true,
                employees,
            });
        } catch (error) {
            console.log(error);
            return next(new ErrorHandler(error, 400));
        }
    })
);


router.put(
  "/disable/:id",
  catchAsyncErrors(async (req, res, next) => {
    const employee = await Employee.findById(req.params.id);

    if (!employee) {
      return next(new ErrorHandler("Employee not found", 404));
    }

    employee.isActive = false;
    await employee.save();

    res.status(200).json({
      success: true,
      message: "Employee disabled successfully",
    });
  })
);




module.exports = router;