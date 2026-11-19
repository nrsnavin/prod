'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHAT EVERY PURCHASE ORDER IS HELD TO
//
//  A PO can be raised from four places — the purchase order form, a
//  clone of an old one, a job's or an order's shortfall, and "Raise PO"
//  on a material in the phone app — and received against from two. Each
//  had its own copy of the rules, or none: the phone's route gave the PO
//  no number and stored its lines as sent, and its receipt route added
//  decimals up unrounded, which left a PO received in two lots "Partial"
//  for good. They are here once.
// ══════════════════════════════════════════════════════════════════

const mongoose      = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const RawMaterial   = require('../models/RawMaterial');
const Supplier      = require('../models/Supplier');
const ErrorHandler  = require('../utils/ErrorHandler');
const { nextNumber } = require('../utils/sequence');
const { parseMoney, MAX_RATE } = require('../utils/money');
const { round3 } = require('../utils/quantity');

/**
 * The next PO number: an atomic counter, seeded once from the highest
 * number in use. (Reading the highest and adding one could give two POs
 * raised together the same number.)
 */
async function nextPoNumber() {
  return nextNumber('poNo', async () => {
    const last = await PurchaseOrder.findOne({ poNo: { $ne: null } }, { poNo: 1 }).sort({ poNo: -1 }).lean();
    return last?.poNo || 1000;
  });
}

/** What is still to come on a PO line; never less than nothing. */
const pendingOf = (item) => Math.max(0, round3((Number(item?.quantity) || 0) - (Number(item?.receivedQuantity) || 0)));

/**
 * A PO's status from its lines. Quantities are compared to three places:
 * 227.69 + 168.85 is 396.53999999999996, a hair short of the 396.54
 * ordered, and compared as it fell the PO stayed "Partial" for good.
 */
function deriveStatus(items) {
  if (!items || items.length === 0) return 'Open';
  const allDone = items.every((i) => round3(i.receivedQuantity) >= round3(i.quantity));
  const anyDone = items.some((i) => round3(i.receivedQuantity) > 0);
  if (allDone) return 'Completed';
  if (anyDone) return 'Partial';
  return 'Open';
}

/**
 * The lines of a purchase order as sent, checked:
 *
 *   • a material that is one, once. Two lines for one material cannot
 *     be received: a receipt finds "the" line for its material, which is
 *     always the first, so the second stays pending for good and the PO
 *     never completes;
 *   • a quantity above zero, to three places;
 *   • a price that is one. None is ₹0 ("not priced yet"); a negative
 *     price, or text, used to be stored as sent.
 *
 * Only these three fields are taken from each line: what has been
 * received is never the sender's to say.
 *
 * Returns the lines to store; throws ErrorHandler(400).
 */
async function readPoLines(items) {
  if (!Array.isArray(items) || items.length === 0) throw new ErrorHandler('At least one item is required', 400);
  const seen = new Set();
  const lines = items.map((item, idx) => {
    if (!item || !item.rawMaterial) throw new ErrorHandler(`items[${idx}].rawMaterial is required`, 400);
    const id = String(item.rawMaterial?._id ?? item.rawMaterial);
    if (!mongoose.Types.ObjectId.isValid(id)) throw new ErrorHandler(`items[${idx}].rawMaterial is not a valid id`, 400);
    if (seen.has(id)) {
      throw new ErrorHandler(
        `Line ${idx + 1} is a material already on this purchase order. Put it on one line with the whole quantity — ` +
        `a second line for the same material could never be received.`, 400);
    }
    seen.add(id);
    const q = round3(item.quantity);
    if (!Number.isFinite(Number(item.quantity)) || q <= 0) throw new ErrorHandler(`items[${idx}].quantity must be a positive number`, 400);
    let price = 0;
    if (!(item.price === undefined || item.price === null || item.price === '')) {
      const read = parseMoney(item.price, { max: MAX_RATE, label: `Line ${idx + 1}: the price` });
      if (!read.ok) throw new ErrorHandler(read.reason, 400);
      price = read.value;
    }
    return { rawMaterial: id, price, quantity: q, receivedQuantity: 0 };
  });
  const known = new Set((await RawMaterial.find({ _id: { $in: [...seen] } }).select('_id').lean()).map((m) => String(m._id)));
  const missing = lines.findIndex((l) => !known.has(l.rawMaterial));
  if (missing !== -1) throw new ErrorHandler(`Line ${missing + 1}: that material does not exist`, 400);
  return lines;
}

/**
 * A supplier that is one. An id of nothing used to make a PO from
 * nobody: it listed with a blank supplier and could not be chased.
 * @throws {ErrorHandler} 400
 */
async function assertSupplier(supplier) {
  if (!supplier) throw new ErrorHandler('Supplier is required', 400);
  if (!mongoose.Types.ObjectId.isValid(String(supplier)) || !(await Supplier.exists({ _id: supplier }))) {
    throw new ErrorHandler('That supplier does not exist', 400);
  }
}

// ── OVER-DELIVERY ────────────────────────────────────────────────────
// A supplier sending slightly more than ordered is normal — a full bag
// instead of a part one, a roll that weighed heavy. Refusing it outright
// only pushed the difference into a stock adjustment, which credits the
// same yarn while losing the link to the PO that brought it in.
//
// So a delivery may exceed the line's ordered quantity. Up to this
// fraction over, no explanation is asked for; past it, someone has to
// say why, and that reason is kept on the receipt.
//
// Here, and not in the route, because there are two doors goods come in
// by (the purchase order page, and the older /materials/material-inward)
// and only one of them had the rule.
const OVER_RECEIPT_TOLERANCE = 0.10;
const MIN_EXCESS_REASON = 5;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * One delivery measured against the line it came on.
 *
 * Measured against what was ORDERED, not what is still pending. Against
 * pending, a PO for 100 already 90 received would call a 12-unit
 * delivery a 20% overshoot when it is 2% over the order — and the
 * tolerance is about the delivery against the order.
 *
 * @returns {{ excess: number, reason: string, error: string|null }}
 *   `excess` to two places (0 for an ordinary receipt); `error` is the
 *   refusal to show when the excess is past the tolerance with no reason.
 */
function overReceipt({ ordered, already, incoming, reason }) {
  const want = Number(ordered) || 0;
  const totalAfter = round3((Number(already) || 0) + Number(incoming));
  const excess = Math.max(0, round3(totalAfter - want));
  const allowanceFree = want * OVER_RECEIPT_TOLERANCE;
  const said = String(reason || "").trim();
  if (excess > allowanceFree && said.length < MIN_EXCESS_REASON) {
    return {
      excess: round2(excess),
      reason: said,
      error:
        `Receiving ${totalAfter} against ${want} ordered is ` +
        `${excess} over — past the ` +
        `${Math.round(OVER_RECEIPT_TOLERANCE * 100)}% tolerance ` +
        `(${round2(allowanceFree)}). Give a reason of at least ` +
        `${MIN_EXCESS_REASON} characters to receive it.`,
    };
  }
  // Inside the tolerance a reason is optional, but kept if it was
  // offered — it costs nothing and helps later.
  return { excess: round2(excess), reason: excess > 0 ? said : "", error: null };
}

module.exports = {
  nextPoNumber, pendingOf, deriveStatus, readPoLines, assertSupplier, round3,
  overReceipt, OVER_RECEIPT_TOLERANCE, MIN_EXCESS_REASON,
};
