"use strict";
// ══════════════════════════════════════════════════════════════════
//  TAX INVOICE
//
//  Raised against an order, for the delivery challans that carried the
//  goods out. Everything the printed invoice and the e-invoice need is
//  SNAPSHOTTED here — the buyer's address and GSTIN, the seller's, the
//  HSN and rate on every line — because an invoice is a legal record
//  of what was said on the day, and the customer file or the catalogue
//  changing later must not change it.
//
//  The number (INV/2026-27/0001) comes off the atomic counter in
//  utils/sequence.js, one series per financial year, and is drawn
//  when the invoice is raised. Nothing on an issued invoice is edited
//  afterwards: a wrong one is CANCELLED (with a reason) and raised
//  again, which is also how the e-invoice portal treats it.
//
//  `einvoice` holds the IRN once the invoice is registered — by the
//  connected GSP (services/einvoiceProvider.js) or pasted in from the
//  portal — and the signed QR the portal returns, which the PDF prints.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const PartySchema = new mongoose.Schema(
  {
    name:      { type: String, default: "", trim: true },
    address:   { type: String, default: "", trim: true },
    city:      { type: String, default: "", trim: true },
    pincode:   { type: String, default: "", trim: true },
    stateCode: { type: String, default: "", trim: true },
    gstin:     { type: String, default: "", trim: true },
    phone:     { type: String, default: "", trim: true },
    email:     { type: String, default: "", trim: true },
  },
  { _id: false }
);

const LineSchema = new mongoose.Schema(
  {
    elastic:    { type: mongoose.Types.ObjectId, ref: "Elastic" },
    name:       { type: String, required: true, trim: true },
    hsn:        { type: String, default: "", trim: true },
    unit:       { type: String, default: "m" },
    quantity:   { type: Number, required: true, min: 0 },
    // Cartons the line went out in, as the packing slip counts them.
    boxes:      { type: Number, default: 0, min: 0 },
    rate:       { type: Number, required: true, min: 0 },
    taxable:    { type: Number, required: true },
    gstPercent: { type: Number, required: true, min: 0 },
    cgst:       { type: Number, default: 0 },
    sgst:       { type: Number, default: 0 },
    igst:       { type: Number, default: 0 },
    amount:     { type: Number, required: true },
    // The challans this line's quantity came off, for the trail.
    dcNumbers:  { type: [String], default: [] },
  },
  { _id: false }
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

const InvoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, trim: true },
    // A retried create must not raise a second invoice.
    requestId:     { type: String, unique: true, sparse: true },
    financialYear: { type: String, required: true },
    sequence:      { type: Number, required: true },

    invoiceDate:   { type: Date, required: true, default: Date.now },
    // Invoice date + the customer's payment terms; what ageing counts from.
    dueDate:       { type: Date },
    // Settled so far: receipts allocated to it, and credit notes against it.
    paidAmount:     { type: Number, default: 0 },
    creditedAmount: { type: Number, default: 0 },
    // Raised by debit notes to the customer (charged more afterwards).
    debitedAmount:  { type: Number, default: 0 },
    tally:          { batch: { type: mongoose.Types.ObjectId, ref: "TallyBatch" }, at: { type: Date } },
    // An admin released this past a credit hold (services/creditControl.js).
    creditOverride: { type: mongoose.Schema.Types.Mixed, default: undefined },

    order:    { type: mongoose.Types.ObjectId, ref: "Order", required: true },
    orderNo:  { type: Number },
    customer: { type: mongoose.Types.ObjectId, ref: "Customer", required: true },
    // The customer's own order reference, printed as "Buyer's order no."
    customerPo: { type: String, default: "" },

    seller: { type: PartySchema, default: () => ({}) },
    buyer:  { type: PartySchema, default: () => ({}) },
    // Where the goods went (the challans' consignee address); the
    // buyer's billing address when the challans carry none.
    shipTo: { type: String, default: "", trim: true },
    totalBoxes: { type: Number, default: 0 },

    // "intra": CGST + SGST; "inter": IGST. From the two state codes.
    supplyType:    { type: String, enum: ["intra", "inter"], required: true },
    placeOfSupply: { type: String, default: "" },

    dcs: {
      type: [new mongoose.Schema({
        dc:           { type: mongoose.Types.ObjectId, ref: "DeliveryChallan", required: true },
        dcNumber:     { type: String, required: true },
        dispatchDate: { type: Date },
      }, { _id: false })],
      default: [],
    },

    lines: { type: [LineSchema], default: [] },

    totals: {
      taxable:  { type: Number, default: 0 },
      cgst:     { type: Number, default: 0 },
      sgst:     { type: Number, default: 0 },
      igst:     { type: Number, default: 0 },
      tax:      { type: Number, default: 0 },
      roundOff: { type: Number, default: 0 },
      grand:    { type: Number, default: 0 },
    },
    amountInWords: { type: String, default: "" },

    notes: { type: String, default: "", trim: true },

    status: { type: String, enum: ["issued", "cancelled"], default: "issued" },
    cancel: {
      reason: { type: String, default: "" },
      at:     { type: Date },
      by:     { type: mongoose.Types.ObjectId, ref: "User" },
    },

    einvoice: {
      status:        { type: String, enum: ["pending", "registered", "cancelled"], default: "pending" },
      irn:           { type: String, default: "" },
      ackNo:         { type: String, default: "" },
      ackDate:       { type: Date },
      // The signed QR string from the portal; the PDF renders it as a QR.
      signedQr:      { type: String, default: "" },
      // Which provider registered it, or "manual" when pasted in.
      provider:      { type: String, default: "" },
      registeredAt:  { type: Date },
      registeredBy:  { type: mongoose.Types.ObjectId, ref: "User" },
      cancelledAt:   { type: Date },
    },

    createdBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    fingerprints: { type: [FingerprintSchema], default: [] },
  },
  { timestamps: true }
);

InvoiceSchema.index({ financialYear: 1, sequence: 1 });
InvoiceSchema.index({ order: 1, createdAt: -1 });
InvoiceSchema.index({ customer: 1, createdAt: -1 });
InvoiceSchema.index({ status: 1, createdAt: -1 });
InvoiceSchema.index({ "dcs.dc": 1 });

module.exports = mongoose.model("Invoice", InvoiceSchema);
