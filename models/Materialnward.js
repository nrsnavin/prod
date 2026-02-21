const mongoose = require("mongoose");

const materialInwardSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawMaterial",
      required: true,
    },
    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    inwardDate: {
      type: Date,
      default: Date.now,
    },
    remarks: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

materialInwardSchema.index({ rawMaterial: 1, inwardDate: -1 });
materialInwardSchema.index({ purchaseOrder: 1 });

module.exports = mongoose.model("MaterialInward", materialInwardSchema);