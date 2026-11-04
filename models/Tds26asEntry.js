"use strict";
// ══════════════════════════════════════════════════════════════════
//  ONE LINE OF FORM 26AS / AIS  (tax others deducted from us)
//
//  Uploaded from the income-tax portal's CSV or Excel for a year and
//  matched to a customer by TAN, else by name, so the TDS receivable
//  in the books can be checked against what the government holds.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const Tds26asEntrySchema = new mongoose.Schema(
  {
    fy:           { type: String, required: true },
    deductorName: { type: String, default: "" },
    tan:          { type: String, trim: true, uppercase: true, default: "" },
    section:      { type: String, trim: true, uppercase: true, default: "" },
    date:         { type: Date },
    amountPaid:   { type: Number, default: 0 },
    tds:          { type: Number, default: 0 },
    customer:     { type: mongoose.Types.ObjectId, ref: "Customer" },
    matchedBy:    { type: String, enum: ["", "tan", "name"], default: "" },
    uploadedBy:   { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

Tds26asEntrySchema.index({ fy: 1, customer: 1 });

module.exports = mongoose.model("Tds26asEntry", Tds26asEntrySchema);
