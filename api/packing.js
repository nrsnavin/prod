const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const router = express.Router();
const RawMaterial = require("../models/RawMaterial.js");
const ErrorHandler = require("../utils/ErrorHandler");
const Warping = require("../models/Warping.js");
const Employee = require("../models/Employee.js");
const Packing = require("../models/Packing.js");
const JobOrder = require("../models/JobOrder.js");
const Customer = require("../models/Customer.js");
const Order = require("../models/Order.js");


router.post(
    "/add-packing",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const job = await JobOrder.findOne({ jobOrderNo: parseInt(req.body.job) });
            const packing = await Packing.create(
                {
                    checkedBy: req.body.checkedBy,
                    date: req.body.date,
                    elastic: req.body.elastic,
                    packedBy: req.body.packedBy,
                    quantity: req.body.quantity,
                    noOfJoints: req.body.noOfJoints,
                    weight: req.body.weight,
                    job: job._id,
                }
            );


            const i = job.packedElastic.findIndex((e) => e.id == req.body.elastic)

            job.packedElastic[i].quantity += req.body.quantity;


            job.packingDetails.push(packing._id);



            await job.save();



            res.status(201).json({
                success: true,
                packing,
            });
        } catch (error) {
            console.log(error.message);

            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.post(
    "/login",
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
            if (employee.password == password && employee.Department == "packing") {
                //   const token = generateToken(employee);

                //   console.log(token);
                console.log(employee);



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


router.get(
    "/get-packing",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const packing = await Packing.find().populate("elastic").sort({
                createdAt: -1,
            }).exec();
            res.status(201).json({
                success: true,
                packing,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.get(
    "/get-packing-detail",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const packing = await Packing.findById(req.query.id)
            .populate("elastic")
            .populate('checkedBy')
            .populate('packedBy')
            .populate('job').exec();



            res.status(201).json({
                success: true,
                packing,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);



module.exports = router;