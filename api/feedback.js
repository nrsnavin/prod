// ══════════════════════════════════════════════════════════════
//  EMPLOYEE FEEDBACK ROUTES
//  File: api/feedback.js
//  Mount: app.use('/api/v2/feedback', require('./api/feedback'));
//
//  Endpoints:
//    POST   /                 — worker files complaint / suggestion (AUTH)
//    GET    /employee/:empId  — worker history (AUTH)
//    GET    /                 — admin list (ADMIN)
//    PUT    /:id/respond      — admin replies + sets status (ADMIN)
//    DELETE /:id              — worker withdraws an OPEN entry (AUTH)
// ══════════════════════════════════════════════════════════════
"use strict";

const express   = require("express");
const mongoose  = require("mongoose");
const router    = express.Router();
const Feedback  = require("../models/EmployeeFeedback");
const Employee  = require("../models/Employee");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { capped } = require("../utils/listLimit");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin, selfOrAdmin } = require("../middleware/auth");
const { notify } = require("../utils/notify");

// ── A note sent anonymously stays that way ─────────────────────────
// The employee app offers "Submit anonymously". The record still names
// its author — it has to, so they can see it and withdraw it — and the
// office list used to send that name along with every note, anonymous
// or not: the web page then printed it. Whoever reads a note that is not
// theirs gets it through here, with no trace of who wrote it.
function forOffice(item) {
  if (!item || !item.isAnonymous) return item;
  const plain = typeof item.toObject === "function" ? item.toObject() : { ...item };
  plain.employee = null;
  delete plain.createdBy;
  delete plain.updatedBy;
  return plain;
}

const TYPES      = ["complaint", "suggestion"];
const CATEGORIES = ["machine", "safety", "management", "facilities", "payroll", "other"];
const STATUSES   = ["open", "in_review", "resolved", "rejected", "closed"];

// A value written as itself in a pipeline update — a text beginning
// with "$" would otherwise be read as the name of a field.
const lit = (v) => ({ $literal: v });

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const {
      employeeId,
      type,
      category = "other",
      subject,
      body,
      isAnonymous = false,
    } = req.body;

    if (!employeeId)        return next(new ErrorHandler("employeeId is required", 400));
    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }
    // A worker files feedback as themselves, never in another's name.
    const office = req.user?.role === "admin" || req.user?.role === "accounts";
    if (!office && String(req.user?.employee || "") !== String(employeeId)) {
      return next(new ErrorHandler("You can send feedback only as yourself", 403));
    }
    if (!TYPES.includes(type)) {
      return next(new ErrorHandler(
        `type must be one of: ${TYPES.join(", ")}`, 400));
    }
    if (!CATEGORIES.includes(category)) {
      return next(new ErrorHandler(
        `category must be one of: ${CATEGORIES.join(", ")}`, 400));
    }
    // Text, of a size someone would type: a number or a list here used
    // to crash .trim() with a 500.
    if (typeof subject !== "string" || !subject.trim()) return next(new ErrorHandler("subject is required", 400));
    if (typeof body !== "string" || !body.trim())       return next(new ErrorHandler("body is required", 400));
    if (subject.length > 200) return next(new ErrorHandler("Keep the subject under 200 characters", 400));
    if (body.length > 5000)   return next(new ErrorHandler("Keep the message under 5,000 characters", 400));

    const emp = await Employee.findById(employeeId, "name");
    if (!emp) return next(new ErrorHandler("Employee not found", 404));

    const fb = await Feedback.create({
      employee: employeeId,
      type, category,
      subject:  subject.trim(),
      body:     body.trim(),
      isAnonymous: isAnonymous === true || isAnonymous === "true",
    });

    res.status(201).json({ success: true, data: fb });

    // Fire owner WhatsApp ping only for complaints (suggestions
    // are routine and shouldn't wake anyone). Fire-and-forget.
    if (fb.type === "complaint") {
      (async () => {
        try {
          // By what was stored, not by what was sent: "false" as text is
          // a note with a name on it — and was announced as anonymous.
          await notify("customerComplaintFiled", {
            subject:      fb.subject,
            category:     fb.category,
            employeeName: fb.isAnonymous ? null : emp.name,
            isAnonymous:  fb.isAnonymous,
            bodyPreview:  fb.body.length > 140 ? `${fb.body.slice(0, 140)}…` : fb.body,
            _entity:      { type: "EmployeeFeedback", id: String(fb._id) },
          });
        } catch (err) {
          console.warn(`[notify:complaint] crashed: ${err?.message}`);
        }
      })();
    }
  })
);

