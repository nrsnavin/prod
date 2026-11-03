"use strict";
// ══════════════════════════════════════════════════════════════════
//  EVERY MAIL AND FILE THE BANK FEED HAS SEEN
//
//  One row per message (by its Message-ID, unique) or SFTP file (by
//  "sftp:" + its path, size and time), so each is read
//  once however many times the mailbox is checked and however many
//  server processes check it — and so the screen can say what came in,
//  what it became, and what could not be read and why.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const BankFeedMessageSchema = new mongoose.Schema(
  {
    messageId:  { type: String, required: true, unique: true },
    // How it came: a mail in the statements mailbox, or a file on the bank's SFTP server.
    channel:    { type: String, enum: ["email", "sftp"], default: "email" },
    from:       { type: String, default: "" },
    subject:    { type: String, default: "" },
    receivedAt: { type: Date },
    // imported: lines added · nothing_new: every line was already here ·
    // skipped: not a statement (no CSV/Excel, or a sender not allowed) ·
    // failed: could not be read or placed
    status:     { type: String, enum: ["imported", "nothing_new", "skipped", "failed"], required: true },
    account:    { type: mongoose.Types.ObjectId, ref: "BankAccount", default: null },
    accountName: { type: String, default: "" },
    statements: { type: [mongoose.Types.ObjectId], default: [] },
    lines:      { type: Number, default: 0 },
    newLines:   { type: Number, default: 0 },
    posted:     { type: Number, default: 0 },
    note:       { type: String, default: "" },
  },
  { timestamps: true }
);

BankFeedMessageSchema.index({ createdAt: -1 });

module.exports = mongoose.model("BankFeedMessage", BankFeedMessageSchema);
