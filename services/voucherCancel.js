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
const { r2, fp, withTxn } = require('./accountsHelpers');
const { ACTION_CODES } = require('../utils/fingerprint');

const VOUCHER_FIELD = { Invoice: 'paidAmount', SupplierBill: 'paidAmount', Expense: 'paidAmount', OpeningBalance: 'settledAmount' };

/**
 * @param v       the voucher (lean)
 * @param reason  why
 * @param req     the actor
 * @param extra   more fields to set on the voucher in the same write
 */
async function cancelVoucher(v, reason, req, { extra = {}, code = ACTION_CODES.PAYMENT_CANCELLED, meta = {} } = {}) {
  if (v.status === 'cancelled') throw new ErrorHandler('Already cancelled', 409);
  await assertOpen(v.date, req, { cancelling: true });
  const cancel = { reason, at: new Date(), by: req?.user?._id };
  const mark = fp(code, v, req, { voucherNo: v.voucherNo, reason, ...meta });
  await withTxn(async (session) => {
    const res = await Payment.updateOne({ _id: v._id, status: 'posted' }, { $set: { status: 'cancelled', cancel, ...extra }, $push: { fingerprints: mark } }, { session });
    if (!res.modifiedCount) throw new ErrorHandler('Already cancelled', 409);
    for (const a of v.allocations || []) {
      if (a.docType === 'SupplierBill') {
        await settle.apply('SupplierBill', a.doc, { paidAmount: -r2(a.amount - (a.tds || 0)), tdsAmount: -(a.tds || 0) }, session);
      } else if (a.docType === 'Expense') {
        await settle.apply('Expense', a.doc, { paidAmount: -a.amount }, session);
        await Expense.updateOne({ _id: a.doc, status: 'approved' }, { $unset: { paidFrom: 1, paidAt: 1 } }, { session });
      } else {
        await settle.apply(a.docType, a.doc, { [VOUCHER_FIELD[a.docType]]: -a.amount }, session);
      }
    }
    await partyLedger.reverse('Payment', v._id, session);
  });
  return Payment.findById(v._id).select('-attachments.data').lean();
}

module.exports = { cancelVoucher, VOUCHER_FIELD };