// ─────────────────────────────────────────────────────────────
// GET /employee/:empId
// ─────────────────────────────────────────────────────────────
router.get(
  "/employee/:empId",
  // One's own feedback, or the office's: anonymous notes stay anonymous to everyone else.
  isAuthenticated, selfOrAdmin,
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.empId)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }
    // Asking for one person's notes by their id would name the author of
    // every anonymous one among them. Only that person gets those.
    const own = String(req.user?.employee || "") === String(req.params.empId);
    const items = await Feedback.find({
      employee: req.params.empId,
      ...(own ? {} : { isAnonymous: { $ne: true } }),
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, count: items.length, data: items });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /themes — what keeps coming up (services/feedbackThemes.js):
// exact counts always; themes once there is enough to group. Names are
// never sent to the model, and never come back.
// ─────────────────────────────────────────────────────────────
router.get(
  "/themes",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res) => {
    res.json({ success: true, data: await require("../services/feedbackThemes").analyse({ days: req.query.days }) });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const { status, type, category } = req.query;
    const filter = {};
    if (status && status !== "all")   filter.status   = status;
    if (type && type !== "all")       filter.type     = type;
    if (category && category !== "all") filter.category = category;

    // Newest first, at most LIST_CEILING (utils/listLimit): this list only grows.
    const { rows: items, capped: cut } = await capped(
      Feedback.find(filter)
        .populate("employee", "name department role")
        .populate("respondedBy", "name role")
        .sort({ createdAt: -1 })
        .lean(),
      res
    );
    res.json({ success: true, count: items.length, data: items.map(forOffice), ...(cut ? { capped: true } : {}) });
  })
);

// ─────────────────────────────────────────────────────────────
// PUT /:id/respond
// ─────────────────────────────────────────────────────────────
router.put(
  "/:id/respond",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid feedback id", 400));
    }
    const { status } = req.body || {};
    if (status && !STATUSES.includes(status)) {
      return next(new ErrorHandler(
        `status must be one of: ${STATUSES.join(", ")}`, 400));
    }

    const set = {};
    if (status) set.status = lit(status);
    // The reply is changed when a reply is sent. A change of status that
    // says nothing of it used to write "" over the answer the worker had
    // read. An empty text, sent, still takes it back.
    if (typeof req.body?.response === "string") {
      const response = req.body.response.slice(0, 4000);
      // Who replied, and when: stamped when the reply is written or
      // changed — not on every save, which made the admin closing a note
      // a week later the one who had "responded", that day. (Trust the
      // server, not the client: respondedBy comes from req.user.)
      const unchanged = { $eq: [{ $ifNull: ["$response", ""] }, lit(response)] };
      set.response    = lit(response);
      set.respondedAt = { $cond: [unchanged, "$respondedAt", lit(new Date())] };
      set.respondedBy = { $cond: [unchanged, "$respondedBy", lit(req.user?._id || null)] };
    }

    // One write, reading the reply it replaces. With nothing to change
    // the note is only read.
    const query = Object.keys(set).length
      ? Feedback.findByIdAndUpdate(req.params.id, [{ $set: set }], { new: true })
      : Feedback.findById(req.params.id);
    const doc = await query
      .populate("employee", "name department role")
      .populate("respondedBy", "name role");
    if (!doc) return next(new ErrorHandler("Feedback not found", 404));
    res.json({ success: true, data: forOffice(doc) });
  })
);

// ─────────────────────────────────────────────────────────────
// DELETE /:id    — worker withdraws an OPEN entry
// ─────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid feedback id", 400));
    }
    const fb = await Feedback.findById(req.params.id);
    if (!fb) return next(new ErrorHandler("Feedback not found", 404));
    // Withdrawn by the one who sent it, or an admin — not by anyone signed in.
    if (req.user?.role !== "admin" && String(req.user?.employee || "") !== String(fb.employee)) {
      return next(new ErrorHandler("You can withdraw only your own feedback", 403));
    }
    // Only while it is still open — checked in the delete itself, so a
    // note the office answered a moment ago is not removed under them.
    const gone = fb.status === "open"
      ? await Feedback.findOneAndDelete({ _id: fb._id, status: "open" })
      : null;
    if (!gone) {
      return next(new ErrorHandler(
        "Only open feedback can be withdrawn", 400));
    }
    res.json({ success: true, message: "Feedback withdrawn" });
  })
);

module.exports = router;
