const mongoose = require("mongoose");

const StockMovementSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
    },
    type: {
      type: String, // ORDER_APPROVAL, PO_INWARD, ADJUSTMENT
      required: true,
    },
    order: {
      type: mongoose.Types.ObjectId,
      ref: "Order",
    },
    quantity: {
      type: Number,
      required: true,
    },
  
  },
  { _id: false }
);

const RawMaterialSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    category: { type: String, required: true },

    supplier: {
      type: mongoose.Types.ObjectId,
      ref: "Supplier",
      default:"697e40c4e79c50e10e17ab61"
    },

   price: { type: Number, default: 0 }, // per kg

    stock: { type: Number, default: 0 },
    minStock: { type: Number, default: 100 },
    totalConsumption: { type: Number, default: 0 },

    stockMovements: {
      type: [StockMovementSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RawMaterial", RawMaterialSchema);
