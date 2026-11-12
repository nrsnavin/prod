"use strict";
// ══════════════════════════════════════════════════════════════════
//  BANK STATEMENTS AND RECONCILIATION  (inside /api/v2/accounts)
//
//    GET  /bank/statements?account=        uploaded statements
//    GET  /bank/statements/:id             one, with its lines
//    POST /bank/statements/:id/lines/:index/ignore   set a line aside (reason)
//    POST /bank/statements/:id/lines/:index/link     it is this voucher / contra
//    POST /bank/statements/:id/lines/:index/unlink   a wrong match undone
//
//  A bank line is answered by one entry in the books, and an entry
//  answers one line (services/bankLines.js). A line already in the books
//  cannot be linked or set aside again; an entry that answers another
//  line cannot be linked to this one. Every write to a line is made only
//  if the line is still as the person saw it.
//    POST /bank/clear                      tick a book entry cleared (or not)
//    GET  /bank/reconciliation?account=&asOf=&bankBalance=
//    GET  /bank/feed                       the statements mailbox: set up?
//                                          last run, the last mails
//    POST /bank/feed/run                   read it now
//    PUT  /bank/feed                       { autoPost } (admin)
//    POST /bank/statements/:id/rematch     match the lines still to place again
//    GET  /bank/aliases                    payers remembered from statements
//    DELETE /bank/aliases/:id              forget one
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isId, readDate, reasonFrom } = require("../services/accountsHelpers");
const reconcile = require("../services/reconcile");
const bankLines = require("../services/bankLines");
const BankStatement = require("../models/BankStatement");
const Payment = require("../models/Payment");
const Contra = require("../models/Contra");

router.get("/bank/statements", catchAsyncErrors(async (req, res) => {
  const q = isId(req.query.account) ? { account: req.query.account } : {};
  const rows = await BankStatement.find(q).select("account accountName file source from to openingBalance closingBalance uploadedByName createdAt lines.status").sort({ createdAt: -1 }).limit(30).lean();
  res.json({
    success: true,
    statements: rows.map((s) => {
      const counts = {};
      for (const l of s.lines) counts[l.status] = (counts[l.status] || 0) + 1;
      return { _id: s._id, account: s.account, accountName: s.accountName, file: s.file, source: s.source || "upload", from: s.from, to: s.to, openingBalance: s.openingBalance ?? null, closingBalance: s.closingBalance, uploadedByName: s.uploadedByName, createdAt: s.createdAt, lines: s.lines.length, counts };
    }),
  });
}));

router.get("/bank/statements/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Statement not found", 404));
  const statement = await BankStatement.findById(req.params.id).lean();
  if (!statement) return next(new ErrorHandler("Statement not found", 404));
  res.json({ success: true, statement });
}));

async function lineOf(req, next) {
  if (!isId(req.params.id)) { next(new ErrorHandler("Statement not found", 404)); return null; }
  const st = await BankStatement.findById(req.params.id).lean();
  const line = st?.lines.find((l) => l.index === Number(req.params.index));
  if (!line) { next(new ErrorHandler("Line not found", 404)); return null; }
  return { st, line };
}

const MOVED = "That line was placed by someone else meanwhile — reload the statement";
const inBooks = (line) => `That line is already in the books${line.voucherNo ? ` as ${line.voucherNo}` : ""}`;

router.post("/bank/statements/:id/lines/:index/ignore", catchAsyncErrors(async (req, res, next) => {
  const hit = await lineOf(req, next);
  if (!hit) return;
  if (bankLines.PLACED.includes(hit.line.status)) return next(new ErrorHandler(inBooks(hit.line), 409));
  let reason;
  try { reason = reasonFrom(req); } catch (err) { return next(err); }
  // Only while it is still to be placed (or already set aside: the reason is replaced).
  const done = await bankLines.place(hit.st._id, hit.line.index, { status: "ignored", note: reason }, { from: [...bankLines.UNPLACED, "ignored"] });
  if (!done) return next(new ErrorHandler(MOVED, 409));
  res.json({ success: true });
}));

