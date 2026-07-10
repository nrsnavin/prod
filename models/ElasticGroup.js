// models/ElasticGroup.js
//
// A named bundle of elastics, optionally tied to a customer (null =
// global bundle usable for any customer). Used to speed up order and
// delivery-challan entry: pick a group and all its elastics are added
// at once, each with an optional default quantity.

const mongoose = require("mongoose");

const GroupItemSchema = new mongoose.Schema(
  {
    elastic: {
      type: mongoose.Types.ObjectId,
      ref: "Elastic",
      required: true,
    },
    // Prefilled onto the order/DC line when the group is added (0 = blank).
    defaultQuantity: { type: Number, default: 0 },
  },
  { _id: false }
);

const ElasticGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // Optional owner. null → global bundle available to every customer.
    customer: {
      type: mongoose.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },

    items: { type: [GroupItemSchema], default: [] },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ElasticGroup", ElasticGroupSchema);
