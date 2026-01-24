const express = require("express");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const Production = require("../models/Production.js");
const Machine = require("../models/Machine.js");
const moment = require("moment");





router.get(
    "/get-in-range",
    catchAsyncErrors(async (req, res, next) => {
        try {

            const production = await Production.find(
                { date: { $gte: moment(req.query.start, "YYYY-MM-DD"), $lte: moment(req.query.less, "YYYY-MM-DD").add('days', 1) } }
            )


            var p = new Map();

            production.forEach(((e) => {

                const date = new Date(e.date).toISOString().slice(0, 10).split('-').reverse().join('-');
                if (p.get(date) != null) {

                    p.set(date, p.get(date) + e.production);
                }

                else {


                    p.set(date, e.production)
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


router.get(
    "/get-in-date",
    catchAsyncErrors(async (req, res, next) => {
        try {

            const production = await Production.find(
                { date: { $gte: moment(req.query.date, "DD-MM-YYYY"), $lt: moment(req.query.date, "DD-MM-YYYY").add(1, 'days') } }
            ).populate('machine').populate('employee').populate('order').exec()

            console.log(production);


            res.status(201).json({
                production,
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

            const production = await Production.find(
                { employee: req.query.id }
            ).sort({ createdAt: -1 }).limit(30).populate('machine').populate('employee').populate('order').exec()

            console.log(production);


            res.status(201).json({
                production,
                success: true,

            });

        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.get(
    "/get-productionDetail",
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