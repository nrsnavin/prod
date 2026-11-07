"use strict";
// ══════════════════════════════════════════════════════════════════
//  BANKING: THE ACCOUNTS AT A GLANCE, AND DEPOSITS
//
//    GET  /banking            every account with its book balance, the
//                             cheques in hand and the cheques issued
//                             not yet cleared, what the bank has not
//                             shown yet, and its last statement; the
//                             cheques waiting to be deposited
//    POST /deposits           cheques in hand and cash from the cash box
//                             into one bank account, as one deposit slip
//    GET  /deposits           the slips, newest first
//    GET  /deposits/:id/pdf   a slip to hand in at the counter
//
//  A cheque received is booked to the account it was entered against
//  the day it came; depositing moves it held → deposited (into the
//  bank named here, if another) and the cash goes as a contra. Nothing
//  is booked twice.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { ACTION_CODES } = require("../utils/fingerprint");
const { allocate } = require("../services/docNumbers");
const { assertOpen } = require("../services/booksLock");
const bankBalances = require("../services/bankBalances");
const { isId, r2, readDate, businessDay, fp, withTxn, paging } = require("../services/accountsHelpers");
const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");
const Contra = require("../models/Contra");
const BankStatement = require("../models/BankStatement");
const DepositSlip = require("../models/DepositSlip");

const router = express.Router();

/** Received cheques still in the drawer, oldest cheque date first. */
const inHand = () => Payment.find({ status: "posted", kind: "receipt", mode: "cheque", "cheque.status": "held" })
  .select("voucherNo date amount partyName customer account accountName cheque").sort({ "cheque.date": 1, date: 1 }).lean();

router.get("/banking", catchAsyncErrors(async (_req, res) => {
  const accounts = await bankBalances.withBalances(await BankAccount.find({}).sort({ isDefault: -1, kind: 1, name: 1 }).lean());
  const today = businessDay(new Date());
  const [held, issued, unseen, statements] = await Promise.all([
    inHand(),
    Payment.aggregate([
      { $match: { status: "posted", kind: "payment", mode: "cheque", "cheque.status": { $in: ["held", "deposited"] } } },
      { $group: { _id: "$account", count: { $sum: 1 }, amount: { $sum: "$amount" } } },
    ]),
    // Not yet seen on a bank statement: no cleared date, not cash.
    Payment.aggregate([
      { $match: { status: "posted", mode: { $ne: "cash" }, $or: [{ clearedOn: null }, { clearedOn: { $exists: false } }] } },
      { $group: { _id: "$account", count: { $sum: 1 } } },
    ]),
    BankStatement.aggregate([{ $group: { _id: "$account", to: { $max: "$to" }, closing: { $last: "$closingBalance" } } }]),
  ]);
  const by = (rows) => new Map(rows.map((x) => [String(x._id), x]));
  const issuedBy = by(issued), unseenBy = by(unseen), stBy = by(statements);
  const heldBy = new Map();
  for (const c of held) {
    const k = String(c.account);
    const g = heldBy.get(k) || { count: 0, amount: 0 };
    g.count += 1; g.amount = r2(g.amount + c.amount);
    heldBy.set(k, g);
  }
  const rows = accounts.map((a) => ({
    ...a,
    chequesInHand: heldBy.get(String(a._id)) || { count: 0, amount: 0 },
    chequesIssued: { count: issuedBy.get(String(a._id))?.count || 0, amount: r2(issuedBy.get(String(a._id))?.amount || 0) },
    notOnStatement: a.kind === "cash" ? 0 : unseenBy.get(String(a._id))?.count || 0,
    lastStatement: stBy.get(String(a._id))?.to || null,
  }));
  const live = rows.filter((a) => a.active !== false);
  const sum = (kinds) => r2(live.filter((a) => kinds.includes(a.kind)).reduce((t, a) => t + a.balance, 0));
  res.json({
    success: true,
    accounts: rows,
    totals: { bank: sum(["bank", "upi"]), cash: sum(["cash"]), card: sum(["card"]), chequesInHand: r2(held.reduce((t, c) => t + c.amount, 0)) },
    inHand: held.map((c) => ({
      _id: c._id, voucherNo: c.voucherNo, receivedOn: c.date, amount: c.amount, partyName: c.partyName, account: c.account, accountName: c.accountName,
      chequeNo: c.cheque?.number || "", bank: c.cheque?.bank || "", chequeDate: c.cheque?.date || c.date,
      // Dated ahead: the bank will not take it before its date.
      due: !c.cheque?.date || new Date(c.cheque.date) <= today,
    })),
  });
}));

