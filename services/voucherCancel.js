'use strict';
// ══════════════════════════════════════════════════════════════════
//  CANCELLING A RECEIPT OR PAYMENT VOUCHER
//
//  Everything the voucher did, undone in one transaction: the amounts
//  it settled on each document put back (and an expense's paid marks
//  cleared), its row off the party ledger, the voucher itself marked
//  cancelled with the reason. The cancel route and a bounced cheque
//  both come through here.
// ══════════════════════════════════════════════════════════════════

const ErrorHandler = require('../utils/ErrorHandler');
const Payment = require('../models/Payment');
const Expense = require('../models/Expense');
const settle = require('./settle');
const partyLedger = require('./partyLedger');
const { assertOpen } = require('./booksLock');
const bankLines = require('./bankLines');
const { r2, fp, withTxn } = require('./accountsHelpers');
const { ACTION_CODES } = require('../utils/fingerprint');

const REFUND_MODELS = { Payment: () => Payment, AccountNote: () => require('../models/AccountNote'), OpeningBalance: () => require('../models/OpeningBalance') };

const VOUCHER_FIELD = { Invoice: 'paidAmount', SupplierBill: 'paidAmount', Expense: 'paidAmount', OpeningBalance: 'settledAmount' };

/**
 * @param v       the voucher as the caller read it (lean): used to say
 *                which voucher and for the checks made before anything
 *                is written. What is reversed is NOT taken from it.
 * @param reason  why
 * @param req     the actor
 * @param extra   more fields to set on the voucher in the same write
 *
 * The voucher is marked cancelled inside the transaction by a write
 * that hands back the voucher as it stood at that moment, and the
 * allocations and refunds reversed are that record's. A credit applied
 * to an invoice between the caller's read and this transaction is on
 * that record, so it is reversed with the rest; reversing from the
 * caller's earlier read left the invoice settled by a cancelled
 * receipt. The same write takes the voucher's bank line off it, and the
 * statement lines that pointed at it go back to be placed
 * (services/bankLines.js): a cancelled voucher answers nothing.
 */
async function cancelVoucher(v, reason, req, { extra = {}, code = ACTION_CODES.PAYMENT_CANCELLED, meta = {} } = {}) {
  if (v.status === 'cancelled') throw new ErrorHandler('Already cancelled', 409);
  await assertOpen(v.date, req, { cancelling: true });
  const cancel = { reason, at: new Date(), by: req?.user?._id };
  const mark = fp(code, v, req, { voucherNo: v.voucherNo, reason, ...meta });
  await withTxn(async (session) => {
    // A refund paid this voucher's credit back: that is cancelled first.
    // Asked inside the transaction, so a refund posted a moment ago is seen.
    const refundedBy = await Payment.findOne({ status: 'posted', 'refunds.source': v._id }).select('voucherNo').session(session).lean();
    if (refundedBy) throw new ErrorHandler(`${v.voucherNo} was refunded by ${refundedBy.voucherNo} — cancel that first`, 409);
    const was = await Payment.findOneAndUpdate(
      { _id: v._id, status: 'posted' },
      { $set: { status: 'cancelled', cancel, ...extra }, $unset: { bankLine: '' }, $push: { fingerprints: mark } },
      { session, new: false }
    ).select('voucherNo allocations refunds bankLine requestId').lean();
    if (!was) throw new ErrorHandler('Already cancelled', 409);
    // Posted from a bank line: the line is free to be posted again, so
    // the request id it was posted under must not hand back this
    // cancelled voucher as if it were the answer.
    if (was.bankLine && was.requestId) await Payment.updateOne({ _id: v._id }, { $unset: { requestId: '' } }, { session });
    for (const a of was.allocations || []) {
      if (a.docType === 'SupplierBill') {
        await settle.apply('SupplierBill', a.doc, { paidAmount: -r2(a.amount - (a.tds || 0)), tdsAmount: -(a.tds || 0) }, session);
      } else if (a.docType === 'Expense') {
        await settle.apply('Expense', a.doc, { paidAmount: -a.amount }, session);
        await Expense.updateOne({ _id: a.doc, status: 'approved' }, { $unset: { paidFrom: 1, paidAt: 1 } }, { session });
      } else {
        await settle.apply(a.docType, a.doc, { [VOUCHER_FIELD[a.docType]]: -a.amount }, session);
      }
    }
    for (const x of was.refunds || []) {
      const Model = REFUND_MODELS[x.sourceType]();
      const field = x.sourceType === 'Payment' ? 'unallocated' : 'unapplied';
      await Model.updateOne({ _id: x.source }, [{ $set: { [field]: { $round: [{ $add: [{ $ifNull: [`$${field}`, 0] }, x.amount] }, 2] } } }], { session });
    }
    await partyLedger.reverse('Payment', v._id, session);
    await bankLines.freeLinesOf(v._id, was.voucherNo || v.voucherNo, session);
  });
  return Payment.findById(v._id).select('-attachments.data').lean();
}

module.exports = { cancelVoucher, VOUCHER_FIELD };
