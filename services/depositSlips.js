"use strict";
// ══════════════════════════════════════════════════════════════════
//  DEPOSIT SLIPS
//
//  Cheques in hand, and cash from the cash box, paid into one bank
//  account in one go (models/DepositSlip.js). What a slip does to the
//  books is here and nowhere else:
//
//    post()     each cheque moves held → deposited on its own voucher,
//               into the bank named (the money was booked the day it
//               came); the cash goes as a contra from the cash box; the
//               slip ties them together. All in one transaction.
//    cancel()   a slip made by mistake, taken back as a whole: the
//               cheques are in hand again where they were, the cash
//               contra is cancelled with it. Refused once the bank has
//               acted on a cheque of it.
//
//  The routes (api/accountsBanking.js) read the request and answer it.
// ══════════════════════════════════════════════════════════════════

const mongoose = require("mongoose");
const ErrorHandler = require("../utils/ErrorHandler");
const { ACTION_CODES } = require("../utils/fingerprint");
const { allocate } = require("./docNumbers");
const { assertOpen } = require("./booksLock");
const { onceAtATime } = require("../utils/onceAtATime");
const bankBalances = require("./bankBalances");
const bankLines = require("./bankLines");
const { once } = require("./posting");
const { isId, r2, readDate, reasonFrom, fp, withTxn } = require("./accountsHelpers");
const BankAccount = require("../models/BankAccount");
const Payment = require("../models/Payment");
const Contra = require("../models/Contra");
const DepositSlip = require("../models/DepositSlip");

const dmy = (d) => new Date(d).toISOString().slice(0, 10).split("-").reverse().join("/");

/**
 * body: { account, date, cheques: [voucherId], cash, cashFrom, bankSlipNo, requestId }
 * @returns {{ slip, replay }}  — replay when a request with this id already made the slip
 */
async function post(b, req) {
  const { doc, replay } = await once(DepositSlip, b.requestId, (requestId) => create(b, req, requestId), { select: "-fingerprints" });
  return { slip: doc, replay };
}

