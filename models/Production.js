const mongoose = require('mongoose');

const ProductionSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true
    },
    machine: {
      type: mongoose.Types.ObjectId,
      ref: "Machine",
      required: true
    },
   
    employee: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
      required: true
    },
    production: {
      type: Number,
      required: true
    },
    
    shift: {
      type: String,
      required: true
    }

  },
  { timestamps: true }
);

const Production = mongoose.model("Production", ProductionSchema);


module.exports = Production