router.get("/deposits", catchAsyncErrors(async (req, res) => {
  const { page, limit, skip } = paging(req);
  const q = isId(req.query.account) ? { account: req.query.account } : {};
  const [total, slips] = await Promise.all([
    DepositSlip.countDocuments(q),
    DepositSlip.find(q).select("-fingerprints").sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  res.json({ success: true, total, page, pages: Math.max(1, Math.ceil(total / limit)), slips });
}));

/**
 * body: { account, date, cheques: [voucherId], cash, cashFrom, bankSlipNo, requestId }
 */
router.post("/deposits", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  if (b.requestId) {
    const dup = await DepositSlip.findOne({ requestId: String(b.requestId) }).lean();
    if (dup) return res.json({ success: true, slip: dup, replay: true });
  }
  if (!isId(b.account)) return next(new ErrorHandler("Pick the bank account it goes into", 400));
  const account = await BankAccount.findById(b.account).lean();
  if (!account || account.active === false) return next(new ErrorHandler("Account not found", 404));
  if (account.kind !== "bank") return next(new ErrorHandler(`${account.name} is not a bank account — cheques and cash are deposited into a bank`, 400));
  let date;
  try { date = readDate(b.date, "date", new Date()); await assertOpen(date, req); } catch (err) { return next(err); }

  const ids = [...new Set((Array.isArray(b.cheques) ? b.cheques : []).map(String))];
  if (ids.some((id) => !isId(id))) return next(new ErrorHandler("A cheque in the list is not an id", 400));
  const cheques = ids.length ? await Payment.find({ _id: { $in: ids } }).lean() : [];
  for (const id of ids) {
    const c = cheques.find((x) => String(x._id) === id);
    if (!c || c.status !== "posted" || c.kind !== "receipt" || c.mode !== "cheque") return next(new ErrorHandler("Only cheques received can be deposited", 400));
    if (c.cheque?.status !== "held") return next(new ErrorHandler(`Cheque ${c.cheque?.number || c.voucherNo} is already ${c.cheque?.status || "settled"}`, 409));
    if (c.cheque?.date && new Date(c.cheque.date) > date) return next(new ErrorHandler(`Cheque ${c.cheque.number || c.voucherNo} is dated ${new Date(c.cheque.date).toISOString().slice(0, 10).split("-").reverse().join("/")} — the bank will not take it before then`, 400));
  }
  const cash = r2(b.cash);
  if (cash < 0) return next(new ErrorHandler("cash cannot be less than 0", 400));
  let cashFrom = null;
  if (cash > 0) {
    if (!isId(b.cashFrom)) return next(new ErrorHandler("Pick the cash box the cash comes from", 400));
    cashFrom = await BankAccount.findById(b.cashFrom).lean();
    if (!cashFrom || cashFrom.kind !== "cash" || cashFrom.active === false) return next(new ErrorHandler("The cash comes from a cash account", 400));
    const inBox = await bankBalances.balanceBefore(cashFrom, new Date(date.getTime() + 86_400_000));
    if (cash > inBox + 0.005) return next(new ErrorHandler(`${cashFrom.name} has only ₹${inBox.toFixed(2)} on that day`, 400));
  }
  if (!cheques.length && !(cash > 0)) return next(new ErrorHandler("Pick the cheques, or enter the cash, to deposit", 400));

  const ordered = ids.map((id) => cheques.find((x) => String(x._id) === id));
  const total = r2(ordered.reduce((t, c) => t + c.amount, 0) + cash);
  const slip = await allocate(DepositSlip, "DEP", { at: date });
  const contraNo = cash > 0 ? await allocate(Contra, "CTR", { at: date }) : null;
  const _id = new mongoose.Types.ObjectId();
  const contraId = cash > 0 ? new mongoose.Types.ObjectId() : null;
  const bankSlipNo = String(b.bankSlipNo || "").trim().slice(0, 30);
  try {
    await withTxn(async (session) => {
      for (const c of ordered) {
        const moved = String(c.account) !== String(account._id) ? { account: account._id, accountName: account.name } : {};
        const r = await Payment.updateOne(
          { _id: c._id, status: "posted", "cheque.status": "held" },
          { $set: { "cheque.status": "deposited", "cheque.depositedOn": date, "cheque.slipNo": slip.number, ...moved },
            $push: { fingerprints: fp(ACTION_CODES.PDC_UPDATED, c, req, { voucherNo: c.voucherNo, cheque: c.cheque?.number, from: "held", to: "deposited", on: date, slipNo: slip.number, ...(moved.accountName ? { account: account.name } : {}) }) } },
          { session },
        );
        if (r.matchedCount === 0) throw new ErrorHandler(`Cheque ${c.cheque?.number || c.voucherNo} was updated by someone else meanwhile — reload`, 409);
      }
      if (cash > 0) {
        await Contra.create([{
          _id: contraId, contraNo: contraNo.number, financialYear: contraNo.financialYear, sequence: contraNo.sequence, date,
          from: cashFrom._id, fromName: cashFrom.name, to: account._id, toName: account.name, amount: cash, mode: "cash",
          reference: slip.number, narration: `Cash deposited · ${slip.number}${bankSlipNo ? ` · bank slip ${bankSlipNo}` : ""}`, createdBy: req.user?._id,
          fingerprints: [fp(ACTION_CODES.CONTRA_POSTED, { _id: contraId }, req, { contraNo: contraNo.number, from: cashFrom.name, to: account.name, amount: cash, slipNo: slip.number })],
        }], { session });
      }
      await DepositSlip.create([{
        _id, slipNo: slip.number, financialYear: slip.financialYear, sequence: slip.sequence, requestId: b.requestId ? String(b.requestId) : undefined,
        date, account: account._id, accountName: account.name, bankSlipNo,
        cheques: ordered.map((c) => ({ payment: c._id, voucherNo: c.voucherNo, chequeNo: c.cheque?.number || "", bank: c.cheque?.bank || "", chequeDate: c.cheque?.date || c.date, partyName: c.partyName, amount: c.amount })),
        cash, ...(cash > 0 ? { cashFrom: cashFrom._id, contra: contraId, contraNo: contraNo.number } : {}), total, createdBy: req.user?._id,
        fingerprints: [fp(ACTION_CODES.DEPOSIT_POSTED, { _id }, req, { slipNo: slip.number, account: account.name, cheques: ordered.length, cash, total })],
      }], { session });
    });
  } catch (err) {
    if (err?.code === 11000 && b.requestId) {
      const dup = await DepositSlip.findOne({ requestId: String(b.requestId) }).lean();
      if (dup) return res.json({ success: true, slip: dup, replay: true });
    }
    if (err instanceof ErrorHandler) return next(err);
    throw err;
  }
  res.status(201).json({ success: true, slip: await DepositSlip.findById(_id).select("-fingerprints").lean() });
}));

