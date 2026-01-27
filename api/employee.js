const express = require("express");

const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const Employee = require("../models/Employee.js");
const e = require("express");

const router = express.Router();



router.post(
    "/login-employee",
    catchAsyncErrors(async (req, res, next) => {
        try {
            const { userName, password } = req.body;

            console.log(password);


            if (!userName || !password) {
                return next(new ErrorHandler("Please provide the all fields!", 400));
            }

            const employee = await Employee.findOne({ userName }).select("+password");





            if (!employee) {
                return next(new ErrorHandler("User doesn't exists!", 400));
            }
            if (employee.password == password) {
                //   const token = generateToken(employee);

                //   console.log(token);


                res
                    .status(201)
                    .json({
                        username: employee.name,
                        id: employee._id,
                        role: employee.role,
                        skill: employee.skill,
                        Department: employee.Department,

                        //   token: token,

                    });
            } else {
                res.status(401).json({ message: "Invalid Credentials" });
            }
        }

        catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
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




module.exports = router;