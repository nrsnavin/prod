"use strict";
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIALS  —  /api/v2/materials
//
//  This file makes the router. The routes live in the files mounted
//  below, each a run of related routes:
//
//    rawMaterialMaster.js         create, list, detail, delete, archive, edit
//    rawMaterialStock.js          suppliers, POs, inward, adjustments, ledger
//    rawMaterialReplenishment.js  low stock, the forecast, stockouts,
//                                 reorder suggestions
//    rawMaterialTools.js          the elastic picker, prices, the stock-take
//                                 sheet, duplicates, the stores command
// ══════════════════════════════════════════════════════════════════

const express           = require("express");
const router = express.Router();

// The routes, in the order they were written. Express tries a router's
// routes in the order they were added, and a router mounted with use()
// is tried in place, so these files answer exactly as one file would.
// That makes the order matter: a new route is tried after everything
// above it and before everything below it, across files. Check it
// neither hides nor is hidden by another — GET /:id hides any
// one-segment GET path below it.
router.use(require("./rawMaterialMaster"));
router.use(require("./rawMaterialStock"));
router.use(require("./rawMaterialReplenishment"));
router.use(require("./rawMaterialTools"));

module.exports = router;
