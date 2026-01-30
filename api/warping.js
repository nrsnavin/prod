const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const RawMaterial = require("../models/RawMaterial.js");
const ErrorHandler = require("../utils/ErrorHandler");
const Warping = require("../models/Warping.js");
const Employee = require("../models/Employee.js");

router.get(
    "/get-open-warping",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const warping = await Warping.find({ status: 'open' }).populate('job').exec();
            res.status(200).json({
                success: true,
                warping,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);
router.get(
    "/get-closed-warping",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const warping = await Warping.find({ status: 'closed' }).populate('job').exec();
            res.status(200).json({
                success: true,
                warping,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.get(
    "/get-warping-detail",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const warping = await Warping.findById(req.query.id).populate('job').populate('elasticOrdered.id').populate('closedBy').exec();
            res.status(200).json({
                success: true,
                warping,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.post(
    "/warping-completed",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const warping = await Warping.findById(req.body.id);

            warping.status = "closed";
            warping.closedBy = req.body.closedBy;

            warping.completedDate = Date.now();

            await warping.save();

            res.status(201).json({
                success: true,
                warping,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


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
            if (employee.password == password && employee.Department == "warping") {
                //   const token = generateToken(employee);

                //   console.log(token);



                res
                    .status(201)
                    .json({
                        username: employee.name,
                        id: employee._id,
                        role: employee.role,
                        totalWastage: employee.totalWastage,
                        totalProduction: employee.totalProduction,
                        skill: employee.skill,
                        Department: employee.Department,
                        aadhar: employee.aadhar,
                        totalShifts: employee.totalShifts,

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

module.exports = router;