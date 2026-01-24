const mongoose = require('mongoose')

const ShifPlanSchema = new mongoose.Schema({
    date: {
        type: Date,
        required: true,
    },
    shift: {
        type: String,
      enum: ['DAY', 'NIGHT'],
      required: true
    },
    description: {
        type: String,
        default: ""
    },
    totalProduction: {
        type: Number,
        required: true,
        default: 0,
    },


    plan: [{
        type:
            mongoose.Types.ObjectId,
            ref: "ShiftDetail",
    }
    ],

})

ShifPlanSchema.index(
  { date: 1, shift : 1 },
  { unique: true }
);



const ShiftPlan = mongoose.model("ShiftPlan", ShifPlanSchema);
module.exports = ShiftPlan;
