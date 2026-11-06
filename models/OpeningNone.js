"use strict";
// ══════════════════════════════════════════════════════════════════
//  NOTHING OWED — a party someone checked and found square on the day
//  the books start here: no opening balance either way.
//
//  Kept so "nothing owed" is told apart from "not entered yet" while
//  the opening balances are set (services/openingOnboarding.js).
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const OpeningNoneSchema = new mongoose.Schema(
  {
    partyType: { type: String, enum: ["customer", "supplier"], required: true },
    party:     { type: mongoose.Types.ObjectId, required: true },
    partyName: { type: String, default: "", trim: true },
    by:        { type: mongoose.Types.ObjectId, ref: "User" },
    byName:    { type: String, default: "" },
  },
  { timestamps: true }
);

OpeningNoneSchema.index({ partyType: 1, party: 1 }, { unique: true });

module.exports = mongoose.model("OpeningNone", OpeningNoneSchema);
