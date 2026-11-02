"use strict";
// ══════════════════════════════════════════════════════════════════
//  PARTY LEDGER — one row per document, per customer or supplier
//
//  The statement of account as the party would read it. Written by
//  services/partyLedger.js inside the transaction that posts the
//  document, and reversed (deleted) by the one that cancels it.
//
//  Debit / credit as the books have them:
//    customer   debit  = the customer owes more   (invoice)
//               credit = owes less                (receipt, credit note)
//    supplier   credit = we owe more              (bill)
//               debit  = we owe less              (payment, TDS, debit note)
//
//  A customer's balance is Σdebit − Σcredit (receivable); a
//  supplier's is Σcredit − Σdebit (payable). The whole ledger can be
//  rebuilt from the documents (rebuild() in the service), so a row here
//  is a view the documents agree with, never the only record.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const PartyLedgerEntrySchema = new mongoose.Schema(
  {
    partyType: { type: String, enum: ["customer", "supplier"], required: true },
    party:     { type: mongoose.Types.ObjectId, required: true },
    date:      { type: Date, required: true },
    docType:   { type: String, enum: ["Invoice", "SupplierBill", "Expense", "AccountNote", "Payment", "OpeningBalance"], required: true },
    doc:       { type: mongoose.Types.ObjectId, required: true },
    docNo:     { type: String, required: true },
    debit:     { type: Number, default: 0 },
    credit:    { type: Number, default: 0 },
    narration: { type: String, default: "" },
  },
  { timestamps: true }
);

PartyLedgerEntrySchema.index({ partyType: 1, party: 1, date: 1, _id: 1 });
PartyLedgerEntrySchema.index({ docType: 1, doc: 1 }, { unique: true });

module.exports = mongoose.model("PartyLedgerEntry", PartyLedgerEntrySchema);
