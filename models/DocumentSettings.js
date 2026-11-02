"use strict";

// ══════════════════════════════════════════════════════════════
//  DOCUMENT SETTINGS  (singleton)
//
//  One document holds the company profile + branding used by every
//  generated PDF (reports, shift sheet, MRP, PO, delivery challan).
//  Replaces the values that used to be hardcoded in each generator
//  ("Jarvis ERP", accent colours, footers). Edited from the web
//  Settings tab (admin only); read by the PDF layer via
//  services/documentSettings.js.
//
//  Enforced-singleton pattern: a fixed `key: "document"` unique index
//  means findOneAndUpdate(..., upsert) can never create a second row.
// ══════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const documentSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "document", unique: true, immutable: true },

    // ── Identity ──────────────────────────────────────────────
    companyName: { type: String, trim: true, default: "Balu Elastics", maxlength: 120 },
    tagline:     { type: String, trim: true, default: "Elastic Manufacturing", maxlength: 120 },

    // ── Contact block (each line optional; blanks are skipped in PDFs) ──
    addressLines: { type: [String], default: [] },
    gstin:   { type: String, trim: true, default: "", maxlength: 20 },
    phone:   { type: String, trim: true, default: "", maxlength: 40 },
    email:   { type: String, trim: true, default: "", maxlength: 80 },
    website: { type: String, trim: true, default: "", maxlength: 80 },

    // ── Footer / terms shown at the bottom of documents ──
    footerNote: { type: String, trim: true, default: "", maxlength: 500 },
    termsText:  { type: String, trim: true, default: "", maxlength: 2000 },

    // ── Branding ──
    accentColor: {
      type: String,
      trim: true,
      default: "#1D6FEB",
      validate: { validator: (v) => !v || HEX.test(v), message: "accentColor must be a hex colour" },
    },
    // Optional logo as a base64 data URL (data:image/png;base64,...).
    // Kept inline so there's no file-storage dependency; PDFs embed it
    // when present. Capped so a huge upload can't bloat the doc.
    logo: {
      type: String,
      default: "",
      maxlength: 400_000, // ~300KB image
    },

    // ── Invoicing ─────────────────────────────────────────────
    // One HSN and one GST rate cover the whole catalogue unless an
    // elastic overrides them (models/Elastic.js hsn / gstPercent).
    invoice: {
      defaultHsn:        { type: String, trim: true, default: "5806", maxlength: 8 },
      defaultGstPercent: { type: Number, default: 5, min: 0, max: 100 },
      // Seller address for the e-invoice: the address lines above are
      // free text, and the schema wants city, PIN and state apart.
      city:      { type: String, trim: true, default: "", maxlength: 60 },
      pincode:   { type: String, trim: true, default: "", maxlength: 6 },
      // Two-digit GST state code; worked out from the GSTIN when blank.
      stateCode: { type: String, trim: true, default: "", maxlength: 2 },
      bank: {
        name:    { type: String, trim: true, default: "", maxlength: 80 },
        account: { type: String, trim: true, default: "", maxlength: 30 },
        ifsc:    { type: String, trim: true, default: "", maxlength: 11 },
        branch:  { type: String, trim: true, default: "", maxlength: 80 },
        // Printed, and turned into the "scan to pay" QR on the invoice.
        upiId:   { type: String, trim: true, default: "", maxlength: 60 },
      },
      declaration: {
        type: String, trim: true, maxlength: 500,
        default: "We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.",
      },
      // The GSP (GST Suvidha Provider) that registers IRNs. Blank
      // provider = none connected: the IRN is pasted in from the
      // portal. Credentials never leave the server (select: false).
      gsp: {
        provider:     { type: String, trim: true, default: "", maxlength: 40 },
        baseUrl:      { type: String, trim: true, default: "", maxlength: 200 },
        username:     { type: String, trim: true, default: "", maxlength: 120 },
        clientId:     { type: String, trim: true, default: "", maxlength: 120 },
        clientSecret: { type: String, default: "", maxlength: 300, select: false },
        password:     { type: String, default: "", maxlength: 120, select: false },
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DocumentSettings", documentSettingsSchema);
