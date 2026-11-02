"use strict";
// Sub-schemas the accounts documents share: a taxed line, totals, an
// attachment (a bill photo or PDF, stored inline like the machine
// service bills — this deployment has no object storage), and the
// fingerprint rows every audited document carries.

const mongoose = require("mongoose");

const TaxLineSchema = new mongoose.Schema(
  {
    rawMaterial: { type: mongoose.Types.ObjectId, ref: "RawMaterial" },
    description: { type: String, required: true, trim: true },
    hsn:         { type: String, default: "", trim: true },
    unit:        { type: String, default: "" },
    quantity:    { type: Number, required: true, min: 0 },
    rate:        { type: Number, required: true, min: 0 },
    taxable:     { type: Number, required: true },
    gstPercent:  { type: Number, required: true, min: 0 },
    cgst:        { type: Number, default: 0 },
    sgst:        { type: Number, default: 0 },
    igst:        { type: Number, default: 0 },
    amount:      { type: Number, required: true },
  },
  { _id: false }
);

const TotalsSchema = new mongoose.Schema(
  {
    taxable:  { type: Number, default: 0 },
    cgst:     { type: Number, default: 0 },
    sgst:     { type: Number, default: 0 },
    igst:     { type: Number, default: 0 },
    tax:      { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grand:    { type: Number, default: 0 },
  },
  { _id: false }
);

const ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const AttachmentSchema = new mongoose.Schema(
  {
    filename:    { type: String, trim: true, default: "" },
    contentType: { type: String, enum: ATTACHMENT_TYPES, required: true },
    size:        { type: Number, required: true, min: 0 },
    /** Where the bytes are (models/AccountFile.js). */
    file:        { type: mongoose.Types.ObjectId, ref: "AccountFile" },
    /** Older attachments: data:<mime>;base64,<payload> inline. */
    data:        { type: String },
    uploadedAt:  { type: Date, default: Date.now },
  },
  { _id: true }
);

const FingerprintSchema = new mongoose.Schema(
  {
    code:    { type: String, required: true },
    label:   { type: String, required: true },
    hash:    { type: String, required: true },
    shortId: { type: String, required: true },
    at:      { type: Date, required: true, default: Date.now },
    actor:   { type: mongoose.Schema.Types.Mixed, default: { id: "system", name: "System", role: "system" } },
    meta:    { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

module.exports = { TaxLineSchema, TotalsSchema, AttachmentSchema, FingerprintSchema, ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES };
