"use strict";

// ══════════════════════════════════════════════════════════════
//  SETTINGS API  —  /api/v2/settings
//
//  Document/branding settings that drive every generated PDF.
//    GET  /settings/document   any authenticated user (the PDF layer
//                              and the Settings page read it)
//    PUT  /settings/document   admin only — updates the singleton and
//                              invalidates the service cache
// ══════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const DocumentSettings = require("../models/DocumentSettings");
const { getDocumentSettings, invalidate } = require("../services/documentSettings");

// Whitelist of client-editable fields — never trust req.body wholesale
// (blocks setting `key`, timestamps, or arbitrary props).
const EDITABLE = [
  "companyName", "tagline", "addressLines", "gstin", "phone", "email",
  "website", "footerNote", "termsText", "accentColor", "logo",
];

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

router.get(
  "/document",
  isAuthenticated,
  catchAsyncErrors(async (_req, res) => {
    const settings = await getDocumentSettings();
    res.status(200).json({ success: true, settings });
  })
);

router.put(
  "/document",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const update = {};
    for (const field of EDITABLE) {
      if (req.body[field] === undefined) continue;
      update[field] = req.body[field];
    }

    // Light validation on the two structured fields.
    if (update.accentColor !== undefined && update.accentColor !== "" && !HEX.test(String(update.accentColor))) {
      return next(new ErrorHandler("accentColor must be a hex colour like #1D6FEB", 400));
    }
    if (update.addressLines !== undefined) {
      if (!Array.isArray(update.addressLines)) {
        return next(new ErrorHandler("addressLines must be an array of strings", 400));
      }
      update.addressLines = update.addressLines.map((l) => String(l)).slice(0, 6);
    }
    if (update.logo !== undefined && update.logo && !/^data:image\/(png|jpe?g|webp);base64,/.test(String(update.logo))) {
      return next(new ErrorHandler("logo must be a PNG/JPEG/WebP data URL", 400));
    }

    const settings = await DocumentSettings.findOneAndUpdate(
      { key: "document" },
      { $set: update, $setOnInsert: { key: "document" } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    invalidate(); // PDF layer picks up the change on its next render

    res.status(200).json({ success: true, settings });
  })
);

module.exports = router;
