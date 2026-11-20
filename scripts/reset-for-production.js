'use strict';
// ════════════════════════════════════════════════════════════
//  RETIRED — this script no longer erases anything.
//
//  It cleared a hand-written list of collections, written before the
//  system had invoices, books of account, yarn lots, warping batches,
//  sample requests or stock counts. Run today it would have:
//
//    • emptied orders, jobs and challans and left every INVOICE that
//      names them, with the payments, bills and ledger behind it;
//    • restarted document numbering at 1 underneath those invoices, so
//      the next invoice asked for a number that already exists;
//    • done it on whatever database the connection string names, with
//      no backup asked for and no name to confirm.
//
//  A list of what to CLEAR goes stale every time a collection is added,
//  and says nothing when it does. The two scripts that replaced this one
//  read the database and erase whatever they were not told to KEEP:
//
//    node scripts/reset-to-masters.js
//        keeps raw materials, elastics, suppliers, customers and elastic
//        groups (and logins, settings, the migration record); insists on
//        a backup and on the database's name.
//
//    node scripts/reset-transactional-data.js
//        also keeps employees and machines; insists on the database's
//        name.
//
//  Both print the whole plan and change nothing until told to.
// ════════════════════════════════════════════════════════════

console.error(
  '\nscripts/reset-for-production.js is retired and erased nothing.\n\n' +
  'Its list of what to clear predates invoices and the books: it would have left\n' +
  'every invoice in place and restarted their numbering at 1.\n\n' +
  'Use one of these instead — each prints its plan first and changes nothing\n' +
  'until you confirm the database by name:\n\n' +
  '    node scripts/reset-to-masters.js            # keep the five master lists\n' +
  '    node scripts/reset-transactional-data.js    # also keep employees and machines\n'
);
process.exit(1);
