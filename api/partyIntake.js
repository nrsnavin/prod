"use strict";
// ══════════════════════════════════════════════════════════════════
//  A CUSTOMER OR SUPPLIER FORM, FILLED FROM A CARD — AND CHECKED
//  (mounted inside /customer and /supplier)
//
//    POST /read-card   multipart "files" (a visiting card, letterhead or
//                      invoice header) → the fields, and who on file looks
//                      the same. Nothing is saved.
//    GET  /similar?name=&gstin=&phone=&exclude=   who on file looks the
//                      same: same GSTIN, same phone, or the same name
//                      once "Pvt Ltd" and the like are set aside
//    GET  /gstin/:gstin   state code, PAN and whether the check digit holds
// ══════════════════════════════════════════════════════════════════

const multer = require("multer");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { keepRequestContext } = require("../middleware/userContext");
const { readCard, gstinInfo } = require("../utils/partyCardOcr");
const { similar } = require("../services/partyMatch");
const aiLedger = require("../services/aiLedger");
const { promptVersion } = require("../utils/aiPrompts");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 2 } });

function mountPartyIntake(router, Model, { phoneField = "phoneNumber", kind }) {
  router.post("/read-card", keepRequestContext(upload.array("files", 2)), catchAsyncErrors(async (req, res, next) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return next(new ErrorHandler("Photograph the card or letterhead", 400));
    const startedAt = Date.now();
    let read;
    try {
      read = await readCard(files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })));
    } catch (err) {
      if (err.code === "ANTHROPIC_KEY_MISSING") return next(new ErrorHandler("Reading cards is not set up on this server — type the details in.", 503));
      if (err.code) return next(new ErrorHandler(err.message, 400));
      await aiLedger.record({ surface: "party-card-ocr", model: "?", promptVersion: promptVersion("party-card-ocr"), latencyMs: Date.now() - startedAt, error: err.message });
      return next(new ErrorHandler(`The card could not be read: ${err.message}`, 502));
    }
    if (read.problem) return res.json({ success: true, read, similar: [], aiSuggestion: null });
    const { model, usage, latencyMs, ...fields } = read;
    const aiSuggestion = await aiLedger.record({
      surface: "party-card-ocr", model, promptVersion: promptVersion("party-card-ocr"), refType: kind,
      proposed: { name: fields.name, contactName: fields.contactName, phone: fields.phone, email: fields.email, gstin: fields.gstin, address: fields.address, city: fields.city, pincode: fields.pincode },
      latencyMs, usage,
    });
    res.json({ success: true, read: fields, similar: await similar(Model, { name: fields.name, gstin: fields.gstin, phone: fields.phone, phoneField }), aiSuggestion: aiSuggestion ? String(aiSuggestion) : null });
  }));

  router.get("/similar", catchAsyncErrors(async (req, res) => {
    const q = req.query || {};
    res.json({ success: true, similar: await similar(Model, { name: String(q.name || "").slice(0, 120), gstin: String(q.gstin || ""), phone: String(q.phone || ""), excludeId: q.exclude || null, phoneField }) });
  }));

  router.get("/gstin/:gstin", catchAsyncErrors(async (req, res) => {
    res.json({ success: true, ...gstinInfo(req.params.gstin) });
  }));
}

module.exports = { mountPartyIntake };
