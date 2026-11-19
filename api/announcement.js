// ══════════════════════════════════════════════════════════════
//  ANNOUNCEMENT ROUTES
//  File: api/announcement.js
//  Mount: app.use('/api/v2/announcement', require('./api/announcement'));
//
//  Endpoints:
//    GET   /active?dept=     — workers fetch active notices (AUTH)
//    GET   /                 — admin lists all (ADMIN)
//    POST  /                 — admin creates (ADMIN)
//    PUT   /:id              — admin edits (ADMIN)
//    DELETE /:id             — admin deletes (soft via isActive) (ADMIN)
// ══════════════════════════════════════════════════════════════
"use strict";

const express      = require("express");
const mongoose     = require("mongoose");
const router       = express.Router();
const noticeTranslate = require("../services/noticeTranslate");
const Announcement = require("../models/Announcement");
const Employee     = require("../models/Employee");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { capped } = require("../utils/listLimit");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const factoryDay = require("../utils/factoryDay");
const { dayFrom, momentFrom } = require("../utils/requestDate");

const TYPES = ["info", "warning", "safety", "policy", "celebration"];
const AUDIENCES = ["all", "department"];

// ── How long a notice is up ────────────────────────────────────────
//
// "Valid until the 20th" is up through the 20th. The end date used to be
// compared with the clock: the web sends the day, kept as its UTC
// midnight — 05:30 in India — so the notice came down at half past five
// on its last morning; the phone sends its own midnight as an instant,
// so it came down as its last day began. The end date is now KEPT as the
// day (whichever way it was sent), and a notice is up while that day has
// not passed in India. Comparing with the start of today reads the dates
// already on file rightly too, stored either way.
//
// One rule, for the employee app's reader and the web's alike: each had
// its own copy, and they disagreed about a notice with no start date.
function onTheBoard(departments) {
  return {
    isActive: true,
    $and: [
      { $or: [{ validFrom: null }, { validFrom: { $lte: new Date() } }] },          // null: empty or absent
      { $or: [{ validUntil: null }, { validUntil: { $gte: factoryDay.dayStart() } }] },
      { $or: [{ audience: "all" }, { audience: "department", department: { $in: departments.length ? departments : [""] } }] },
    ],
  };
}

/**
 * The departments whose notices this person reads: the one their login
 * is in, and — for an employee's own login — the one they work in.
 *
 * A notice is addressed to where people work ("weaving"). An employee's
 * login is in "production" whatever they do, so the web, which went by
 * the login alone, never showed a worker their own department's notices;
 * the employee app sends the department it knows (`asked`).
 */
async function departmentsOf(req, asked = "") {
  const mine = [asked, req.user?.department];
  if (req.user?.employee) {
    const employee = await Employee.findById(req.user.employee).select("department").lean();
    mine.push(employee?.department);
  }
  return [...new Set(mine.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim()))];
}

/** A start date: a day sent on its own begins as that day begins in India; a moment is that moment. */
function startFrom(raw) {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    const day = factoryDay.dayStart(raw.trim());
    if (!day) throw new ErrorHandler("validFrom is not a date", 400);
    return day;
  }
  // Nothing sent is undefined, not null: the notice then starts now (the
  // model's default), and has no end date at all.
  return momentFrom(raw, "validFrom") ?? undefined;
}
/** An end date: the day it names in India, however it was sent. */
const endFrom = (raw) => dayFrom(raw, "validUntil") ?? undefined;

/** A notice cannot end before the day it begins: nobody would ever see it. */
function refuseBackwards(validFrom, validUntil) {
  if (validFrom && validUntil && factoryDay.daysBetween(validFrom, validUntil) < 0) {
    throw new ErrorHandler("Valid until is before the day the notice starts", 400);
  }
}

const isText = (v) => typeof v === "string";
/** A link is a web address, or nothing. */
const isLink = (v) => v === "" || /^https?:\/\/\S+$/i.test(v);

