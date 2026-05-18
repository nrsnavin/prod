// utils/elasticStock.js
// ────────────────────────────────────────────────────────────────
//  Elastic stock-movement helper.
//
//  Every change to Elastic.stock must go through applyMovement so
//  the ledger and the running balance stay in lock-step. Always
//  called with an active mongoose session — callers wrap their own
//  domain mutation (packing, DC, wastage, manual adjust) and the
//  stock update in the same `session.withTransaction(...)`.
//
//  Clamping: stock never goes negative. If `quantity` would drive
//  the balance below zero, the recorded `quantity` is reduced to
//  the actually-applied delta so the ledger sum still equals the
//  current `balance`.
// ────────────────────────────────────────────────────────────────
"use strict";

const Elastic = require("../models/Elastic");

const VALID_TYPES = [
  "PACKING_INWARD",
  "PACKING_REVERSE",
  "DC_OUT",
  "DC_CANCEL_RETURN",
  "WASTAGE_OUT",
  "MANUAL_ADJUST",
];

/**
 * Apply a signed stock movement to an Elastic and persist it on
 * the running ledger.
 *
 * @param {mongoose.ClientSession} session   active transaction session
 * @param {object} opts
 * @param {string|ObjectId} opts.elasticId   target Elastic _id
 * @param {string}          opts.type        one of VALID_TYPES
 * @param {number}          opts.quantity    signed delta (+ inward / − outward)
 * @param {string}         [opts.refType]    e.g. 'Packing'|'Wastage'|'DeliveryChallan'
 * @param {ObjectId|string}[opts.refId]      source document id
 * @param {string}         [opts.reason]     human note (MANUAL_ADJUST etc.)
 * @param {ObjectId|string}[opts.by]         acting user id
 * @returns {Promise<{elastic, movement}>}
 */
async function applyMovement(session, opts) {
  const { elasticId, type, quantity, refType, refId, reason, by } = opts || {};

  if (!elasticId)               throw new Error("applyMovement: elasticId is required");
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`applyMovement: invalid type '${type}'`);
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    throw new Error("applyMovement: quantity must be a finite number");
  }

  const elastic = await Elastic.findById(elasticId).session(session);
  if (!elastic) throw new Error(`applyMovement: Elastic ${elasticId} not found`);

  const currentStock = Number(elastic.stock) || 0;
  const requested    = quantity;

  // Clamp to ≥ 0 — record the actually-applied delta.
  const desired = currentStock + requested;
  const newStock = Math.max(0, desired);
  const appliedDelta = newStock - currentStock;

  elastic.stock = newStock;

  const movement = {
    date:     new Date(),
    type,
    quantity: appliedDelta,
    balance:  newStock,
    refType:  refType || undefined,
    refId:    refId   || undefined,
    reason:   reason  || undefined,
    by:       by      || undefined,
  };

  elastic.stockMovements.push(movement);
  await elastic.save({ session });

  // The last pushed sub-doc carries its assigned _id post-save.
  const persisted = elastic.stockMovements[elastic.stockMovements.length - 1];

  return { elastic, movement: persisted };
}

module.exports = { applyMovement, VALID_TYPES };
