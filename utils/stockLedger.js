'use strict';
//
// Appending to RawMaterial.stockMovements.
//
// The array is `select: false` on the schema, so a plain findById does not
// load it and a load-modify-save would silently append nothing. Appending
// with $push instead is both correct and better: nothing has to be read to
// write one row, the whole document is not rewritten each time, and $slice
// enforces the cap inside the database rather than trusting every caller.
//
// The authoritative history is MaterialInward / MaterialOutward — this array
// is the convenience tail the material detail page shows (newest 50), so
// keeping a bounded window loses nothing operational.

const RawMaterial = require('../models/RawMaterial');

const { MAX_EMBEDDED_MOVEMENTS } = RawMaterial;

/**
 * Append one movement row to a material's embedded ledger, trimming the
 * array to its cap in the same atomic update.
 *
 * @param {ObjectId|string} materialId
 * @param {{date?: Date, type: string, order?: any, quantity: number, balance: number}} movement
 * @param {ClientSession} [session]
 */
async function appendStockMovement(materialId, movement, session) {
  return RawMaterial.updateOne(
    { _id: materialId },
    {
      $push: {
        stockMovements: {
          // $each + $slice: keep only the newest N. A negative slice keeps
          // the tail, which is the newest since rows are appended in order.
          $each:  [{ date: new Date(), ...movement }],
          $slice: -MAX_EMBEDDED_MOVEMENTS,
        },
      },
    },
    session ? { session } : {}
  );
}

/**
 * Which way each movement type moves stock.
 *
 * The sign convention is: quantity is the DELTA applied to stock, so a
 * deduction is negative. `ORDER_APPROVAL` was written positive for years
 * even though it debits stock, which made every approval read as a
 * receipt on the ledger — the row said "+40" while the balance beside it
 * went down by 40.
 *
 * New writes carry the right sign. This map exists for the rows already
 * in the database: their direction is knowable from the type, so the
 * display can be corrected without a migration.
 *
 * STOCK_ADJUST is deliberately absent — it is the one type that is
 * genuinely signed either way, and its stored sign is the truth.
 */
const MOVEMENT_DIRECTION = {
  ORDER_APPROVAL:      -1,
  JOB_CONSUMPTION:     -1,
  PO_INWARD:           +1,
  ORDER_CANCEL_REFUND: +1,
};

/**
 * Put a newest-first movement list into a shape the ledger can render:
 * every quantity signed by its direction, and a running balance on rows
 * that never recorded one.
 *
 * @param {Array} movements newest-first
 * @param {number} currentStock the material's stock right now — the
 *        balance immediately after the newest movement
 */
function normaliseMovements(movements = [], currentStock = 0) {
  const signed = movements.map((m) => {
    const row = typeof m.toObject === 'function' ? m.toObject() : { ...m };
    const dir = MOVEMENT_DIRECTION[row.type];
    const qty = Number(row.quantity) || 0;
    // Math.abs first: a row already stored with the right sign must not
    // be flipped back by applying the direction a second time.
    row.quantity = dir ? Math.abs(qty) * dir : qty;
    return row;
  });

  // Walk backwards from today's stock. Rows are newest-first, so the
  // newest row's closing balance is the current stock, and each older
  // row closed at the balance before the row after it.
  //
  // Only fills gaps. A balance that was actually recorded at the time is
  // a better fact than one reconstructed now, so it is left alone.
  let running = Number(currentStock) || 0;
  for (const row of signed) {
    if (row.balance === undefined || row.balance === null) row.balance = running;
    running = (Number(row.balance) || 0) - row.quantity;
  }
  return signed;
}

module.exports = {
  appendStockMovement,
  normaliseMovements,
  MOVEMENT_DIRECTION,
  MAX_EMBEDDED_MOVEMENTS,
};
