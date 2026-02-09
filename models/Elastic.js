const mongoose = require("mongoose");

const ElasticSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },

    // 🔁 CHANGED HERE
    weaveType: {
      type: String,
      required: true,
      default: "8",
    },  

    image: {
      type: String,
    },

    warpSpandex: {
      id: {
        type: mongoose.Types.ObjectId,
        ref: "RawMaterial",
      },
      ends: {
        type: Number,
      },
      weight: {
        type: Number,
      },
    },

    warpYarn: [
      {
        id: {
          type: mongoose.Types.ObjectId,
          ref: "RawMaterial",
        },
        ends: {
          type: Number,
        },
        type: {
          type: String,
        },
        weight: {
          type: Number,
        },
      },
    ],

    spandexCovering: {
      id: {
        type: mongoose.Types.ObjectId,
        ref: "RawMaterial",
      },
      weight: {
        type: Number,
      },
    },

    spandexEnds: {
      type: Number,
      required: true,
    },

    yarnEnds: {
      type: Number,
    },

    weftYarn: {
      id: {
        type: mongoose.Types.ObjectId,
        ref: "RawMaterial",
      },
      weight: {
        type: Number,
      },
    },

    pick: {
      type: Number,
      required: true,
    },

    noOfHook: {
      type: Number,
      required: true,
    },

    weight: {
      type: Number,
      required: true,
    },

    testingParameters: {
      width: {
        type: Number,
      },
      elongation: {
        type: Number,
        required: true,
        default: 120,
      },
      recovery: {
        type: Number,
        required: true,
        default: 90,
      },
      strech: {
        type: String,
      },
    },

    quantityProduced: {
      type: Number,
      default: 0,
    },

    costing: {
      type: mongoose.Types.ObjectId,
      ref: "Costing",
    },

    stock: {
      type: Number,
      default: 0,
    },

    status: {
      type: mongoose.Types.ObjectId,
      ref: "Order",
    },
  },
  { timestamps: true }
);

const Elastic = mongoose.model("Elastic", ElasticSchema);
module.exports = Elastic;