router.post("/bank/statements/:id/lines/:index/link", catchAsyncErrors(async (req, res, next) => {
  const hit = await lineOf(req, next);
  if (!hit) return;
  if (bankLines.PLACED.includes(hit.line.status)) return next(new ErrorHandler(inBooks(hit.line), 409));
  const type = req.body?.voucherType === "Contra" ? "Contra" : "Payment";
  if (!isId(req.body?.voucher)) return next(new ErrorHandler("voucher is required", 400));
  const v = type === "Contra" ? await Contra.findById(req.body.voucher).lean() : await Payment.findById(req.body.voucher).lean();
  if (!v || v.status !== "posted") return next(new ErrorHandler("Voucher not found", 404));
  const touches = type === "Contra" ? [String(v.from), String(v.to)].includes(String(hit.st.account)) : String(v.account) === String(hit.st.account);
  if (!touches) return next(new ErrorHandler("That voucher is on another account", 400));
  // Money in on the statement is a receipt (or a contra into this
  // account); money out a payment (or a contra out of it).
  const direction = type === "Contra" ? (String(v.to) === String(hit.st.account) ? "in" : "out") : v.kind === "receipt" ? "in" : "out";
  if (hit.line.direction && direction !== hit.line.direction) return next(new ErrorHandler(`The line is money ${hit.line.direction}, the voucher money ${direction}`, 400));
  const amount = v.amount;
  if (Math.abs(amount - hit.line.amount) > 0.005) return next(new ErrorHandler(`The voucher is for ₹${amount.toFixed(2)}, the line for ₹${hit.line.amount.toFixed(2)}`, 400));
  const no = type === "Contra" ? v.contraNo : v.voucherNo;
  // The voucher takes this line for itself: refused when it already
  // answers another line, or another voucher answers this one.
  const id = bankLines.idOf(hit.st, hit.line);
  const got = await bankLines.claim(type, v._id, hit.st.account, id);
  if (got === "taken") return next(new ErrorHandler(`${no} already answers another line on the bank statement — one entry in the books is one line at the bank`, 409));
  if (got === "line-taken") return next(new ErrorHandler("Another voucher already answers this line", 409));
  if (got === "missing") return next(new ErrorHandler("Voucher not found", 404));
  const done = await bankLines.place(hit.st._id, hit.line.index, { status: "recorded", voucherType: type, voucher: v._id, voucherNo: no }, { from: [...bankLines.UNPLACED, "ignored"] });
  if (!done) {
    if (got === "claimed") await bankLines.release(type, v._id, hit.st.account, id);
    return next(new ErrorHandler(MOVED, 409));
  }
  await reconcile.markCleared(type, v._id, hit.st.account, hit.line.date, { overwrite: true });
  res.json({ success: true });
}));

/**
 * A wrong match undone: the line goes back to be placed, and the entry
 * it was matched to is free to answer its own line. Only for a line
 * matched to an entry that was already in the books; a voucher posted
 * from the line is undone by cancelling the voucher, which frees the
 * line by itself.
 */
router.post("/bank/statements/:id/lines/:index/unlink", catchAsyncErrors(async (req, res, next) => {
  const hit = await lineOf(req, next);
  if (!hit) return;
  if (hit.line.status === "posted") return next(new ErrorHandler(`${hit.line.voucherNo || "The voucher"} was posted from this line — cancel the voucher, and the line comes back to be placed`, 409));
  if (hit.line.status !== "recorded" || !hit.line.voucher) return next(new ErrorHandler("That line is not matched to an entry in the books", 409));
  const type = hit.line.voucherType === "Contra" ? "Contra" : "Payment";
  const done = await bankLines.place(hit.st._id, hit.line.index, { status: "unmatched", voucherType: null, voucher: null, voucherNo: "", suggestion: null, note: `Was matched to ${hit.line.voucherNo || "an entry"}; unmatched by ${req.user?.name || "someone"}` }, { from: ["recorded"] });
  if (!done) return next(new ErrorHandler(MOVED, 409));
  await bankLines.release(type, hit.line.voucher, hit.st.account, bankLines.idOf(hit.st, hit.line));
  await reconcile.unclear(type, hit.line.voucher, hit.st.account);
  res.json({ success: true });
}));

router.post("/bank/clear", catchAsyncErrors(async (req, res, next) => {
  const type = req.body?.voucherType === "Contra" ? "Contra" : "Payment";
  if (!isId(req.body?.id) || !isId(req.body?.account)) return next(new ErrorHandler("id and account are required", 400));
  let on = null;
  try { on = readDate(req.body?.clearedOn, "clearedOn", null); } catch (err) { return next(err); }
  const ok = await reconcile.markCleared(type, req.body.id, req.body.account, on, { overwrite: true });
  if (!ok) return next(new ErrorHandler("That entry is not on this account", 404));
  res.json({ success: true });
}));

router.get("/bank/reconciliation", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.query.account)) return next(new ErrorHandler("account is required", 400));
  let asOf;
  try { asOf = readDate(req.query.asOf, "asOf", new Date()); } catch (err) { return next(err); }
  const out = await reconcile.statementAsOf(req.query.account, asOf, req.query.bankBalance);
  if (!out) return next(new ErrorHandler("Account not found", 404));
  res.json({ success: true, ...out });
}));