async function create(b, req, requestId) {
  if (!isId(b.account)) throw new ErrorHandler("Pick the bank account it goes into", 400);
  const account = await BankAccount.findById(b.account).lean();
  if (!account || account.active === false) throw new ErrorHandler("Account not found", 404);
  if (account.kind !== "bank") throw new ErrorHandler(`${account.name} is not a bank account — cheques and cash are deposited into a bank`, 400);
  const date = readDate(b.date, "date", new Date());
  await assertOpen(date, req);

  const ids = [...new Set((Array.isArray(b.cheques) ? b.cheques : []).map(String))];
  if (ids.some((id) => !isId(id))) throw new ErrorHandler("A cheque in the list is not an id", 400);
  const cheques = ids.length ? await Payment.find({ _id: { $in: ids } }).lean() : [];
  for (const id of ids) {
    const c = cheques.find((x) => String(x._id) === id);
    if (!c || c.status !== "posted" || c.kind !== "receipt" || c.mode !== "cheque") throw new ErrorHandler("Only cheques received can be deposited", 400);
    if (c.cheque?.status !== "held") throw new ErrorHandler(`Cheque ${c.cheque?.number || c.voucherNo} is already ${c.cheque?.status || "settled"}`, 409);
    if (c.cheque?.date && new Date(c.cheque.date) > date) throw new ErrorHandler(`Cheque ${c.cheque.number || c.voucherNo} is dated ${dmy(c.cheque.date)} — the bank will not take it before then`, 400);
  }
  const cash = r2(b.cash);
  if (cash < 0) throw new ErrorHandler("cash cannot be less than 0", 400);
  let cashFrom = null;
  if (cash > 0) {
    if (!isId(b.cashFrom)) throw new ErrorHandler("Pick the cash box the cash comes from", 400);
    cashFrom = await BankAccount.findById(b.cashFrom).lean();
    if (!cashFrom || cashFrom.kind !== "cash" || cashFrom.active === false) throw new ErrorHandler("The cash comes from a cash account", 400);
  }
  if (!cheques.length && !(cash > 0)) throw new ErrorHandler("Pick the cheques, or enter the cash, to deposit", 400);

  const write = async () => {
    if (cash > 0) {
      const inBox = await bankBalances.balanceBefore(cashFrom, new Date(date.getTime() + 86_400_000));
      if (cash > inBox + 0.005) throw new ErrorHandler(`${cashFrom.name} has only ₹${inBox.toFixed(2)} on that day`, 400);
    }
    const ordered = ids.map((id) => cheques.find((x) => String(x._id) === id));
    const total = r2(ordered.reduce((t, c) => t + c.amount, 0) + cash);
    const slip = await allocate(DepositSlip, "DEP", { at: date });
    const contraNo = cash > 0 ? await allocate(Contra, "CTR", { at: date }) : null;
    const _id = new mongoose.Types.ObjectId();
    const contraId = cash > 0 ? new mongoose.Types.ObjectId() : null;
    const bankSlipNo = String(b.bankSlipNo || "").trim().slice(0, 30);
    await withTxn(async (session) => {
      for (const c of ordered) {
        const moved = String(c.account) !== String(account._id) ? { account: account._id, accountName: account.name } : {};
        // Taken only while it is still in hand: a cheque deposited by someone else meanwhile is not deposited twice.
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
        _id, slipNo: slip.number, financialYear: slip.financialYear, sequence: slip.sequence, requestId,
        date, account: account._id, accountName: account.name, bankSlipNo,
        cheques: ordered.map((c) => ({
          payment: c._id, voucherNo: c.voucherNo, chequeNo: c.cheque?.number || "", bank: c.cheque?.bank || "", chequeDate: c.cheque?.date || c.date, partyName: c.partyName, amount: c.amount,
          ...(String(c.account) !== String(account._id) ? { accountBefore: c.account, accountNameBefore: c.accountName || "" } : {}),
        })),
        cash, ...(cash > 0 ? { cashFrom: cashFrom._id, contra: contraId, contraNo: contraNo.number } : {}), total, createdBy: req.user?._id,
        fingerprints: [fp(ACTION_CODES.DEPOSIT_POSTED, { _id }, req, { slipNo: slip.number, account: account.name, cheques: ordered.length, cash, total })],
      }], { session });
    });
    return DepositSlip.findById(_id).select("-fingerprints").lean();
  };
  // Cash out of a box, one deposit at a time: what the box holds is looked
  // up and then the cash is taken, and two deposits together each found
  // enough for itself. (Cheques need no lease: each is taken by a write
  // that is refused once it is no longer in hand.)
  return cash > 0 ? onceAtATime(`cash-box:${cashFrom._id}`, write, { what: "Cash from this box" }) : write();
}

/**
 * Cancel a slip made by mistake, as a whole: its cheques go back in
 * hand, into the account each was entered against, and its cash contra
 * is cancelled with it. Refused once the bank has acted on any cheque
 * of it (cleared, or returned unpaid): the slip was handed in.
 *
 * req.body: { reason, lockOverride? }
 * @returns {{ slip, chequesBack, note? }}
 */
