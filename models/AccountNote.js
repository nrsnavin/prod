"use strict";
// ══════════════════════════════════════════════════════════════════
//  CREDIT NOTE / DEBIT NOTE
//
//  A credit note goes to a CUSTOMER against one of our invoices — a
//  return, a rate difference, a shortage — and reduces what they owe.
//  A debit note goes to a SUPPLIER against one of their bills — short
//  supply, rejected yarn, a rate difference — and reduces what we owe.
//  A debit note to a CUSTOMER charges more against an invoice (a rate
//  rise, freight billed later) and raises what they owe.
//
//  A note that reduces is applied to its document up to what that
//  document still owes; the rest (a credit after the invoice was paid)
//  is UNAPPLIED and sits on the party's account until it is applied to
//  another document.
//
//  Numbered CN/2026-27/0001 and DN/2026-27/0001. A note carries its own
//  GST lines (a return reverses the tax too), is applied to the
//  document it names, and is never edited: cancel and raise again.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const { TaxLineSchema, TotalsSchema, AttachmentSchema, FingerprintSchema } = require("./accountsShared");
const { ApplicationSchema } = require("./OpeningBalance");

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

    // The party's own number for the same note (a supplier's credit note).
    partyNoteNo: { type: String, default: "", trim: true, maxlength: 40 },

    reason: { type: String, required: true, trim: true, maxlength: 200 },
    supplyType: { type: String, enum: ["intra", "inter"], required: true },
    lines:  { type: [TaxLineSchema], default: [] },
    totals: { type: TotalsSchema, default: () => ({}) },

    // Applied to `against` (the rest is unapplied), and later applications.
    applied:      { type: Number, default: 0 },
    unapplied:    { type: Number, default: 0 },
    applications: { type: [ApplicationSchema], default: [] },

    status: { type: String, enum: ["issued", "cancelled"], default: "issued" },
    tally:  { batch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, at: { type: Date } },
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
