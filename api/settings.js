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

// ── Invoice settings ──────────────────────────────────────────
// Sent as a nested `invoice` object and written as dot-paths, so a save
// of the HSN cannot wipe the bank details, and the GSP secrets are only
// touched when a new value is typed (a blank secret means "keep it").
const INVOICE_TEXT = {
  "invoice.defaultHsn": 8, "invoice.city": 60, "invoice.pincode": 6, "invoice.stateCode": 2,
  "invoice.bank.name": 80, "invoice.bank.account": 30, "invoice.bank.ifsc": 11, "invoice.bank.branch": 80, "invoice.bank.upiId": 60,
  "invoice.declaration": 500,
  "invoice.gsp.provider": 40, "invoice.gsp.baseUrl": 200, "invoice.gsp.username": 120, "invoice.gsp.clientId": 120,
};
const INVOICE_SECRETS = { "invoice.gsp.clientSecret": 300, "invoice.gsp.password": 120 };

function readInvoiceSettings(body) {
  const inv = body.invoice;
  if (inv === undefined) return {};
  if (!inv || typeof inv !== "object" || Array.isArray(inv)) {
    throw new ErrorHandler("invoice must be an object", 400);
  }
  const at = (path) => path.split(".").slice(1).reduce((o, k) => (o == null ? undefined : o[k]), inv);
  const set = {};
  for (const [path, max] of Object.entries(INVOICE_TEXT)) {
    const v = at(path);
    if (v === undefined) continue;
    set[path] = String(v ?? "").trim().slice(0, max);
  }
  for (const [path, max] of Object.entries(INVOICE_SECRETS)) {
    const v = at(path);
    if (v === undefined || v === null || String(v) === "") continue; // keep what is stored
    set[path] = String(v).slice(0, max);
  }
  if (inv.defaultGstPercent !== undefined) {
    const pct = Number(inv.defaultGstPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new ErrorHandler("defaultGstPercent must be between 0 and 100", 400);
    }
    set["invoice.defaultGstPercent"] = pct;
  }
  if (set["invoice.pincode"] && !/^\d{6}$/.test(set["invoice.pincode"])) {
    throw new ErrorHandler("pincode must be 6 digits", 400);
  }
  if (set["invoice.stateCode"] && !/^\d{2}$/.test(set["invoice.stateCode"])) {
    throw new ErrorHandler("stateCode must be the 2-digit GST state code", 400);
  }
  if (set["invoice.defaultHsn"] && !/^\d{4,8}$/.test(set["invoice.defaultHsn"])) {
    throw new ErrorHandler("defaultHsn must be 4 to 8 digits", 400);
  }
  return set;
}

/** Whether a GSP has credentials, without ever sending them. */
async function gspConfigured() {
  const row = await DocumentSettings.findOne({ key: "document" })
    .select("+invoice.gsp.clientSecret +invoice.gsp.password invoice.gsp.provider")
    .lean();
  const g = row?.invoice?.gsp || {};
  return !!(g.provider && (g.clientSecret || g.password));
}

router.get(
  "/document",
  isAuthenticated,
  catchAsyncErrors(async (_req, res) => {
    const settings = await getDocumentSettings();
    const out = { ...settings, invoice: { ...(settings.invoice || {}), gsp: { ...((settings.invoice || {}).gsp || {}) } } };
    delete out.invoice.gsp.clientSecret;
    delete out.invoice.gsp.password;
    out.invoice.gsp.configured = await gspConfigured();
    res.status(200).json({ success: true, settings: out });
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
    let invoiceSet;
    try {
      invoiceSet = readInvoiceSettings(req.body);
    } catch (err) {
      return next(err);
    }

    const settings = await DocumentSettings.findOneAndUpdate(
      { key: "document" },
      { $set: { ...update, ...invoiceSet }, $setOnInsert: { key: "document" } },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    invalidate(); // PDF layer picks up the change on its next render

    if (settings.invoice?.gsp) {
      delete settings.invoice.gsp.clientSecret;
      delete settings.invoice.gsp.password;
      settings.invoice.gsp.configured = await gspConfigured();
    }
    res.status(200).json({ success: true, settings });
  })
);

module.exports = router;
