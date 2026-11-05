"use strict";
// ══════════════════════════════════════════════════════════════════
//  COLLECTION NOTE — one contact with a customer about money they owe
//
//  A reminder sent, a call made, or a promise to pay by a date. The
//  collections list reads the latest of these: a live promise takes the
//  customer off the list until its date passes, and "last contacted"
//  stops the same customer being chased twice in a week.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const CollectionNoteSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Types.ObjectId, ref: "Customer", required: true },
    kind:     { type: String, enum: ["reminder", "call", "promise", "note", "reply"], required: true },   // reply: the customer's own message (services/collectionReply.js)
    channel:  { type: String, default: "" },        // whatsapp / phone / email / visit
    tone:     { type: String, default: "" },        // gentle / firm
    to:       { type: String, default: "" },
    message:  { type: String, default: "", maxlength: 2000 },
    note:     { type: String, default: "", maxlength: 500 },
    // A promise: by when, and how much.
    promiseDate:   { type: Date },
    promiseAmount: { type: Number, default: 0 },
    // What the send came back with (dry run when WhatsApp is not set up).
    result:   { type: String, default: "" },
    by:       { type: mongoose.Types.ObjectId, ref: "User" },
    byName:   { type: String, default: "" },
  },
  { timestamps: true }
);

CollectionNoteSchema.index({ customer: 1, createdAt: -1 });

module.exports = mongoose.model("CollectionNote", CollectionNoteSchema);
