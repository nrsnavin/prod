// utils/elasticStock.js
// ─────────────────────────────────────────────────────────────
//  Elastic stock-movement helper.
//
//  Every change to Elastic.stock must go through applyMovement so
//  the ledger and the running balance stay in lock-step.
//
//  Atomicity model:
//   1. Read current stock from Elastic.
//   2. Compute the clamped delta (stock floor = 0).
//   3. findOneAndUpdate with { _id, stock: <observed> } so the
//      write only lands if no concurrent writer changed stock in
//      between. On miss we retry up to MAX_RETRIES times.
//   4. Insert the matching StockMovement row.
//
//  Both the Elastic update and the StockMovement insert run inside
//  the caller-supplied session, so they commit or roll back as a
//  single unit.
//
//  RESERVATION_HOLD / RESERVATION_RELEASE rows skip the stock
//  mutation entirely — they're info-only audit entries used by
//  the order-reservation flow.
//
//  Magnitude guard: |quantity| > MAX_ABS_QUANTITY is rejected so a
//  rogue caller (UI typo, malformed payload) can't blow up the
//  ledger. Manual corrections that genuinely need a larger jump
//  should be split or applied directly by an operator.
// ─────────────────────────────────────────────────────────────
"use strict";

const Elastic       = require("../models/Elastic");
const StockMovement = require("../models/StockMovement");

const VALID_TYPES = [
  "PACKING_INWARD",
  "PACKING_REVERSE",
  "DC_OUT",
  "DC_CANCEL_RETURN",
  "WASTAGE_OUT",
  "WASTAGE_RETURN",
  "MANUAL_ADJUST",
  "RESERVATION_HOLD",
  "RESERVATION_RELEASE",
];

const INFO_ONLY_TYPES = new Set(["RESERVATION_HOLD", "RESERVATION_RELEASE"]);

const MAX_RETRIES      = 5;
const MAX_ABS_QUANTITY = 1e7;

async function applyMovement(session, opts) {
  const {
    elasticId,
    type,
    quantity,
    refType,
    refId,
    reason,
    by,
    alsoIncProduced = false,
  } = opts || {};

  if (!elasticId) {
    throw new Error("applyMovement: elasticId is required");
  }
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`applyMovement: invalid type '${type}'`);
  }

  const requested = Number(quantity);
  if (!Number.isFinite(requested)) {
    throw new Error("applyMovement: quantity must be a finite number");
  }
  if (Math.abs(requested) > MAX_ABS_QUANTITY) {
    throw new Error(
      `applyMovement: |quantity| ${Math.abs(requested)} exceeds safety cap ${MAX_ABS_QUANTITY}`
    );
  }

  if (INFO_ONLY_TYPES.has(type)) {
    const elastic = await Elastic.findById(elasticId).session(session);
    if (!elastic) {
      throw new Error(`applyMovement: Elastic ${elasticId} not found`);
    }
    const [persisted] = await StockMovement.create(
      [
        {
          elastic:   elastic._id,
          date:      new Date(),
          type,
          requested,
          applied:   0,
          balance:   Number(elastic.stock) || 0,
          refType:   refType || undefined,
          refId:     refId || undefined,
          reason:    reason || undefined,
          by:        by || undefined,
        },
      ],
      { session }
    );
    return { elastic, movement: persisted };
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await Elastic.findById(elasticId).session(session);
    if (!current) {
      throw new Error(`applyMovement: Elastic ${elasticId} not found`);
    }

    const currentStock = Number(current.stock) || 0;
    const desired      = currentStock + requested;
    const newStock     = Math.max(0, desired);
    const applied      = newStock - currentStock;

    const inc = { stock: applied };
    if (alsoIncProduced) inc.quantityProduced = applied;

    const updated = await Elastic.findOneAndUpdate(
      { _id: elasticId, stock: currentStock },
      { $inc: inc },
      { new: true, session }
    );

    if (!updated) continue;

    const [persisted] = await StockMovement.create(
      [
        {
          elastic:   updated._id,
          date:      new Date(),
          type,
          requested,
          applied,
          balance:   Number(updated.stock) || 0,
          refType:   refType || undefined,
          refId:     refId || undefined,
          reason:    reason || undefined,
          by:        by || undefined,
        },
      ],
      { session }
    );

    return { elastic: updated, movement: persisted };
  }

  throw new Error(
    `applyMovement: contention on Elastic ${elasticId} after ${MAX_RETRIES} retries`
  );
}

module.exports = { applyMovement, VALID_TYPES, MAX_ABS_QUANTITY };
