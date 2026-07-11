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
    // Tamper-evident audit trail (edit/delete with reason). Same shape as
    // Order/JobOrder fingerprints so the UI can render them uniformly.
    fingerprints: { type: Array, default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PurchaseOrder", PurchaseOrderSchema);
