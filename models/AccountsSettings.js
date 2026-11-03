"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS SETTINGS  (singleton, key "accounts")
//
//  lockDate   the books are closed up to and including this day:
//             nothing dated on or before it is posted or cancelled
//             without an admin and a reason. Moves forward when a
//             batch goes to Tally with "lock" ticked.
//  tally      the Tally ledger each kind of entry is posted to. Parties
//             post to a ledger of their own name; bank accounts and
//             expense heads carry their own ledger name.
//  bills      how far a bill's rate may stray from the PO before the
//             bill needs a note from whoever enters it.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const ledger = (def) => ({ type: String, trim: true, default: def, maxlength: 80 });

const AccountsSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "accounts", unique: true, immutable: true },
    lockDate: { type: Date, default: null },
    lockedBy: { type: String, default: "" },
    lockedAt: { type: Date },

    tally: {
      companyName:      ledger(""),
      sales:            ledger("Sales"),
      purchase:         ledger("Purchase"),
      outputCgst:       ledger("Output CGST"),
      outputSgst:       ledger("Output SGST"),
      outputIgst:       ledger("Output IGST"),
      inputCgst:        ledger("Input CGST"),
      inputSgst:        ledger("Input SGST"),
      inputIgst:        ledger("Input IGST"),
      // Tax owed under reverse charge. Blank: it posts with the output tax.
      rcmCgst:          ledger(""),
      rcmSgst:          ledger(""),
      rcmIgst:          ledger(""),
      roundOff:         ledger("Round Off"),
      tdsPayable:       ledger("TDS Payable"),
      tdsReceivable:    ledger("TDS Receivable"),
      bankCharges:      ledger("Bank Charges"),
      discountAllowed:  ledger("Discount Allowed"),
      discountReceived: ledger("Discount Received"),
      badDebts:         ledger("Bad Debts Written Off"),
      writtenBack:      ledger("Sundry Balances Written Back"),
      sundryExpenses:   ledger("Sundry Expenses"),
      debtorsGroup:     ledger("Sundry Debtors"),
      creditorsGroup:   ledger("Sundry Creditors"),
    },

    // The program on the Tally computer: its key (only the hash), and
    // when it last called in.
    connector: {
      keyHash:      { type: String, default: "" },
      keyHint:      { type: String, default: "" },
      createdAt:    { type: Date },
      lastSeenAt:   { type: Date },
      lastSeenFrom: { type: String, default: "" },
      tallyOk:      { type: Boolean, default: false },
      version:      { type: String, default: "" },
    },

    // The bank's scheduled statements, read from a mailbox (the mailbox
    // itself is configured in the server's environment, not here).
    bankFeed: {
      // Post lines the matcher is sure of without a person: a document
      // number in the narration and the amount exact. Off by default.
      autoPost:    { type: Boolean, default: false },
      lockUntil:   { type: Date, default: null },
      lastRunAt:   { type: Date, default: null },
      lastResult:  { type: mongoose.Schema.Types.Mixed, default: null },
    },

    bills: {
      // Percent a billed rate may differ from the PO rate before it needs a note.
      rateVariancePercent: { type: Number, default: 2, min: 0, max: 100 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AccountsSettings", AccountsSettingsSchema);
