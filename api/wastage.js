const express = require("express");
const User = require("../models/User.js");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const sendToken = require("../utils/jwtToken.js");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const Wastage = require("../models/Wastage.js");
const JobOrder = require("../models/JobOrder.js");
const Employee = require("../models/Employee.js");
const moment = require("moment");





router.post(
    "/add-wastage",
    catchAsyncErrors(async (req, res, next) => {
        try {
            const wastage = await Wastage.create(req.body);
            const job = await JobOrder.findById(req.body.job);
            const emp = await Employee.findById(req.body.employee);

            const i = job.wastageElastic.findIndex((x) => x.id.toString() == req.body.elastic.toString());

            job.wastageElastic[i].quantity += req.body.quantity;
            job.wastages.push(wastage._id);

            emp.wastages.push(wastage._id)
            emp.totalWastage += req.body.quantity;

            emp.performance = emp.totalWastage / emp.totalProduction;


            await job.save();

            await emp.save();
            res.status(201).json({
                job,
                emp,
                success: true,

            });

        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);



router.get(
    "/get-in-range",
    catchAsyncErrors(async (req, res, next) => {
        try {

            const wastage = await Wastage.find(
                { createdAt: { $gte: moment(req.query.start, "YYYY-MM-DD"), $lte: moment(req.query.less, "YYYY-MM-DD").add(1, 'days') } }
            )


            var p = new Map();

            wastage.forEach(((e) => {

                const date = new Date(e.createdAt).toISOString().slice(0, 10).split('-').reverse().join('-');
                if (p.get(date) != null) {

                    p.set(date, p.get(date) + e.quantity);
                }

                else {


                    p.set(date, e.quantity)
                }

            }));

            let array = Array.from(p, ([date, quantity]) => ({ date, quantity }));

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

router.get(
    "/get-in-date",
    catchAsyncErrors(async (req, res, next) => {
        try {

            const wastage = await Wastage.find(
                { createdAt: { $gte: moment(req.query.date, "DD-MM-YYYY"), $lt: moment(req.query.date, "DD-MM-YYYY").add(1, 'days') } }
            ).populate('elastic').populate('job').populate('employee').exec()



            res.status(201).json({
                wastage,
                success: true,

            });

        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);



router.get(
    "/get-by-employee",
    catchAsyncErrors(async (req, res, next) => {
        try {

            const wastage = await Wastage.find(
                { employee: req.query.id }
            )
            .sort({createdAt:-1}).limit(30)
            .populate('elastic').populate('job').populate('employee').exec()



            res.status(201).json({
                wastage,
                success: true,

            });

        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);



router.get(
    "/get-wastageDetail",
    catchAsyncErrors(async (req, res, next) => {
        try {

            const production = await Production.findById(req.query.id).populate('employee').populate('order').exec();




            const machine = await Machine.findById(production.machine).populate('elastics').exec();

            res.status(201).json({
                data: { ...production._doc, machine },
                success: true,


            });

        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);

module.exports = router;