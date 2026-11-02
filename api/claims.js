"use strict";
// ══════════════════════════════════════════════════════════════════
//  EXPENSE CLAIMS  —  /api/v2/claims  (every signed-in person)
//
//  Whoever spent the money enters it, from the phone, with the receipt
//  photographed: a supervisor's ₹800 diesel top-up, a driver's toll.
//  A claim is an expense waiting for approval in Accounts, paid back to
//  the claimant (by name) once approved. A person sees and withdraws
//  only their own claims; a head can cap what one person claims in a day.
//
//    GET  /claims/categories      the heads a claim can go under
//    GET  /claims                 my claims
//    GET  /claims/:id             one of mine
//    POST /claims                 { category, description, amount, date, note }
//    POST /claims/:id/photo       multipart "file"
//    POST /claims/:id/withdraw    while it waits for approval
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { keepRequestContext } = require("../middleware/userContext");
const { ACTION_CODES } = require("../utils/fingerprint");
const { allocate } = require("../services/docNumbers");
const { computeInvoice } = require("../services/gst");
const attachments = require("../services/attachments");
const { assertOpen } = require("../services/booksLock");
const { isId, r2, readDate, fp, DAY } = require("../services/accountsHelpers");
const { MAX_ATTACHMENT_BYTES } = require("../models/accountsShared");
const Expense = require("../models/Expense");
const ExpenseCategory = require("../models/ExpenseCategory");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });
const PUBLIC = "expenseNo date dueDate categoryName description payeeName totals.grand status approval.byName approval.note approval.at paidAmount paidAt attachments.filename attachments._id attachments.contentType attachments.size createdAt";

router.get("/categories", catchAsyncErrors(async (_req, res) => {
  const categories = await ExpenseCategory.find({ active: { $ne: false } }).select("name claimDailyLimit").sort({ name: 1 }).lean();
  res.json({ success: true, categories });
}));

router.get("/", catchAsyncErrors(async (req, res) => {
  const claims = await Expense.find({ "claimant.user": req.user._id }).select(PUBLIC).sort({ date: -1, createdAt: -1 }).limit(60).lean();
  const owed = r2(claims.filter((c) => c.status === "approved").reduce((s, c) => s + ((c.totals?.grand || 0) - (c.paidAmount || 0)), 0));
  const waiting = r2(claims.filter((c) => c.status === "pending").reduce((s, c) => s + (c.totals?.grand || 0), 0));
  res.json({ success: true, claims, owed, waiting });
}));

async function mine(req, next) {
  if (!isId(req.params.id)) { next(new ErrorHandler("Claim not found", 404)); return null; }
  const claim = await Expense.findOne({ _id: req.params.id, "claimant.user": req.user._id }).select(PUBLIC).lean();
  if (!claim) { next(new ErrorHandler("Claim not found", 404)); return null; }
  return claim;
}

router.get("/:id", catchAsyncErrors(async (req, res, next) => {
  const claim = await mine(req, next);
  if (claim) res.json({ success: true, claim });
}));

