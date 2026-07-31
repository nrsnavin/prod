const mongoose = require("mongoose");

const PurchaseItemSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    price: Number,
    quantity: Number,
    receivedQuantity: {
      type: Number,
      default: 0,
    },
  },
  { _id: false }
);

const PurchaseOrderSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      default: Date.now,
    },
    supplier: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      required: true,
    },
    items: [PurchaseItemSchema],
    status: {
      type: String,
      enum: ["Open", "Partial", "Completed", "Cancelled"],
      default: "Open",
    },
    // Requested delivery date + free-text terms/notes for the printed PO.
    expectedDate: { type: Date },
    notes: { type: String, default: "" },
    poNo: {
      type: Number,
      immutable: true,
      // Last line of defense against duplicate PO numbers. Allocation is
      // race-free via utils/sequence.js, but the DB enforces it too.
      // sparse: legacy docs created before poNo existed may lack it.
      unique: true,
      sparse: true,
    },
    // ── What this PO was raised for ────────────────────────────────
    // Set when the PO comes out of a job's material requirement rather
    // than from general reordering. It makes the purchase answerable —
    // "why did we buy this?" has an answer months later, and a job
    // waiting on stock can show what has been ordered to cover it.
    //
    // Both optional: a routine replenishment PO is for nobody in
    // particular, and that is a normal thing for a PO to be.
    forJob:   { type: mongoose.Types.ObjectId, ref: "JobOrder" },
    forOrder: { type: mongoose.Types.ObjectId, ref: "Order" },

    // Tamper-evident audit trail (edit/delete with reason). Same shape as
    // Order/JobOrder fingerprints so the UI can render them uniformly.
    fingerprints: { type: Array, default: [] },
  },
  { timestamps: true }
);

// "What has been ordered to cover this job?" — asked from the MRP every
// time someone checks whether a shortfall is already handled.
PurchaseOrderSchema.index({ forJob: 1 });
PurchaseOrderSchema.index({ forOrder: 1 });

module.exports = mongoose.model("PurchaseOrder", PurchaseOrderSchema);
