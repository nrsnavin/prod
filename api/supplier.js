const express = require("express");
const router = express.Router();

const Supplier = require("../models/Supplier");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");


router.post(
    "/create-supplier",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.create(req.body);

            res.status(201).json({
                success: true,
                supplier,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 400));
        }
    })
);


router.get(
    "/get-suppliers",
    catchAsyncErrors(async (req, res, next) => {
        try {
            console.log("Fetching suppliers with query:", req.query);
            const page = Number(req.query.page) || 1;
            const limit = Number(req.query.limit) || 20;
            const skip = (page - 1) * limit;

            const keyword = req.query.search
                ? {
                    name: { $regex: req.query.search, $options: "i" },
                }
                : {};

            const suppliers = await Supplier.find(keyword)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit);

            const total = await Supplier.countDocuments(keyword);

            console.log("Total suppliers:", total);

            res.status(200).json({
                success: true,
                suppliers,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.get(
    "/get-supplier-detail",
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.findById(req.query.id);

            if (!supplier) {
                return next(new ErrorHandler("Supplier not found", 404));
            }

            res.status(200).json({
                success: true,
                supplier,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 500));
        }
    })
);


router.put(
    "/edit-supplier",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.findByIdAndUpdate(
                req.body._id,
                req.body,
                { new: true }
            );

            if (!supplier) {
                return next(new ErrorHandler("Supplier not found", 404));
            }

            res.status(200).json({
                success: true,
                supplier,
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 400));
        }
    })
);


router.delete(
    "/delete-supplier",
    // isAuthenticated,
    catchAsyncErrors(async (req, res, next) => {
        try {
            const supplier = await Supplier.findById(req.query.id);

            if (!supplier) {
                return next(new ErrorHandler("Supplier not found", 404));
            }

            supplier.isActive = false;
            await supplier.save();

            res.status(200).json({
                success: true,
                message: "Supplier deleted successfully",
            });
        } catch (error) {
            return next(new ErrorHandler(error.message, 400));
        }
    })
);



module.exports = router;




