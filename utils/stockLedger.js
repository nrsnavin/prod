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

module.exports = { appendStockMovement, MAX_EMBEDDED_MOVEMENTS };
