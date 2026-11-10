"use strict";
// ══════════════════════════════════════════════════════════════════
//  ACCOUNTS — COLLECTIONS  (part of /api/v2/accounts)
//
//  Reminding customers who owe, by hand or on a schedule.
//
//    GET   /collections/auto-remind
//    POST  /collections/auto-remind/run
//    GET   /collections
//    POST  /collections/draft
//    POST  /collections/send
//    POST  /collections/log
//    GET   /collections/:customer/history
//
//  api/accounts.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express  = require("express");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const { isAdmin }      = require("../middleware/auth");
const { getDocumentSettings } = require("../services/documentSettings");
const collections   = require("../services/collections");
const { sendWhatsApp, isConfigured: whatsappConfigured } = require("../utils/whatsapp");
const { isId, r2, readDate } = require("../services/accountsHelpers");
const router = express.Router();

// ══════════════════════════════════════════════════════════════════
//  AI: COLLECTION FOLLOW-UPS
// ══════════════════════════════════════════════════════════════════
// Scheduled reminders: who today's run would remind and who it leaves, and
// the admin's "send today's now" (still once a day).
router.get("/collections/auto-remind", catchAsyncErrors(async (_req, res) => {
  const s = await require("../services/booksLock").getSettings();
  const cfg = s.collections?.autoRemind || {};
  const d = await require("../services/collectionReminders").due(cfg);
  res.json({ success: true, settings: { ...cfg, acknowledgeReplies: !!s.collections?.acknowledgeReplies, assistant: !!s.collections?.assistant }, send: d.send.map((r) => ({ party: r.party, partyName: r.partyName, overdue: r.overdue, oldestDays: r.oldestDays, tone: r.next.tone, phone: r.contact.phone || r.contact.accountantPhone })), skip: d.skip, more: d.more, whatsapp: whatsappConfigured() });
}));
router.post("/collections/auto-remind/run", isAdmin("admin"), catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, ...(await require("../services/collectionReminders").run({ force: true })) });
}));

router.get("/collections", catchAsyncErrors(async (req, res) => {
  const rows = await collections.overdue({ includeHeld: req.query.held === "true" });
  res.json({ success: true, rows, total: r2(rows.reduce((s, r) => s + r.overdue, 0)), whatsapp: whatsappConfigured() });
}));

router.post("/collections/draft", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.body?.customer)) return next(new ErrorHandler("customer is required", 400));
  const entry = (await collections.overdue({ includeHeld: true })).find((r) => String(r.party) === String(req.body.customer));
  if (!entry) return next(new ErrorHandler("Nothing overdue for this customer", 404));
  const settings = await getDocumentSettings();
  // The ladder picks the tone unless the person did.
  const tone = req.body?.tone === "firm" || req.body?.tone === "gentle" ? req.body.tone : entry.next.tone;
  const out = await collections.draft(entry, { company: settings.companyName || "Balu Elastics", tone });
  res.json({ success: true, ...out, tone, to: collections.e164(entry.contact.accountantPhone || entry.contact.phone), entry });
}));

router.post("/collections/send", catchAsyncErrors(async (req, res, next) => {
  const to = collections.e164(req.body?.to);
  const message = String(req.body?.message || "").trim();
  if (!to) return next(new ErrorHandler("A phone number is required", 400));
  if (message.length < 20) return next(new ErrorHandler("The message is too short to send", 400));
  // The company's WhatsApp line speaks to the parties on file, not to any
  // number typed in: a reminder goes to a customer's or supplier's number.
  if (!(await collections.knownPhone(to))) return next(new ErrorHandler("That number is not on any customer or supplier on file — add it to the party first", 400));
  const result = await sendWhatsApp(to, message.slice(0, 1500));
  // Remembered against the customer, so tomorrow's list knows.
  if (isId(req.body?.customer)) {
    await collections.log({ customer: req.body.customer, kind: "reminder", channel: "whatsapp", tone: String(req.body?.tone || ""), to, message, result: result.sent ? "sent" : result.dryRun ? "dry run" : String(result.error || "failed"), user: req.user });
  }
  res.json({ success: true, ...result, to });
}));

/** A call made, a promise to pay, or a note — by hand. */
router.post("/collections/log", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (!isId(b.customer)) return next(new ErrorHandler("customer is required", 400));
  if (!["call", "promise", "note", "reminder"].includes(b.kind)) return next(new ErrorHandler("kind must be call, promise, note or reminder", 400));
  let promiseDate = null;
  try { promiseDate = readDate(b.promiseDate, "promiseDate", null); } catch (err) { return next(err); }
  if (b.kind === "promise" && !promiseDate) return next(new ErrorHandler("When did they promise to pay?", 400));
  if (b.kind !== "promise" && String(b.note || "").trim().length < 3) return next(new ErrorHandler("Say what happened", 400));
  const note = await collections.log({ customer: b.customer, kind: b.kind, channel: String(b.channel || (b.kind === "call" ? "phone" : "")), note: b.note, promiseDate, promiseAmount: b.promiseAmount, user: req.user });
  res.status(201).json({ success: true, note });
}));

router.get("/collections/:customer/history", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.customer)) return next(new ErrorHandler("Customer not found", 404));
  res.json({ success: true, history: await collections.historyOf(req.params.customer) });
}));

module.exports = router;
