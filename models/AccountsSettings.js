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
      // Payroll into the books (services/payrollBooks.js).
      salaries:         ledger("Salaries & Wages"),
      salaryPayable:    ledger("Salary Payable"),
      pfPayable:        ledger("PF Payable"),
      esiPayable:       ledger("ESI Payable"),
      staffAdvances:    ledger("Staff Advances"),
      // Year end (services/fixedAssets.js, services/closingStock.js).
      depreciation:     ledger("Depreciation"),
      accumulatedDepreciation: ledger("Accumulated Depreciation"),
      stockInHand:      ledger("Stock-in-Hand"),
      closingStock:     ledger("Closing Stock"),
      // Export and SEZ sales, zero-rated or with IGST (services/exportSupply.js).
      exportSales:      ledger("Export Sales"),
      // Interest charged on overdue receivables (services/overdueInterest.js).
      interestReceived: ledger("Interest Received"),
      // Charges the bank took on a dishonoured cheque.
      chequeCharges:    ledger("Cheque Return Charges"),
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

    gst: {
      // HSN digits GSTR-1 must carry: 4 up to ₹5 crore turnover, 6 above.
      hsnDigits: { type: Number, enum: [4, 6, 8], default: 4 },
    },

    tds: {
      // s.194Q: TDS at 0.1% on purchases of goods from one seller beyond
      // ₹50 lakh in a year, once last year's turnover crossed ₹10 crore.
      purchase194q: {
        enabled: { type: Boolean, default: false },
        limit:   { type: Number, default: 5000000, min: 0 },
        rate:    { type: Number, default: 0.1, min: 0, max: 100 },
      },
    },

    journals: {
      // A journal above this needs an admin to post it (0: anyone in accounts).
      approvalAbove: { type: Number, default: 0, min: 0 },
    },

    costCentres: {
      // Send the cost centre on each bill and expense to Tally as a cost-centre allocation.
      tally: { type: Boolean, default: false },
    },

    collections: {
      // Send a short acknowledgement to a customer who replies on WhatsApp.
      acknowledgeReplies: { type: Boolean, default: false },
      // Answer customers' WhatsApp messages from the records: where an
      // order is, their statement, an invoice; a typed order drafted for
      // the office. Off: their messages are read as payment replies only.
      assistant: { type: Boolean, default: false },
      // Payment reminders sent on WhatsApp each day at `hour` (factory time)
      // to customers past due — not one with a live promise, nor one
      // reminded in the last `everyDays` (services/collectionReminders.js).
      autoRemind: {
        enabled:        { type: Boolean, default: false },
        hour:           { type: Number, default: 11, min: 0, max: 23 },
        everyDays:      { type: Number, default: 7, min: 1, max: 60 },
        minOverdueDays: { type: Number, default: 3, min: 0, max: 365 },
        lastRunDate:    { type: String, default: "" },
      },
    },

    // Setting every customer's and supplier's opening balance, from the
    // dashboard, once (services/openingOnboarding.js). `asOn` is the day
    // the balances are dated; done when none is left, or an admin stops it.
    openingOnboarding: {
      asOn:        { type: Date, default: null },
      completedAt: { type: Date, default: null },
      completedBy: { type: String, default: "" },
      // Stopped by an admin with this many parties still not set.
      leftWhenClosed: { type: Number, default: 0 },
    },

    receivables: {
      // Interest charged on overdue invoices, % a year; 0 = none. Days past due before it runs.
      interestRate: { type: Number, default: 0, min: 0, max: 100 },
      graceDays:    { type: Number, default: 0, min: 0, max: 365 },
      // What the interest is worked on (services/overdueInterest.js):
      //   balance   what each invoice still owes on the day asked, for
      //             the days since it fell due. A part paid late is not
      //             charged for the days it was late.
      //   payments  each rupee for the days it stayed unpaid after the
      //             due date: an invoice paid late in full is charged
      //             for its lateness.
      interestBasis: { type: String, enum: ["balance", "payments"], default: "balance" },
    },

    // Export under a Letter of Undertaking (no IGST): its number and the year it covers.
    lut: {
      number:    { type: String, default: "", trim: true, maxlength: 40 },
      validFrom: { type: Date, default: null },
      validTo:   { type: Date, default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AccountsSettings", AccountsSettingsSchema);
