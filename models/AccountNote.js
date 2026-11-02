"use strict";
// ══════════════════════════════════════════════════════════════════
//  CREDIT NOTE / DEBIT NOTE
//
//  A credit note goes to a CUSTOMER against one of our invoices — a
//  return, a rate difference, a shortage — and reduces what they owe.
//  A debit note goes to a SUPPLIER against one of their bills — short
//  supply, rejected yarn, a rate difference — and reduces what we owe.
//
//  Numbered CN/2026-27/0001 and DN/2026-27/0001. A note carries its own
//  GST lines (a return reverses the tax too), is applied to the
//  document it names, and is never edited: cancel and raise again.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { TaxLineSchema, TotalsSchema, AttachmentSchema, FingerprintSchema } = require("./accountsShared");

const AccountNoteSchema = new mongoose.Schema(
  {
    kind:          { type: String, enum: ["credit", "debit"], required: true },
    noteNo:        { type: String, required: true, unique: true, trim: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },
    requestId:     { type: String, unique: true, sparse: true },

    date: { type: Date, required: true, default: Date.now },

    partyType: { type: String, enum: ["customer", "supplier"], required: true },
    customer:  { type: mongoose.Types.ObjectId, ref: "Customer" },
    supplier:  { type: mongoose.Types.ObjectId, ref: "Supplier" },
    partyName: { type: String, required: true, trim: true },
    partyGstin: { type: String, default: "", trim: true },

    // The document this note is against.
    against: {
      docType: { type: String, enum: ["Invoice", "SupplierBill"], required: true },
      doc:     { type: mongoose.Types.ObjectId, required: true },
      docNo:   { type: String, required: true },
    },

    reason: { type: String, required: true, trim: true, maxlength: 200 },
    supplyType: { type: String, enum: ["intra", "inter"], required: true },
    lines:  { type: [TaxLineSchema], default: [] },
    totals: { type: TotalsSchema, default: () => ({}) },

    status: { type: String, enum: ["issued", "cancelled"], default: "issued" },
    cancel: { reason: { type: String, default: "" }, at: { type: Date }, by: { type: mongoose.Types.ObjectId, ref: "User" } },

    notes:       { type: String, default: "", trim: true, maxlength: 500 },
    attachments: { type: [AttachmentSchema], default: [] },
    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

AccountNoteSchema.index({ kind: 1, financialYear: 1, sequence: 1 });
AccountNoteSchema.index({ "against.doc": 1 });
AccountNoteSchema.index({ customer: 1, date: -1 });
AccountNoteSchema.index({ supplier: 1, date: -1 });

module.exports = mongoose.model("AccountNote", AccountNoteSchema);
