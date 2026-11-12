"use strict";
// ══════════════════════════════════════════════════════════════════
//  THE TALLY CONNECTOR'S DOOR  —  /api/v2/tally-connector
//
//  The program on the Tally computer (tools/tally-connector) signs in
//  with a key, not a person's session: an admin creates the key under
//  Accounts → To Tally, and only its hash is kept.
//
//    POST /ping     { tallyOk, version }  → the company to post into
//    GET  /next     the oldest batch queued for the connector, one
//                   message per voucher, cancellation or credit applied
//    POST /result   { batchId, results: [{ key, ok, error }] } — what
//                   Tally took and what it refused; the refused go back
//                   to the queue for the next export
//    POST /ledgers  { company, ledgers: [{ name, parent, gstin, closing }],
//                   snapshot? } — in parts of a few thousand
// ══════════════════════════════════════════════════════════════════

const crypto = require("crypto");
const { r2 } = require("../utils/money");
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const AccountsSettings = require("../models/AccountsSettings");
const TallyBatch = require("../models/TallyBatch");
const TallySnapshot = require("../models/TallySnapshot");
const { getDocumentSettings } = require("../services/documentSettings");
const tallyQueue = require("../services/tallyQueue");

const hash = (key) => crypto.createHash("sha256").update(String(key || "")).digest("hex");

/** The connector's key, checked against the hash kept in settings. */
async function connectorAuth(req, _res, next) {
  try {
    const key = String(req.get("X-Tally-Connector-Key") || "");
    const s = await AccountsSettings.findOne({ key: "accounts" }).select("connector").lean();
    const want = s?.connector?.keyHash || "";
    const got = hash(key);
    if (!key || !want || want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) {
      return next(new ErrorHandler("The connector key is not valid — create a new one under Accounts → To Tally", 401));
    }
    next();
  } catch (err) { next(err); }
}

router.use(connectorAuth);

router.post("/ping", catchAsyncErrors(async (req, res) => {
  const settings = await AccountsSettings.findOneAndUpdate(
    { key: "accounts" },
    { $set: { "connector.lastSeenAt": new Date(), "connector.tallyOk": !!req.body?.tallyOk, "connector.version": String(req.body?.version || req.get("X-Connector-Version") || "").slice(0, 20), "connector.lastSeenFrom": String(req.ip || "").slice(0, 60) } },
    { new: true }
  ).lean();
  const company = settings?.tally?.companyName || (await getDocumentSettings()).companyName || "";
  res.json({ success: true, company, serverTime: new Date() });
}));

router.get("/next", catchAsyncErrors(async (_req, res) => {
  // A batch left "sending" for a quarter of an hour was dropped mid-way: offer it again.
  const stale = new Date(Date.now() - 15 * 60_000);
  const batch = await TallyBatch.findOneAndUpdate(
    { "delivery.via": "connector", $or: [{ "delivery.status": "queued" }, { "delivery.status": "sending", "delivery.startedAt": { $lt: stale } }] },
    { $set: { "delivery.status": "sending", "delivery.startedAt": new Date() }, $inc: { "delivery.attempts": 1 } },
    { sort: { batchNo: 1 }, new: true }
  ).select("+messages batchNo company").lean();
  if (!batch) return res.json({ success: true, batch: null });
  res.json({
    success: true,
    batch: { _id: batch._id, batchNo: batch.batchNo, company: batch.company || "", messages: (batch.messages || []).map((m) => ({ key: m.key, kind: m.kind, number: m.number, xml: tallyQueue.envelope([m.xml], { company: batch.company, masters: m.kind === "master" }) })) },
  });
}));

router.post("/result", catchAsyncErrors(async (req, res, next) => {
  const { batchId, results } = req.body || {};
  if (!mongoose.Types.ObjectId.isValid(String(batchId || ""))) return next(new ErrorHandler("batchId is required", 400));
  if (!Array.isArray(results)) return next(new ErrorHandler("results is required", 400));
  const out = await tallyQueue.recordResult(batchId, results);
  if (!out) return next(new ErrorHandler("Batch not found", 404));
  res.json({ success: true, ...out });
}));

// Sent in parts (the request body is capped at 1 MB): the first part
// makes the reading, the rest add to it by its id.
router.post("/ledgers", catchAsyncErrors(async (req, res, next) => {
  const ledgers = Array.isArray(req.body?.ledgers) ? req.body.ledgers : null;
  if (!ledgers) return next(new ErrorHandler("ledgers is required", 400));
  const part = String(req.body?.snapshot || "");
  const clean = ledgers.slice(0, 20000).map((l) => ({
    name: String(l?.name || "").trim().slice(0, 200),
    parent: String(l?.parent || "").trim().slice(0, 120),
    gstin: String(l?.gstin || "").trim().toUpperCase().slice(0, 15),
    closing: r2(l?.closing),
  })).filter((l) => l.name);
  if (mongoose.Types.ObjectId.isValid(part)) {
    const r = await TallySnapshot.findOneAndUpdate({ _id: part }, { $push: { ledgers: { $each: clean } }, $inc: { count: clean.length } }, { new: true }).select("count").lean();
    if (!r) return next(new ErrorHandler("That reading is gone — start again", 404));
    return res.json({ success: true, snapshot: part, count: r.count });
  }
  const snap = await TallySnapshot.create({ company: String(req.body?.company || "").slice(0, 120), ledgers: clean, count: clean.length });
  // A reading, not a record: keep the last five.
  const old = await TallySnapshot.find({}).sort({ createdAt: -1 }).skip(5).select("_id").lean();
  if (old.length) await TallySnapshot.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  res.json({ success: true, snapshot: snap._id, count: clean.length });
}));

module.exports = router;
module.exports.hash = hash;
