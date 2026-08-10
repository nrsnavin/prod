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

    // ── What this receipt cost, per unit ────────────────────────────
    // A goods receipt used to record only how much arrived, never what
    // it cost — so the one document that knows the price of a specific
    // consignment did not keep it, and the material's weighted average
    // could not be audited back to the receipts that formed it.
    //
    // Taken from the purchase order line when the receipt is made
    // against a PO, and from the material's current price when it is
    // not. 0 means the price was genuinely unknown, and a receipt at 0
    // deliberately leaves the average alone rather than dragging it
    // down — missing information is not free yarn.
    unitPrice: {
      type: Number,
      default: 0,
      min: 0,
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