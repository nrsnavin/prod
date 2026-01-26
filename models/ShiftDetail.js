const mongoose = require('mongoose')

const ShiftDetailSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
  },
  shift: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default:""
  },
  feedback: {
    type: String,
    default: ""
  },

  status: {
    type: String,
    default: "open"
  },

  timer:{
    type:String,
    required:true,
    default:"00:00:00",
  },
  elastics:{
    type: String,
    default:"",
    required:true,
  },
  production: {
    type: Number,
    required: true,
    default: 0,
  },

  employee: { type: mongoose.Types.ObjectId, ref: "Employee",required:true },
  shiftPlan: { type: mongoose.Types.ObjectId, ref: "ShiftPlan" },
  machine: { type: mongoose.Types.ObjectId, ref: "Machine" ,required:true},
})

const ShiftDetail = mongoose.model("ShiftDetail", ShiftDetailSchema);
module.exports = ShiftDetail;
