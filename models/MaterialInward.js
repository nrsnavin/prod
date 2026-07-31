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
    // Supplier lot/batch number — first-class so a bad lot can be traced
    // to the jobs and dispatches it reached (previously free-text remarks).
    lotNo: {
      type: String,
      trim: true,
      default: "",
    },

    // ── Over-receipt ────────────────────────────────────────────────
    // Suppliers routinely send a little more than ordered — a full bag
    // rather than a part one — so an exact-quantity rule just gets
    // worked around by keying the difference in as a stock adjustment,
    // which loses the connection to the PO. Recording the excess here
    // keeps it attached to the receipt that caused it.
    //
    // How much was over the line's ordered quantity, at the moment of
    // this receipt. Zero for an ordinary inward.
    excessQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Why, when the excess went past the tolerance. Blank inside the
    // tolerance — nobody should have to justify a rounded-up bag.
    excessReason: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

materialInwardSchema.index({ rawMaterial: 1, inwardDate: -1 });
materialInwardSchema.index({ purchaseOrder: 1 });

module.exports = mongoose.model("MaterialInward", materialInwardSchema);