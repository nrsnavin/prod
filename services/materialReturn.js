'use strict';
// ══════════════════════════════════════════════════════════════════
//  PUTTING AN ISSUE OF YARN BACK ON THE SHELF
//
//  When what a draw was for is called off — an order cancelled, a job
//  cancelled before it wove — the yarn goes back. One row at a time,
//  the same way whoever calls it off:
//
//    • back at exactly what it left at. The outward row recorded the
//      unit cost at issue time, so the yarn returns carrying the value
//      it took off the shelf; crediting it at TODAY's average would
//      quietly create money every time something was cancelled after a
//      price rise. receiveAtCost moves the weighted average in the same
//      atomic update as the stock, as any other receipt does;
//    • the consumption counter comes down by the same quantity;
//    • a ledger row says what came back and why (`type`);
//    • the outward row is marked reversed and stays in place for the
//      history. Everything that adds up issues skips a reversed row, so
//      no compensating receipt is written — this was not a delivery.
//
//  This was written once, inside the order-cancel route. A job's own
//  draw (services/jobExcessReturn.js) needs the same steps; two copies
//  of code that moves stock are two places for the figures to part.
// ══════════════════════════════════════════════════════════════════

const RawMaterial = require('../models/RawMaterial');
const { appendStockMovement } = require('../utils/stockLedger');
const { receiveAtCost } = require('../utils/materialValuation');

/**
 * @param {mongoose.ClientSession} session
 * @param {mongoose.Document} outward   a MaterialOutward row, not yet reversed
 * @param {object} how
 * @param {string} how.type             the ledger movement type for the return
 * @param {string} [how.refNo]          the order or job number, as a snapshot
 * @param {*}      [how.order]          the order, when the return belongs to one
 * @param {*}      [how.userObjectId]   a real user id, for `reversedBy`
 * @returns {Promise<null|{material, quantity, balanceAfter, unitCost}>}
 *   null when there was nothing to return (no quantity, or the material is gone)
 */
async function returnOutwardToStock(session, outward, { type, refNo = '', order = null, userObjectId = null }) {
  const qty = Number(outward.quantity || 0);
  if (qty <= 0) return null;

  const material = await RawMaterial.findById(outward.rawMaterial).session(session);
  if (!material) return null;

  // The consumption counter first, on its own — `stock` and `avgCost`
  // are moved by receiveAtCost below and must not also be written from
  // this in-memory copy.
  material.totalConsumption = Math.max(0, (Number(material.totalConsumption) || 0) - qty);
  await material.save({ session });

  const unitCost = Number(outward.unitPrice) || 0;
  const restored = await receiveAtCost(outward.rawMaterial, qty, unitCost, session);
  const balanceAfter = restored
    ? Number(restored.stock) || 0
    : (Number(material.stock) || 0) + qty;

  await appendStockMovement(material._id, {
    type,
    ...(order ? { order } : {}),
    refNo,
    quantity: qty,
    balance:  balanceAfter,
    unitCost,
  }, session);

  outward.reversed   = true;
  outward.reversedAt = new Date();
  // reversedBy is an ObjectId ref to User; only a real user id goes in.
  // An actor id can be a sentinel like "system", which would not cast.
  if (userObjectId) outward.reversedBy = userObjectId;
  await outward.save({ session });

  return { material, quantity: qty, balanceAfter, unitCost };
}

module.exports = { returnOutwardToStock };