async function cancel(id, req) {
  if (!isId(id)) throw new ErrorHandler("Slip not found", 404);
  const slip = await DepositSlip.findById(id).lean();
  if (!slip) throw new ErrorHandler("Slip not found", 404);
  if (slip.status === "cancelled") throw new ErrorHandler("Already cancelled", 409);
  const reason = reasonFrom(req);
  await assertOpen(slip.date, req, { cancelling: true });
  const at = new Date();
  const back = [];     // cheques put back in hand
  await withTxn(async (session) => {
    back.length = 0;
    // Cancelled once: two cancels together cannot both put the cheques back.
    const r = await DepositSlip.updateOne(
      { _id: slip._id, status: { $ne: "cancelled" } },
      { $set: { status: "cancelled", cancel: { reason, at, by: req.user?._id } },
        $push: { fingerprints: fp(ACTION_CODES.DEPOSIT_CANCELLED, slip, req, { slipNo: slip.slipNo, reason, cheques: slip.cheques.length, cash: slip.cash, total: slip.total }) } },
      { session },
    );
    if (!r.modifiedCount) throw new ErrorHandler("Already cancelled", 409);

    for (const c of slip.cheques) {
      const to = c.accountBefore ? { account: c.accountBefore, accountName: c.accountNameBefore || "" } : {};
      // Only a cheque still deposited on THIS slip goes back in hand.
      const was = await Payment.findOneAndUpdate(
        { _id: c.payment, status: "posted", "cheque.status": "deposited", "cheque.slipNo": slip.slipNo },
        { $set: { "cheque.status": "held", ...to }, $unset: { "cheque.depositedOn": "", "cheque.slipNo": "" },
          $push: { fingerprints: fp(ACTION_CODES.PDC_UPDATED, { _id: c.payment }, req, { voucherNo: c.voucherNo, cheque: c.chequeNo, from: "deposited", to: "held", slipNo: slip.slipNo, reason: `${slip.slipNo} cancelled`, ...(to.accountName ? { account: to.accountName } : {}) }) } },
        { session, new: false },
      ).select("_id").lean();
      if (was) { back.push(c.voucherNo); continue; }
      const now = await Payment.findById(c.payment).select("status cheque").session(session).lean();
      const state = now?.cheque?.slipNo === slip.slipNo ? now.cheque.status : "";
      if (state === "cleared") throw new ErrorHandler(`Cheque ${c.chequeNo || c.voucherNo} has cleared — the bank took this slip, so it cannot be cancelled`, 409);
      if (state === "bounced") throw new ErrorHandler(`Cheque ${c.chequeNo || c.voucherNo} was returned unpaid by the bank — this slip was handed in, so it cannot be cancelled`, 409);
      // Otherwise the cheque is not on this slip any more (its receipt was cancelled, or it was put back by hand): nothing to put back.
    }

    if (slip.contra) {
      const contra = await Contra.findOneAndUpdate(
        { _id: slip.contra, status: "posted" },
        { $set: { status: "cancelled", cancel: { reason: `${slip.slipNo} cancelled: ${reason}`.slice(0, 300), at, by: req.user?._id } },
          $unset: { bankLineFrom: "", bankLineTo: "" },
          $push: { fingerprints: fp(ACTION_CODES.CONTRA_CANCELLED, { _id: slip.contra }, req, { contraNo: slip.contraNo, reason, slipNo: slip.slipNo }) } },
        { session, new: false },
      ).select("bankLineFrom bankLineTo").lean();
      // (A contra cancelled by itself before that was stopped is already gone: nothing more to do.)
      if (contra) {
        // Posted from a bank line: the request id goes with it, so the line can be posted afresh.
        if (contra.bankLineFrom || contra.bankLineTo) await Contra.updateOne({ _id: slip.contra }, { $unset: { requestId: "" } }, { session });
        await bankLines.freeLinesOf(slip.contra, slip.contraNo, session);
      }
    }
  });
  // A slip made before slips kept which account each cheque was entered
  // against (it has no status of its own) cannot say where they belong.
  const older = !slip.status && back.length > 0;
  return {
    slip: await DepositSlip.findById(slip._id).select("-fingerprints").lean(), chequesBack: back,
    ...(older ? { note: `The cheque${back.length === 1 ? " is" : "s are"} in hand again under ${slip.accountName}. This slip was made before the app kept which account each cheque was entered against: pick the right bank when ${back.length === 1 ? "it is" : "they are"} deposited again.` } : {}),
  };
}

/** The live slip whose cash this contra is, if any: such a contra is cancelled with its slip, not by itself. */
const owning = (contraId) => DepositSlip.findOne({ contra: contraId, status: { $ne: "cancelled" } }).select("slipNo").lean();

module.exports = { post, cancel, owning };
