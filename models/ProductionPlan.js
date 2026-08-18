'use strict';
//
// A snapshot of an admin-approved autonomous production plan.
//
// The planner proposes assignments (order line → machine → heads →
// sequence) deterministically over the Bayesian rate posterior. When the
// admin accepts a proposal we freeze it here as the day's plan of record —
// a shared source of truth the shop floor follows. Accepting does NOT
// mutate machines or jobs (execution still goes through the normal job
// flow); this keeps the automation to "propose", with the human owning the
// "approve", exactly like the OCR verify → apply pattern.

const mongoose = require("mongoose");

const AssignmentSchema = new mongoose.Schema(
  {
    machine:        { type: mongoose.Types.ObjectId, ref: "Machine" },
    machineID:      { type: String, default: "" },   // human label, e.g. LOOM-02
    heads:          { type: Number, default: 0 },
    order:          { type: mongoose.Types.ObjectId, ref: "Order" },
    orderNo:        { type: Number },
    customer:       { type: String, default: "" },
    elastic:        { type: mongoose.Types.ObjectId, ref: "Elastic" },
    elasticName:    { type: String, default: "" },
    qtyMeters:      { type: Number, default: 0 },
    weavingDays:    { type: Number, default: 0 },
    sequence:       { type: Number, default: 0 },     // position in the machine's queue
    startWorkingDay:{ type: Number, default: 0 },     // working-day offset from plan date
    projectedFinish:{ type: Date },
    dueDate:        { type: Date },
    late:           { type: Boolean, default: false },
    lateWorkingDays:{ type: Number, default: 0 },
    changeover:     { type: Boolean, default: false }, // elastic differs from prior run on this machine
    rateSource:     { type: String, default: "coldstart" }, // posterior | plant | coldstart
  },
  { _id: false }
);

const ProductionPlanSchema = new mongoose.Schema(
  {
    horizonDays:  { type: Number, default: 7 },
    generatedAt:  { type: Date, required: true },
    acceptedAt:   { type: Date, default: Date.now },
    acceptedBy:   { type: String, default: "" },      // actor name/username
    objective: {
      lines:          { type: Number, default: 0 },
      placed:         { type: Number, default: 0 },
      unplaceable:    { type: Number, default: 0 },
      onTime:         { type: Number, default: 0 },
      late:           { type: Number, default: 0 },
      totalLateDays:  { type: Number, default: 0 },
      changeovers:    { type: Number, default: 0 },
      machinesUsed:   { type: Number, default: 0 },
    },
    assignments:  { type: [AssignmentSchema], default: [] },
    assumptions:  { type: [String], default: [] },
    status: { type: String, enum: ["accepted", "superseded"], default: "accepted" },

    // ── Did a human change it before accepting? ──────────────────
    //
    // The planner proposes and an admin decides, and until now the only
    // thing kept was the decision. If they moved two lines first, that
    // disagreement — the most informative thing that happens on this
    // screen — was discarded the moment the plan was saved.
    //
    // `edited` records that it happened; the two term sets record what
    // it cost, measured the same way, so "we overrode the planner and
    // it worked out / it did not" is a question with an answer months
    // later. The weights learned from it live in PlannerWeights.
    edited: { type: Boolean, default: false },
    /** Objective terms of what the planner offered. */
    proposedTerms: {
      late:       { type: Number },
      changeover: { type: Number },
      balance:    { type: Number },
    },
    /** Objective terms of what was actually accepted. */
    objectiveTerms: {
      late:       { type: Number },
      changeover: { type: Number },
      balance:    { type: Number },
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.ProductionPlan ||
  mongoose.model("ProductionPlan", ProductionPlanSchema);
