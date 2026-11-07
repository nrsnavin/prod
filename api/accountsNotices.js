"use strict";
// ══════════════════════════════════════════════════════════════════
//  GOVERNMENT NOTICES — read, kept with their deadline, answered
//
//    POST  /accounts/notices/read          the notice's PDF/photos → the form
//                                          filled; nothing saved
//    GET   /accounts/notices?status=open   with days left, soonest first
//    POST  /accounts/notices               { authority, form, … replyBy }
//    PATCH /accounts/notices/:id           edit; replied (with its reference);
//                                          closed
//    POST  /accounts/notices/:id/attachments        the notice itself
//    GET   /accounts/notices/:id/attachments/:aid
//
//  A notice's deadline is the most expensive date to miss in the books:
//  services/noticeReminders.js sends the reminders.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const multer = require("multer");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAdmin } = require("../middleware/auth");
const { keepRequestContext } = require("../middleware/userContext");
const { validate, fields: { text, objectId }, z } = require("../middleware/validate");
const { isId } = require("../services/accountsHelpers");
const aiLedger = require("../services/aiLedger");
const attachments = require("../services/attachments");
const { promptVersion } = require("../utils/aiPrompts");
const { readNotice } = require("../utils/noticeOcr");
const { failure } = require("../utils/docRead");
const StatutoryNotice = require("../models/StatutoryNotice");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 4 } });
const DAY = 86_400_000;
const istDay = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const daysLeft = (replyBy, now = new Date()) => (replyBy ? Math.round((Date.parse(istDay(replyBy)) - Date.parse(istDay(now))) / DAY) : null);
const asDate = (ymd) => (ymd ? new Date(`${ymd}T12:00:00+05:30`) : undefined);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date");

const NOTICE_FIELDS = {
  authority: z.enum(StatutoryNotice.AUTHORITIES).optional(),
  form: text(40).optional(),
  reference: text(60).optional(),
  subject: text(200).optional(),
  periodText: text(60).optional(),
  financialYear: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}$/)]).optional(),
  amount: z.number().min(0).nullable().optional(),
  issuedOn: z.union([z.literal(""), ymd]).optional(),
  replyBy: z.union([z.literal(""), ymd]).optional(),
  replyByAssumed: z.boolean().optional(),
  hearingOn: z.union([z.literal(""), ymd]).optional(),
  summary: text(600).optional(),
  documents: z.array(text(200)).max(20).optional(),
  owner: text(80).optional(),
};

function shape(n, now = new Date()) {
  const left = n.status === "open" ? daysLeft(n.replyBy, now) : null;
  return { ...n, daysLeft: left, urgency: left == null ? "none" : left < 0 ? "overdue" : left <= 3 ? "urgent" : left <= 7 ? "soon" : "later" };
}

function datesOf(b) {
  const out = {};
  for (const k of ["issuedOn", "replyBy", "hearingOn"]) if (k in b) out[k] = b[k] ? asDate(b[k]) : null;
  return out;
}

router.post(
  "/notices/read",
  isAdmin("admin", "accounts"),
  keepRequestContext(upload.array("files", 4)),
  validate({ body: z.object({}).strict() }),
  catchAsyncErrors(async (req, res, next) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return next(new ErrorHandler("Attach the notice (PDF or photos)", 400));
    let read;
    try {
      read = await readNotice(files.map((f) => ({ buffer: f.buffer, mimetype: f.mimetype })));
    } catch (err) {
      const f = failure(err, "notice");
      if (f.status === 502) await aiLedger.record({ surface: "notice-ocr", model: "?", promptVersion: promptVersion("notice-ocr"), error: err.message });
      return next(new ErrorHandler(f.message, f.status));
    }
    if (read.problem) return res.json({ success: true, read, already: null, aiSuggestion: null });
    const already = read.reference ? await StatutoryNotice.findOne({ reference: read.reference }).select("form reference status replyBy").lean() : null;
    const aiSuggestion = await aiLedger.record({
      surface: "notice-ocr", model: read.model, promptVersion: promptVersion("notice-ocr"),
      proposed: { authority: read.authority, form: read.form, reference: read.reference, amount: read.amount, replyBy: read.replyBy },
      latencyMs: read.latencyMs, usage: read.usage,
    });
    res.json({ success: true, read, already, aiSuggestion: aiSuggestion ? String(aiSuggestion) : null });
  })
);

