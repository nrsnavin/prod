"use strict";
// ══════════════════════════════════════════════════════════════════
//  TDS CERTIFICATES (FORM 16A)
//
//  issued    to a supplier we deducted from, each quarter (s.203)
//  received  from a customer who deducted from us: the proof our
//            receivable matches what reaches Form 26AS
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const TdsCertificateSchema = new mongoose.Schema(
  {
    kind:      { type: String, enum: ["issued", "received"], required: true },
    partyType: { type: String, enum: ["customer", "supplier"], required: true },
    party:     { type: mongoose.Types.ObjectId, required: true },
    partyName: { type: String, default: "" },
    fy:        { type: String, required: true },         // "2026-27"
    quarter:   { type: String, enum: ["Q1", "Q2", "Q3", "Q4"], required: true },
    certNo:    { type: String, trim: true, default: "", maxlength: 20 },
    section:   { type: String, trim: true, uppercase: true, default: "" },
    amount:    { type: Number, required: true, min: 0 },
    on:        { type: Date, required: true },           // issued / received on
    note:      { type: String, trim: true, default: "", maxlength: 200 },
    createdBy: { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

TdsCertificateSchema.index({ kind: 1, fy: 1, quarter: 1 });
TdsCertificateSchema.index({ party: 1, fy: 1 });

module.exports = mongoose.model("TdsCertificate", TdsCertificateSchema);
