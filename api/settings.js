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
const { isGstin } = require("../services/gst");

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
  "invoice.gstinLookup.url": 300, "invoice.gstinLookup.headerName": 60,
};
const INVOICE_SECRETS = { "invoice.gsp.clientSecret": 300, "invoice.gsp.password": 120, "invoice.gstinLookup.key": 300 };

// Headers a lookup key must not be sent as: they belong to the request
// itself, and naming one would break or redirect it.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie", "accept", "upgrade", "te", "trailer"]);

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
  // The provider's address is called with its credentials in the
  // headers: https only, and not somewhere inside this server's network.
  if (set["invoice.gsp.baseUrl"]) {
    const problem = require("../utils/outboundUrl").outboundUrlProblem(set["invoice.gsp.baseUrl"]);
    if (problem) throw new ErrorHandler(`E-invoice provider address: ${problem}`, 400);
  }
  // The GSTIN lookup service: an address with {gstin} where the number
  // goes, called with its key — the same two rules, and the header that
  // carries the key must be a header.
  const lookupUrl = set["invoice.gstinLookup.url"];
  if (lookupUrl) {
    if (!lookupUrl.includes("{gstin}")) {
      throw new ErrorHandler("GSTIN lookup address: put {gstin} where the number goes, e.g. https://api.example.com/gstin/{gstin}", 400);
    }
    const sample = lookupUrl.split("{gstin}").join("33AAAAA0000A1Z5").split("{key}").join("key");
    const problem = require("../utils/outboundUrl").outboundUrlProblem(sample);
    if (problem) throw new ErrorHandler(`GSTIN lookup address: ${problem}`, 400);
  }
  // The key travels in a header or in the address: one line of
  // printable characters, or it is not a key.
  const lookupKey = set["invoice.gstinLookup.key"];
  if (lookupKey && /[\u0000-\u001f\u007f]/.test(lookupKey)) {
    throw new ErrorHandler("GSTIN lookup key: one line, with no line breaks or control characters", 400);
  }
  // No address, no use for its key: clearing the one forgets the other.
  if (lookupUrl === "") set["invoice.gstinLookup.key"] = "";
  const lookupHeader = set["invoice.gstinLookup.headerName"];
  if (lookupHeader && (!/^[A-Za-z][A-Za-z0-9-]*$/.test(lookupHeader) || RESERVED_HEADERS.has(lookupHeader.toLowerCase()))) {
    throw new ErrorHandler("GSTIN lookup key header: a header name like x-api-key or Authorization", 400);
  }
  return set;
}

/** Where a lookup address points, and no more: "https://api.example.com/…". */
function hostOnly(url) {
  try {
    return `${new URL(String(url).split("{gstin}").join("x").split("{key}").join("x")).origin}/…`;
  } catch (_) {
    return "…";
  }
}

/**
 * The lookup service as the settings screen may see it: its address and
 * header name, whether a key is kept (never the key), and who "Verify"
 * will ask as things stand.
 *
 * The address in full is the admin's to see. Lookup services often take
 * their key in the address ("…?api_key=…"), and one pasted that way —
 * rather than with {key} and the key field — would otherwise be read by
 * every login that can open Settings. Everyone else sees where it points.
 */
async function lookupForScreen(invoice, { admin = false } = {}) {
  const row = await DocumentSettings.findOne({ key: "document" }).select("+invoice.gstinLookup.key invoice.gstinLookup.url").lean();
  const kept = row?.invoice?.gstinLookup || {};
  const shown = { ...((invoice || {}).gstinLookup || {}) };
  delete shown.key;
  shown.url = shown.url || "";
  shown.headerName = shown.headerName || "";
  if (!admin && shown.url) shown.url = hostOnly(shown.url);
  shown.keySet = !!kept.key;
  return { gstinLookup: shown, gstinCheck: await require("../services/gstinLookup").availability() };
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
  catchAsyncErrors(async (req, res) => {
    const settings = await getDocumentSettings();
    const out = { ...settings, invoice: { ...(settings.invoice || {}), gsp: { ...((settings.invoice || {}).gsp || {}) } } };
    delete out.invoice.gsp.clientSecret;
    delete out.invoice.gsp.password;
    out.invoice.gsp.configured = await gspConfigured();
    Object.assign(out.invoice, await lookupForScreen(out.invoice, { admin: req.user?.role === "admin" }));
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
    // The company's own GSTIN: printed on every invoice, sent with every
    // e-invoice, and what the state of supply is read from. A customer's
    // is checked when it is typed; this one was saved as typed — one
    // character short, small letters — and the first anyone knew was the
    // e-invoice portal refusing an invoice. Kept trimmed and in capitals.
    // It is checked when it CHANGES: the form sends every field with each
    // save, and a number on file from before this check must not stop the
    // footer note being edited.
    if (update.gstin !== undefined) {
      const typed = typeof update.gstin === "string" ? update.gstin.trim() : update.gstin == null ? "" : String(update.gstin);
      const gstin = typed.toUpperCase();
      if (gstin === "" || isGstin(gstin)) {
        update.gstin = gstin;
      } else {
        const onFile = await DocumentSettings.findOne({ key: "document" }).select("gstin").lean();
        if (typed !== String(onFile?.gstin || "").trim()) {
          return next(new ErrorHandler(
            "That is not a GSTIN. It has 15 characters, like 33ABCDE1234F1Z5: two digits for the state, the ten of the PAN, then three more.", 400
          ));
        }
        delete update.gstin;
      }
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
    // Only an admin saves these, so the answer shows the address in full.
    if (settings.invoice) Object.assign(settings.invoice, await lookupForScreen(settings.invoice, { admin: true }));
    res.status(200).json({ success: true, settings });
  })
);

module.exports = router;