// ── Match a stored statement again ─────────────────────────────────
// After parties, invoices or remembered payers were added, or to have
// the model look at lines it was not asked about: every line still to
// place is matched afresh. A line posted, recorded or set aside
// meanwhile is left as it is (each write is conditional on the line
// still being unplaced).
const bankStatement = require("../services/bankStatement");
const UNPLACED = ["matched", "unmatched"];

router.post("/bank/statements/:id/rematch", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Statement not found", 404));
  const st = await BankStatement.findById(req.params.id).lean();
  if (!st) return next(new ErrorHandler("Statement not found", 404));
  const nth = bankLines.occurrenceMap(st);
  const rows = st.lines.filter((l) => UNPLACED.includes(l.status))
    .map((l) => ({ index: l.index, date: new Date(l.date), narration: l.narration, ref: l.ref, amount: l.amount, direction: l.direction, balance: l.balance, lineId: bankLines.lineId(st.account, l.key, nth.get(l.index)) }));
  let changed = 0;
  if (rows.length) {
    // A line a live voucher answers by now (posted from another
    // statement that carries the same line) is in the books.
    const held = await bankLines.vouchersFor(rows.map((r) => r.lineId));
    const fresh = rows.filter((r) => !held.has(r.lineId));
    const out = [
      ...rows.filter((r) => held.has(r.lineId)).map((r) => ({ ...r, status: "recorded", suggestion: null, recorded: held.get(r.lineId) })),
      ...(fresh.length ? await bankStatement.match(fresh, st.account, { useModel: req.body?.useModel !== false }) : []),
    ];
    for (const r of out) {
      // An entry the matcher found in the books takes this line for itself, or the line stays to be placed.
      if (r.status === "recorded" && r.recorded && !held.has(r.lineId)) {
        const got = await bankLines.claim(r.recorded.voucherType, r.recorded._id, st.account, r.lineId);
        if (got !== "claimed" && got !== "same") { r.status = "unmatched"; r.recorded = null; r.suggestion = null; }
      }
      const done = await bankLines.place(st._id, r.index, {
        status: r.status, voucherType: r.recorded?.voucherType || null, voucher: r.recorded?._id || null, voucherNo: r.recorded?.voucherNo || "",
        suggestion: r.status === "matched" ? r.suggestion || null : null, candidates: r.candidates?.length ? r.candidates : null,
      }, { from: UNPLACED });
      if (done) changed += 1;
      if (done && r.status === "recorded" && r.recorded) await reconcile.markCleared(r.recorded.voucherType, r.recorded._id, st.account, r.date);
    }
  }
  res.json({ success: true, changed, statement: await BankStatement.findById(st._id).lean() });
}));

// ── Remembered payers and payees ───────────────────────────────────
//    GET    /bank/aliases       what the matcher remembers, newest first
//    DELETE /bank/aliases/:id   forget one (a wrong remember is undone here)
const BankAlias = require("../models/BankAlias");

router.get("/bank/aliases", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, aliases: await BankAlias.find({}).sort({ updatedAt: -1 }).limit(500).lean() });
}));

router.delete("/bank/aliases/:id", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const r = await BankAlias.deleteOne({ _id: req.params.id });
  if (!r.deletedCount) return next(new ErrorHandler("Not found", 404));
  res.json({ success: true });
}));

// ── The bank's statements, from a mailbox ──────────────────────────
const bankFeed = require("../services/bankFeed");
const { isAdmin } = require("../middleware/auth");
const AccountsSettings = require("../models/AccountsSettings");
const { getSettings } = require("../services/booksLock");

router.get("/bank/feed", catchAsyncErrors(async (_req, res) => {
  res.json({ success: true, feed: await bankFeed.status() });
}));

router.post("/bank/feed/run", catchAsyncErrors(async (_req, res, next) => {
  if (!bankFeed.configured()) return next(new ErrorHandler("The statements mailbox is not set up on the server", 409));
  const result = await bankFeed.run({ trigger: "manual" });
  if (result.busy) return next(new ErrorHandler("The mailbox is being read right now — try again in a minute", 409));
  res.json({ success: true, result, feed: await bankFeed.status() });
}));

router.put("/bank/feed", isAdmin("admin"), catchAsyncErrors(async (req, res) => {
  await getSettings(); // the settings row may not exist yet
  await AccountsSettings.updateOne({ key: "accounts" }, { $set: { "bankFeed.autoPost": !!req.body?.autoPost } });
  res.json({ success: true, feed: await bankFeed.status() });
}));

module.exports = router;
