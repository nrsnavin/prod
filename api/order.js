// ══════════════════════════════════════════════════════════════════
//  ORDERS  —  /api/v2/order
//
//  This file makes the router. The routes live in the files mounted
//  below, each a run of related routes:
//
//    orderIntake.js     WhatsApp requests, the list, new orders, restock,
//                       an order drafted from a customer's PO
//    orderDetail.js     one order, everything about it
//    orderApproval.js   approve, add an elastic, cancel, start production
//    orderChanges.js    complete, edit, delete
//    orderProgress.js   open work, ETAs, delivery risk, status reports
//    orderMaterials.js  what an order needs, its lots, deliveries and POs
//
//  orderShared.js holds the helpers more than one of them uses.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
// ETA forecast engine lives in its own service (Phase 4 god-file split).
// The routes below and utils/digest.js both consume these; keeping them
// in one module means the digest and the order card show identical numbers.
const {
  _computeRunningEtaForOrder,
  _loadPlantMetersPerMachineDay,
} = require("../services/etaService.js");
const router = express.Router();

// The routes, in the order they were written. Express tries a router's
// routes in the order they were added, and a router mounted with use()
// is tried in place, so these files answer exactly as one file would.
// That makes the order matter: a new route is tried after everything
// above it and before everything below it, across files. Check it
// neither hides nor is hidden by another — GET /:id hides any
// one-segment GET path below it.
router.use(require("./orderIntake"));
router.use(require("./orderDetail"));
router.use(require("./orderApproval"));
router.use(require("./orderChanges"));
router.use(require("./orderProgress"));
router.use(require("./orderMaterials"));

// Expose the per-order ETA computation + plant-rate loader so utility
// modules (utils/digest.js) can reuse the exact same math the route
// returns to clients — no duplication, identical numbers across the
// app and the WhatsApp digest.
router._etaHelpers = {
  _computeRunningEtaForOrder,
  _loadPlantMetersPerMachineDay,
};

module.exports = router;