router.post("/", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (b.requestId) {
    const dup = await Expense.findOne({ requestId: String(b.requestId), "claimant.user": req.user._id }).select(PUBLIC).lean();
    if (dup) return res.json({ success: true, claim: dup, replay: true });
  }
  if (!isId(b.category)) return next(new ErrorHandler("Pick what it was for", 400));
  const category = await ExpenseCategory.findOne({ _id: b.category, active: { $ne: false } }).lean();
  if (!category) return next(new ErrorHandler("That head is not available", 404));
  const description = String(b.description || "").trim();
  if (description.length < 3) return next(new ErrorHandler("Say what it was for", 400));
  const amount = r2(b.amount);
  if (!(amount > 0)) return next(new ErrorHandler("amount must be more than 0", 400));
  if (amount > 200000) return next(new ErrorHandler("A claim this large goes through Accounts as a bill", 400));
  let date;
  try { date = readDate(b.date, "date", new Date()); await assertOpen(date, req); } catch (err) { return next(err); }
  if (date > new Date(Date.now() + DAY)) return next(new ErrorHandler("The date is in the future", 400));
  // A head may cap what one person claims in a day.
  if (category.claimDailyLimit > 0) {
    const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
    const [row] = await Expense.aggregate([
      { $match: { "claimant.user": new mongoose.Types.ObjectId(String(req.user._id)), category: category._id, status: { $nin: ["rejected", "cancelled"] }, date: { $gte: dayStart, $lt: new Date(dayStart.getTime() + DAY) } } },
      { $group: { _id: null, total: { $sum: "$totals.grand" } } },
    ]);
    const already = r2(row?.total || 0);
    if (already + amount > category.claimDailyLimit + 0.005) {
      return next(new ErrorHandler(`${category.name} claims are capped at ₹${category.claimDailyLimit} a day per person — ₹${already} is already claimed for that day`, 400));
    }
  }
  const p = computeInvoice([{ description, quantity: 1, rate: amount, gstPercent: 0, hsn: "", unit: "" }], { sellerStateCode: "", buyerStateCode: "" });
  const { financialYear, sequence, number } = await allocate(Expense, "EXP", { at: date });
  const _id = new mongoose.Types.ObjectId();
  const name = req.user.name || "Staff";
  try {
    await Expense.create({
      _id, expenseNo: number, financialYear, sequence, requestId: b.requestId ? String(b.requestId) : undefined,
      date, dueDate: date, category: category._id, categoryName: category.name, description: description.slice(0, 200),
      payeeName: name, claimant: { user: req.user._id, name }, refNo: String(b.refNo || "").trim().slice(0, 40),
      supplyType: p.supplyType, lines: p.lines.map((l) => ({ description: l.description, hsn: "", unit: "", quantity: 1, rate: amount, taxable: l.taxable, gstPercent: 0, cgst: 0, sgst: 0, igst: 0, amount: l.amount })),
      totals: p.totals, itc: { eligible: false, amount: 0 },
      // A claim always waits for someone else to approve it.
      status: "pending", approval: { required: true },
      submittedBy: req.user._id, submittedByName: name, notes: String(b.note || "").trim().slice(0, 500), source: "claim",
      fingerprints: [fp(ACTION_CODES.EXPENSE_SUBMITTED, { _id }, req, { expenseNo: number, category: category.name, grand: p.totals.grand, claim: true })],
    });
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await Expense.findOne({ requestId: String(b.requestId) }).select(PUBLIC).lean();
      if (dup) return res.json({ success: true, claim: dup, replay: true });
    }
    throw err;
  }
  res.status(201).json({ success: true, claim: await Expense.findById(_id).select(PUBLIC).lean() });
}));

router.post("/:id/photo", keepRequestContext(upload.single("file")), catchAsyncErrors(async (req, res, next) => {
  const claim = await mine(req, next);
  if (!claim) return;
  try {
    res.status(201).json({ success: true, attachment: await attachments.attach(Expense, "expenses", claim._id, req.file) });
  } catch (err) {
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
}));

router.post("/:id/withdraw", catchAsyncErrors(async (req, res, next) => {
  const claim = await mine(req, next);
  if (!claim) return;
  if (claim.status !== "pending") return next(new ErrorHandler(`It is already ${claim.status}`, 409));
  const r = await Expense.updateOne({ _id: claim._id, status: "pending" }, {
    $set: { status: "cancelled" },
    $push: { fingerprints: fp(ACTION_CODES.EXPENSE_CANCELLED, claim, req, { expenseNo: claim.expenseNo, reason: "Withdrawn by the claimant" }) },
  });
  if (!r.modifiedCount) return next(new ErrorHandler("It was decided meanwhile", 409));
  res.json({ success: true, claim: await Expense.findById(claim._id).select(PUBLIC).lean() });
}));

module.exports = router;
