"use strict";
// ══════════════════════════════════════════════════════════════════
//  ONE LINE OF A GSTR-2B STATEMENT
//
//  What a supplier reported against our GSTIN for a month, as the GST
//  portal's GSTR-2B JSON lists it: an invoice, a credit note or a debit
//  note, with its taxes and whether the credit is available. Uploaded
//  once per month; services/gstr2b.js matches each line to a supplier
//  bill or debit note in the books, and the bill remembers the result.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const Gstr2bEntrySchema = new mongoose.Schema(
  {
    period:       { type: String, required: true },          // "2026-10"
    kind:         { type: String, enum: ["invoice", "creditNote", "debitNote"], required: true },
    supplierGstin: { type: String, required: true, uppercase: true, trim: true },
    supplierName: { type: String, default: "" },
    number:       { type: String, required: true, trim: true },   // the supplier's invoice / note number
    key:          { type: String, required: true },               // normalised number, for matching
    date:         { type: Date },
    value:        { type: Number, default: 0 },
    taxable:      { type: Number, default: 0 },
    cgst:         { type: Number, default: 0 },
    sgst:         { type: Number, default: 0 },
    igst:         { type: Number, default: 0 },
    cess:         { type: Number, default: 0 },
    tax:          { type: Number, default: 0 },
    reverseCharge: { type: Boolean, default: false },
    itcAvailable: { type: Boolean, default: true },
    reason:       { type: String, default: "" },                  // why ITC is not available, when it is not
    placeOfSupply: { type: String, default: "" },
    // The match: a bill (or a debit note) in the books, or nothing.
    match: {
      status:  { type: String, enum: ["matched", "mismatch", "notInBooks"], default: "notInBooks" },
      docType: { type: String, enum: ["", "SupplierBill", "AccountNote", "Expense"], default: "" },
      doc:     { type: mongoose.Types.ObjectId },
      docNo:   { type: String, default: "" },
      diff:    { type: Number, default: 0 },                     // tax in books − tax in 2B
      by:      { type: String, default: "" },                    // "number" or "amount"
    },
    uploadedBy:   { type: mongoose.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

Gstr2bEntrySchema.index({ period: 1, supplierGstin: 1, key: 1, kind: 1 }, { unique: true });
Gstr2bEntrySchema.index({ period: 1, "match.status": 1 });

module.exports = mongoose.model("Gstr2bEntry", Gstr2bEntrySchema);
