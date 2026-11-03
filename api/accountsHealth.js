"use strict";
// ══════════════════════════════════════════════════════════════════
//  ARE THE BOOKS CONSISTENT?  (inside /api/v2/accounts)
//
//    GET  /health           every check: derived figures against their
//                           vouchers, ledgers against documents, and what
//                           would make Tally disagree
//    POST /health/repair    put drifted figures back from their vouchers (admin)
//    POST /health/rebuild   re-post every party ledger from its documents (admin)
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { isAdmin } = require("../middleware/auth");
const { actorFromRequest } = require("../utils/fingerprint");
const health = require("../services/booksHealth");
const partyLedger = require("../services/partyLedger");

router.get("/health", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, ...(await health.check()) });
}));

router.post("/health/repair", isAdmin("admin"), catchAsyncErrors(async (req, res) => {
  res.json({ success: true, ...(await health.repairDerived(actorFromRequest(req))) });
}));

router.post("/health/rebuild", isAdmin("admin"), catchAsyncErrors(async (_req, res) => {
  const rows = await partyLedger.rebuild();
  res.json({ success: true, rows: Array.isArray(rows) ? rows.length : rows });
}));

module.exports = router;