// ── The slip to hand in ────────────────────────────────────────────
const money = (n) => (Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d) => { if (!d) return ""; const t = new Date(d); const p = (n) => String(n).padStart(2, "0"); return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`; };

router.get("/deposits/:id/pdf", catchAsyncErrors(async (req, res, next) => {
  if (!isId(req.params.id)) return next(new ErrorHandler("Slip not found", 404));
  const s = await DepositSlip.findById(req.params.id).lean();
  if (!s) return next(new ErrorHandler("Slip not found", 404));
  const account = await BankAccount.findById(s.account).lean();
  const doc = new PDFDocument({ size: "A5", layout: "landscape", margin: 28 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const L = 28; const W = doc.page.width - 56;
  doc.font("Helvetica-Bold").fontSize(13).text("PAY-IN SLIP", L, 28, { width: W });
  doc.font("Helvetica").fontSize(9).fillColor("#555555")
    .text(`${s.slipNo}  ·  ${dmy(s.date)}${s.bankSlipNo ? `  ·  bank slip ${s.bankSlipNo}` : ""}`, L, 46, { width: W });
  doc.fillColor("#111111").fontSize(10)
    .text(`Into: ${account?.bankName ? `${account.bankName} · ` : ""}${s.accountName}${account?.accountNo ? ` · A/c ${account.accountNo}` : ""}${account?.ifsc ? ` · ${account.ifsc}` : ""}`, L, 62, { width: W });
  let y = 84;
  const cols = [{ h: "Cheque no.", w: 0.14 }, { h: "Drawn on", w: 0.22 }, { h: "Date", w: 0.12 }, { h: "From", w: 0.34 }, { h: "Amount (Rs.)", w: 0.18, align: "right" }];
  const xs = []; let x = L; for (const c of cols) { xs.push(x); x += c.w * W; }
  doc.rect(L, y, W, 15).fillColor("#EDEDED").fill();
  cols.forEach((c, i) => doc.font("Helvetica-Bold").fontSize(8).fillColor("#111111").text(c.h, xs[i] + 3, y + 4, { width: c.w * W - 6, align: c.align || "left", lineBreak: false }));
  y += 18;
  const row = (cells, bold = false) => {
    if (y > doc.page.height - 60) { doc.addPage(); y = 28; }
    cells.forEach((v, i) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#111111").text(String(v ?? ""), xs[i] + 3, y, { width: cols[i].w * W - 6, align: cols[i].align || "left", lineBreak: false, ellipsis: true }));
    y += 14;
  };
  for (const c of s.cheques) row([c.chequeNo, c.bank, dmy(c.chequeDate), c.partyName, money(c.amount)]);
  if (s.cash > 0) row(["Cash", "", "", "", money(s.cash)]);
  doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).strokeColor("#8A8A8A").stroke();
  y += 4;
  row(["", "", "", `Total · ${s.cheques.length} cheque${s.cheques.length === 1 ? "" : "s"}${s.cash > 0 ? " and cash" : ""}`, money(s.total)], true);
  doc.font("Helvetica").fontSize(8).fillColor("#555555").text("Depositor's signature", L, doc.page.height - 44, { width: W / 2 });
  doc.text("Bank's stamp", L + W / 2, doc.page.height - 44, { width: W / 2, align: "right" });
  doc.end();
  const buf = await done;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${s.slipNo.replace(/\//g, "-")}.pdf"`);
  res.send(buf);
}));

module.exports = router;
