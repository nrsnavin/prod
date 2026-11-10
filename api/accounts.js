"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS  —  /api/v2/accounts
//
//  The money side of the paperwork the rest of the app raises. Tally
//  stays the book of record; this is where the office enters supplier
//  bills and expenses, issues credit and debit notes, records what
//  came in and went out, and reads who owes what.
//
//    Masters      bank-accounts, categories
//    Bills        /bills, /bills/po-info, /bills/:id, /bills/:id/cancel
//    Expenses     /expenses, /expenses/:id/{approve,reject,pay,cancel}
//    Notes        /notes (credit to a customer, debit to a supplier)
//    Vouchers     /payments (receipts and payments, with allocations and TDS)
//    Ledgers      /statement, /outstanding, /overview
//    Reports      /reports/{gst,tds,expenses,cashbook,daybook}
//
//  Every document is numbered off its own series, carries a fingerprint
//  trail, and is cancelled (with a reason) rather than edited. Vouchers
//  and notes move the amounts on the documents they settle inside one
//  transaction, and post to the party ledger in the same one.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
// Loaded for the model it registers: bills populate references to it
// by name.
require("../models/RawMaterial");
const { createVoucher } = require("./accountsCommon");
const router = express.Router();

// Where the routes live, mounted in this order:
//
//   accountsBills.js        bank accounts, categories, supplier bills,
//                           attachments on any document
//   accountsExpenses.js     expenses
//   accountsNotes.js        credit and debit notes
//   accountsVouchers.js     receipts and payments, credits, ledgers
//   accountsReports.js      GST, TDS, expenses, cash book, day book
//   accountsReaders.js      bill scans, payment advice, supplier statements,
//                           the mailboxes, bank statements
//   accountsCollections.js  reminding customers who owe
//
// accountsCommon.js holds what more than one of them uses.
//
// The routes, in the order they were written. Express tries a router's
// routes in the order they were added, and a router mounted with use()
// is tried in place, so these files answer exactly as one file would.
// That makes the order matter: a new route is tried after everything
// above it and before everything below it, across files. Check it
// neither hides nor is hidden by another — GET /:id hides any
// one-segment GET path below it.
router.use(require("./accountsBills"));
router.use(require("./accountsExpenses"));
router.use(require("./accountsNotes"));
router.use(require("./accountsVouchers"));
router.use(require("./accountsReports"));
router.use(require("./accountsReaders"));
router.use(require("./accountsCollections"));

// Contras, opening balances, settings and the lock.
router.use(require("./accountsBooks"));
router.use(require("./accountsBanking"));
router.use(require("./accountsNotices"));

module.exports = router;
module.exports.createVoucher = createVoucher;
