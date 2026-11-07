"use strict";
// ══════════════════════════════════════════════════════════════════
//  AN ORDER A CUSTOMER TYPED ON WHATSAPP, WAITING FOR THE OFFICE
//
//  "2000 m 25mm black by Friday" from a customer's number is read into
//  a draft (services/inboundPoIntake.draftFromText) and kept here. The
//  office opens it as an order — the order form filled from the draft,
//  checked and saved by a person — or dismisses it. Nothing is ordered
//  from a message alone.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const OrderRequestSchema = new mongoose.Schema(
  {
    customer:     { type: mongoose.Types.ObjectId, ref: "Customer", required: true },
    customerName: { type: String, default: "" },
    from:         { type: String, default: "" },
    text:         { type: String, default: "", maxlength: 3000 },
    // The draft as read: { poNumber, deliveryDate, lines: [{ description, quantity, unit, rate, match }] }.
    draft:        { type: mongoose.Schema.Types.Mixed, default: null },
    aiSuggestion: { type: String, default: "" },
    status:       { type: String, enum: ["new", "converted", "dismissed"], default: "new" },
    order:        { type: mongoose.Types.ObjectId, ref: "Order" },
    orderNo:      { type: Number },
    decidedBy:    { type: mongoose.Types.ObjectId, ref: "User" },
    decidedAt:    { type: Date },
    note:         { type: String, default: "", maxlength: 200 },
  },
  { timestamps: true }
);

OrderRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("OrderRequest", OrderRequestSchema);
