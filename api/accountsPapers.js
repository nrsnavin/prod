"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — CHEQUE PHOTOS AND PHOTOS SENT ON WHATSAPP
//  (part of /api/v2/accounts)
//
//    POST  /cheques/read                   a cheque photo → the receipt it is
//    GET   /whatsapp-papers?status=        photos sent to the WhatsApp number
//    GET   /whatsapp-papers/:id            one, with what was read
//    GET   /whatsapp-papers/:id/file/:n    its photo
//    POST  /whatsapp-papers/:id/route      it is a … (sends it on)
//    POST  /whatsapp-papers/:id/dismiss    not for the books
//    GET   /bank/learned                   remembered payers, and which post themselves
//
//  A cheque read is a draft receipt (services/chequeIntake.js): nothing
//  is saved until the receipt is posted, by the receipt route. A photo
//  on WhatsApp is sorted and handed on by services/whatsappPapers.js;
//  what waits here is what a person still has to do something with.
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const multer   = require("multer");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { keepRequestContext } = require("../middleware/userContext");
const { sendStoredFile } = require("../utils/sendFile");
const { isId } = require("../services/accountsHelpers");
const WhatsAppPaper = require("../models/WhatsAppPaper");
const papers = require("../services/whatsappPapers");
const router = express.Router();

const chequeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 2 } });

// ══════════════════════════════════════════════════════════════════
//  POST /cheques/read  multipart "files" (the cheque, 1–2 photos),
//  optional "customer" (when the person already picked who paid).
//  → { read, checks, customer, duplicate, draft, aiSuggestion }
// ══════════════════════════════════════════════════════════════════
router.post("/cheques/read", keepRequestContext(chequeUpload.array("files", 2)), catchAsyncErrors(async (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return next(new ErrorHandler("Photograph the cheque: the front, all of it", 400));
  try {
    const out = await require("../services/chequeIntake").fromPhoto({
      pages: files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })),
      customer: isId(req.body?.customer) ? req.body.customer : null,
    });
    res.json({ success: true, ...out });
  } catch (err) {
    if (err.code === "ANTHROPIC_KEY_MISSING") return next(new ErrorHandler("Reading cheques is not set up on this server: type the details in.", 503));
    const f = require("../utils/docRead").failure(err, "cheque");
    return next(new ErrorHandler(f.message, f.status));
  }
}));

// ══════════════════════════════════════════════════════════════════
//  PHOTOS SENT ON WHATSAPP
// ══════════════════════════════════════════════════════════════════
const paperRow = (p) => ({
  _id: p._id, code: p.code, from: p.from, who: p.who, sentByName: p.sentByName, partyName: p.partyName, customer: p.customer, supplier: p.supplier,
  caption: p.caption, pages: p.pages, status: p.status, kind: p.kind, kindBy: p.kindBy, summary: p.summary, note: p.note,
  sentTo: p.sentTo, entered: p.entered, result: p.result, createdAt: p.createdAt, decidedAt: p.decidedAt,
});

router.get("/whatsapp-papers", catchAsyncErrors(async (req, res) => {
  const s = String(req.query.status || "waiting");
  const status = s === "all" ? { $in: WhatsAppPaper.STATUSES } : WhatsAppPaper.STATUSES.includes(s) ? s : "waiting";
  const rows = await WhatsAppPaper.find({ status }).sort({ createdAt: -1 }).limit(150).lean();
  res.json({ success: true, papers: rows.map(paperRow), waiting: await WhatsAppPaper.countDocuments({ status: "waiting" }) });
}));

router.get("/whatsapp-papers/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const p = await WhatsAppPaper.findById(req.params.id).lean();
  if (!p) return next(new ErrorHandler("Not found", 404));
  res.json({ success: true, paper: paperRow(p) });
}));

router.get("/whatsapp-papers/:id/file/:n", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const n = Number(req.params.n);
  const p = await WhatsAppPaper.findById(req.params.id).select("+files code").lean();
  const f = Number.isInteger(n) && n >= 0 ? p?.files?.[n] : null;
  if (!f?.data) return next(new ErrorHandler("Not found", 404));
  sendStoredFile(res, { buffer: Buffer.from(f.data, "base64"), contentType: f.contentType, filename: `whatsapp-${p.code}-${n + 1}`, fallbackName: "photo", maxAge: 3600 });
}));

router.post("/whatsapp-papers/:id/route", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  try {
    const out = await papers.reroute(req.params.id, String(req.body?.kind || ""), { user: req.user });
    res.json({ success: true, paper: paperRow(out.paper) });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
}));

router.post("/whatsapp-papers/:id/dismiss", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  try {
    const p = await papers.dismiss(req.params.id, { user: req.user, reason: String(req.body?.reason || "").trim() || "Not for the books" });
    res.json({ success: true, paper: paperRow(p) });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
}));

// ══════════════════════════════════════════════════════════════════
//  GET /bank/learned — the remembered payers, how many times running
//  each was posted as suggested, and whether its lines post themselves.
// ══════════════════════════════════════════════════════════════════
router.get("/bank/learned", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, ...(await require("../services/learnedPosting").progress()) });
}));

module.exports = router;
