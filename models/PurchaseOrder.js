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
      enum: ["Open", "Partial", "Completed"],
      default: "Open",
    },
    poNo: {
      type: Number,
      immutable: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PurchaseOrder", PurchaseOrderSchema);