router.get(
  "/notices",
  catchAsyncErrors(async (req, res) => {
    const status = StatutoryNotice.STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const rows = await StatutoryNotice.find(status ? { status } : {}).select("-attachments.data").sort({ status: 1, replyBy: 1, createdAt: -1 }).limit(200).lean();
    const now = new Date();
    const data = rows.map((r) => shape(r, now));
    // Open first, those without a deadline after the dated ones.
    data.sort((a, b) => (a.status === "open") !== (b.status === "open") ? (a.status === "open" ? -1 : 1)
      : (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
    const open = data.filter((d) => d.status === "open");
    res.json({ success: true, data, counts: { open: open.length, overdue: open.filter((d) => d.urgency === "overdue").length, dueThisWeek: open.filter((d) => d.daysLeft != null && d.daysLeft >= 0 && d.daysLeft <= 7).length } });
  })
);

router.post(
  "/notices",
  isAdmin("admin", "accounts"),
  validate({ body: z.object({ ...NOTICE_FIELDS, source: z.enum(["photo", "typed"]).optional(), aiSuggestion: objectId.nullable().optional() }).strict() }),
  catchAsyncErrors(async (req, res, next) => {
    const b = req.body;
    if (!b.form?.trim() && !b.subject?.trim()) return next(new ErrorHandler("Say what the notice is (its form or subject)", 400));
    if (b.reference?.trim() && await StatutoryNotice.exists({ reference: b.reference.trim() })) {
      return next(new ErrorHandler(`Notice ${b.reference.trim()} is already in the register`, 409));
    }
    const { aiSuggestion, ...rest } = b;
    const doc = await StatutoryNotice.create({ ...rest, ...datesOf(b), amount: b.amount ?? undefined, source: b.source || "typed", createdBy: req.user?._id });
    if (aiSuggestion) {
      aiLedger.settle(aiSuggestion, {
        accepted: { authority: doc.authority, form: doc.form, reference: doc.reference, amount: doc.amount ?? null, replyBy: b.replyBy || "" },
        decidedBy: req.user?._id, expectSurface: "notice-ocr", ignoreMissing: true,
      }).catch(() => {});
    }
    res.status(201).json({ success: true, data: shape(doc.toObject()) });
  })
);

router.patch(
  "/notices/:id",
  isAdmin("admin", "accounts"),
  validate({
    body: z.object({
      ...NOTICE_FIELDS,
      status: z.enum(StatutoryNotice.STATUSES).optional(),
      repliedOn: z.union([z.literal(""), ymd]).optional(),
      replyRef: text(80).optional(),
      closedNote: text(300).optional(),
    }).strict(),
  }),
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id)) return next(new ErrorHandler("Notice not found", 404));
    const n = await StatutoryNotice.findById(req.params.id).lean();
    if (!n) return next(new ErrorHandler("Notice not found", 404));
    const b = req.body;
    const set = { ...b, ...datesOf(b) };
    if (b.status === "replied") {
      if (!b.replyRef?.trim() && !n.replyRef) return next(new ErrorHandler("Note the reply's acknowledgement or reference number", 400));
      set.repliedOn = b.repliedOn ? asDate(b.repliedOn) : new Date();
    } else if ("repliedOn" in b) set.repliedOn = b.repliedOn ? asDate(b.repliedOn) : null;
    // A new deadline is a new countdown: its reminders go out again.
    if ("replyBy" in b && istDay(set.replyBy || 0) !== istDay(n.replyBy || 0)) { set.reminded = []; if (!("replyByAssumed" in b)) set.replyByAssumed = false; }
    const doc = await StatutoryNotice.findByIdAndUpdate(n._id, { $set: set }, { new: true, runValidators: true }).lean();
    res.json({ success: true, data: shape(doc) });
  })
);

router.post(
  "/notices/:id/attachments",
  isAdmin("admin", "accounts"),
  keepRequestContext(upload.single("file")),
  validate({ body: z.object({}).strict() }),
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id)) return next(new ErrorHandler("Notice not found", 404));
    const attachment = await attachments.attach(StatutoryNotice, "notices", req.params.id, req.file);
    res.status(201).json({ success: true, attachment });
  })
);

router.get(
  "/notices/:id/attachments/:aid",
  catchAsyncErrors(async (req, res, next) => {
    if (!isId(req.params.id) || !isId(req.params.aid)) return next(new ErrorHandler("Not found", 404));
    const f = await attachments.read(StatutoryNotice, req.params.id, req.params.aid);
    if (!f) return next(new ErrorHandler("Not found", 404));
    res.setHeader("Content-Type", f.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${String(f.filename || "notice").replace(/[^\w.-]+/g, "_")}"`);
    res.send(f.buffer);
  })
);

module.exports = router;
module.exports.daysLeft = daysLeft;