// ─────────────────────────────────────────────────────────────
// GET /active?dept=
//   Workers see: pinned first, then newest, where audience is
//   "all" OR matches their dept, and validUntil hasn't passed.
// ─────────────────────────────────────────────────────────────
router.get(
  "/active",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const dept = typeof req.query.dept === "string" ? req.query.dept : "";

    const items = await Announcement.find(onTheBoard(await departmentsOf(req, dept)))
      .sort({ isPinned: -1, createdAt: -1 })
      .lean();

    // In the worker's language when asked (?lang=ta, or Accept-Language).
    const lang = noticeTranslate.langOf(req);
    res.json({ success: true, count: items.length, data: items.map((a) => noticeTranslate.localise(a, lang)) });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /
// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    // Everyone else reads what is up for them now; only an admin sees
    // the drafts, the expired and the other departments' notices.
    if (req.user?.role !== "admin") {
      const items = await Announcement.find(onTheBoard(await departmentsOf(req)))
        .sort({ isPinned: -1, createdAt: -1 }).limit(200).lean();
      const lang = noticeTranslate.langOf(req);
      return res.json({ success: true, count: items.length, data: items.map((a) => noticeTranslate.localise(a, lang)), readOnly: true });
    }
    // Pinned first, then newest: the cap keeps what matters (utils/listLimit).
    const { rows: items, capped: cut } = await capped(
      Announcement.find().sort({ isPinned: -1, createdAt: -1 }).lean(), res
    );
    res.json({ success: true, count: items.length, data: items, ...(cut ? { capped: true } : {}) });
  })
);

// ─────────────────────────────────────────────────────────────
// POST /
// ─────────────────────────────────────────────────────────────
router.post(
  "/",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const {
      title, body,
      type = "info",
      audience = "all",
      department = "",
      isPinned = false,
      validFrom,
      validUntil,
      attachmentUrl = "",
    } = req.body;

    // Text, and some of it: `title?.trim()` on a number was a server error.
    if (!isText(title) || !title.trim()) return next(new ErrorHandler("title is required", 400));
    if (!isText(body) || !body.trim())   return next(new ErrorHandler("body is required", 400));
    if (!TYPES.includes(type)) {
      return next(new ErrorHandler(
        `type must be one of: ${TYPES.join(", ")}`, 400));
    }
    if (!AUDIENCES.includes(audience)) {
      return next(new ErrorHandler(
        `audience must be one of: ${AUDIENCES.join(", ")}`, 400));
    }
    if (!isText(department)) return next(new ErrorHandler("department is not text", 400));
    if (audience === "department" && !department.trim()) {
      return next(new ErrorHandler(
        "department is required when audience is 'department'", 400));
    }
    if (!isText(attachmentUrl) || !isLink(attachmentUrl.trim())) {
      return next(new ErrorHandler("The attachment link must start with http:// or https://", 400));
    }

    // Read up front, so nothing that is not a date is stored — and the end
    // date as the day it names (see onTheBoard).
    let validFromDate, validUntilDate;
    try {
      validFromDate  = startFrom(validFrom);
      validUntilDate = endFrom(validUntil);
      refuseBackwards(validFromDate || new Date(), validUntilDate);
    } catch (err) {
      return next(err);
    }

    const a = await Announcement.create({
      title:      title.trim(),
      body:       body.trim(),
      type,
      audience,
      department: department.trim(),
      isPinned:   isPinned === true || isPinned === "true",
      validFrom:  validFromDate,
      validUntil: validUntilDate,
      attachmentUrl: attachmentUrl.trim(),
    });

    res.status(201).json({ success: true, data: a });

    // Into Tamil and Hindi, after answering: posting never waits on it.
    if (req.body.translate !== false) {
      noticeTranslate.applyTo(a._id).catch((err) => console.warn(`[notice-translate] ${err?.message}`));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// POST /:id/translate — put it into Tamil and Hindi again now,
// replacing the model's earlier wording (an admin's own stays unless
// ?force=1).
// ─────────────────────────────────────────────────────────────
router.post(
  "/:id/translate",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Invalid announcement id", 400));
    const doc = await noticeTranslate.applyTo(req.params.id, { force: req.query.force === "1" });
    if (!doc) return next(new ErrorHandler("Announcement not found", 404));
    res.json({ success: true, data: doc, translated: !!(doc.translations?.ta?.title || doc.translations?.hi?.title) });
  })
);

