"use strict";
// ══════════════════════════════════════════════════════════════════
//  SUPPLIERS' PRICE LISTS AND QUOTATIONS (services/priceLists.js)
//
//    POST  /price-lists/read         a price list or quotation → its lines,
//                                    each put against one of our materials
//    POST  /price-lists              the confirmed rates saved as the live ones
//    GET   /price-lists?supplier=    a supplier's live rates
//    POST  /price-lists/check        PO or bill lines above the live rate
//
//  Mounted twice: under /api/v2/accounts (api/accountsPapers.js) and under
//  /api/v2/supplier (api/supplier.js). The buyer who raises the purchase
//  order is the one who reads the supplier's quotation and wants the flag
//  on the PO, and may hold Suppliers or Purchase orders without Accounts;
//  each mount's own feature gate decides who gets in. Both mounts sit
//  behind isAuthenticated already.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { keepRequestContext } = require("../middleware/userContext");
const { paperUpload, pagesOf, readFailure } = require("../utils/paperUpload");
const mongoose = require("mongoose");

const router = express.Router();
const isId = (v) => mongoose.isValidObjectId(String(v || ""));

router.post("/price-lists/read", keepRequestContext(paperUpload.array("files", 4)), catchAsyncErrors(async (req, res, next) => {
  const pages = pagesOf(req);
  if (!pages.length) return next(new ErrorHandler("Attach the price list or quotation: a photo or a PDF", 400));
  try { res.json({ success: true, ...(await require("../services/priceLists").fromPhoto({ pages, supplier: isId(req.body?.supplier) ? req.body.supplier : null })) }); }
  catch (err) { return readFailure(err, "price lists", next); }
}));

router.post("/price-lists", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  try { res.status(201).json({ success: true, ...(await require("../services/priceLists").save({ ...b, by: req.user?._id })) }); }
  catch (err) { if (err.status) return next(new ErrorHandler(err.message, err.status)); throw err; }
}));

router.get("/price-lists", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.query.supplier)) return next(new ErrorHandler("supplier is required", 400));
  res.json({ success: true, rates: await require("../services/priceLists").list(req.query.supplier) });
}));

router.post("/price-lists/check", catchAsyncErrors(async (req, res) => {
  res.json({ success: true, flags: await require("../services/priceLists").flags({ supplier: req.body?.supplier, lines: req.body?.lines }) });
}));

module.exports = router;