// ─────────────────────────────────────────────────────────────
// PUT /:id
// ─────────────────────────────────────────────────────────────
router.put(
  "/:id",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler("Invalid announcement id", 400));
    }
    const sent = req.body || {};
    const update = {};
    const unset = {};

    // What is sent is checked as it is when posting — the model's own
    // checks do not run on an update, so an empty title used to be saved.
    for (const k of ["title", "body"]) {
      if (sent[k] === undefined) continue;
      if (!isText(sent[k]) || !sent[k].trim()) return next(new ErrorHandler(`${k} is required`, 400));
      update[k] = sent[k].trim();
    }
    if (sent.type !== undefined) {
      if (!TYPES.includes(sent.type)) {
        return next(new ErrorHandler(
          `type must be one of: ${TYPES.join(", ")}`, 400));
      }
      update.type = sent.type;
    }
    if (sent.audience !== undefined) {
      if (!AUDIENCES.includes(sent.audience)) {
        return next(new ErrorHandler(
          `audience must be one of: ${AUDIENCES.join(", ")}`, 400));
      }
      update.audience = sent.audience;
    }
    if (sent.department !== undefined) {
      if (!isText(sent.department)) return next(new ErrorHandler("department is not text", 400));
      update.department = sent.department.trim();
    }
    if (update.audience === "department" && !update.department) {
      return next(new ErrorHandler(
        "department is required when audience is 'department'", 400));
    }
    if (sent.attachmentUrl !== undefined) {
      if (!isText(sent.attachmentUrl) || !isLink(sent.attachmentUrl.trim())) {
        return next(new ErrorHandler("The attachment link must start with http:// or https://", 400));
      }
      update.attachmentUrl = sent.attachmentUrl.trim();
    }
    for (const k of ["isPinned", "isActive"]) {
      if (sent[k] !== undefined) update[k] = sent[k] === true || sent[k] === "true";
    }

    const before = await Announcement.findById(req.params.id).select("title body validFrom validUntil").lean();
    if (!before) return next(new ErrorHandler("Announcement not found", 404));

    // A date sent is set; a date sent EMPTY is taken away. (Empty used to
    // be read as "no change": an end date, once given, could not be
    // removed from either app.)
    try {
      const emptied = (k) => sent[k] === null || sent[k] === "";
      if ("validFrom" in sent && sent.validFrom !== undefined) {
        if (emptied("validFrom")) unset.validFrom = 1; else update.validFrom = startFrom(sent.validFrom);
      }
      if ("validUntil" in sent && sent.validUntil !== undefined) {
        if (emptied("validUntil")) unset.validUntil = 1; else update.validUntil = endFrom(sent.validUntil);
      }
      refuseBackwards(
        unset.validFrom ? null : (update.validFrom || before.validFrom),
        unset.validUntil ? null : (update.validUntil || before.validUntil)
      );
    } catch (err) {
      return next(err);
    }
    // An admin's own wording for a language, kept as a person's.
    const tr = req.body.translations;
    if (tr && typeof tr === "object") {
      for (const k of Object.keys(noticeTranslate.LANGS)) {
        const t = tr[k];
        if (!t) continue;
        if (!String(t.title || "").trim() || !String(t.body || "").trim()) return next(new ErrorHandler(`${noticeTranslate.LANGS[k]} needs a title and a body`, 400));
        update[`translations.${k}`] = { title: String(t.title).trim().slice(0, 300), body: String(t.body).trim().slice(0, 5000), by: "person", at: new Date() };
      }
    }
    const change = {
      ...(Object.keys(update).length ? { $set: update } : {}),
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
    };
    const doc = Object.keys(change).length
      ? await Announcement.findByIdAndUpdate(req.params.id, change, { new: true })
      : await Announcement.findById(req.params.id);
    if (!doc) return next(new ErrorHandler("Announcement not found", 404));
    res.json({ success: true, data: doc });

    // The English changed: the translations no longer say the same — redo them all.
    const englishChanged = before && ((update.title !== undefined && String(update.title).trim() !== before.title) || (update.body !== undefined && String(update.body).trim() !== before.body));
    if (englishChanged && !tr) {
      noticeTranslate.applyTo(doc._id, { force: true }).catch((err) => console.warn(`[notice-translate] ${err?.message}`));
    }
  })
);

// ─────────────────────────────────────────────────────────────
// DELETE /:id    — soft delete via isActive=false
// ─────────────────────────────────────────────────────────────
router.delete(
  "/:id",
  isAuthenticated, isAdmin('admin'),
  catchAsyncErrors(async (req, res, next) => {
    const doc = await Announcement.findByIdAndUpdate(
      req.params.id, { $set: { isActive: false } }, { new: true });
    if (!doc) return next(new ErrorHandler("Announcement not found", 404));
    res.json({ success: true, message: "Announcement deactivated" });
  })
);

module.exports = router;
