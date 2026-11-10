// ══════════════════════════════════════════════════════════════════
//  ORDERS — HELPERS MORE THAN ONE ORDER FILE USES
//
//  What an order's elastics need in yarn, and giving back what a stopped
//  order was holding.
// ══════════════════════════════════════════════════════════════════

const { computeMaterialRequirement } = require("../utils/materialRequirement.js");
const { buildFingerprint, ACTION_CODES } = require("../utils/fingerprint.js");
const { releaseAllReservations } = require("../services/orderReservations");
const { releaseAllEarmarks } = require("../services/lotAllocation");

// ════════════════════════════════════════════════════════════════
//  SHARED — BOM EXPANSION
// ════════════════════════════════════════════════════════════════
// Delegates to the shared MRP calculator (utils/materialRequirement.js) so
// the order and the job MRP sheet can never drift apart. That version also
// survives a deleted RawMaterial: this one crashed on `material._id` when
// populate handed back null for a dangling reference, and silently dropped
// the line when it didn't.
async function computeRawMaterialRequired(elasticOrdered) {
  return computeMaterialRequirement(elasticOrdered);
}

// ════════════════════════════════════════════════════════════════
//  SHARED — RELEASE ALL REMAINING RESERVATIONS
//
//  Called from /cancel and /complete. For each entry in
//  order.reservations, post a RESERVATION_RELEASE: the promise is
//  given up, and the goods it was holding become available again.
//  No goods move — they were never taken. Clears the array on the
//  order. Fingerprints (STOCK_RELEASED) appended to the order so
//  the timeline shows the release event.
// ════════════════════════════════════════════════════════════════
// Delegates to services/orderReservations.js.
//
// This used to BE the implementation, and it was the only one — so the
// other door into Completed (the last job finishing, which cascades
// through applyOrderStatus in api/job.js) released nothing at all, and
// the reserved stock stayed held for a finished order forever. Moving
// it to a service was the point: one implementation, both callers.
async function _releaseAllReservations(session, order, actor, context) {
  // Dye-lot earmarks are released through the same door, and for the
  // same reason the elastic reservations are: an order that has stopped
  // needing yarn must stop holding it. A Completed order's lots were
  // drawn by its warping batches; a Cancelled one's were never drawn at
  // all. Either way the promise is over, and an earmark nobody releases
  // is yarn on the rack that no other order can plan against.
  //
  // Mutates the order without saving, like releaseAllReservations —
  // both callers save it afterwards along with their own writes.
  const earmarked = releaseAllEarmarks(order);
  if (earmarked > 0) {
    order.fingerprints.push(buildFingerprint(ACTION_CODES.STOCK_RELEASED, {
      entityId: order._id,
      actor,
      meta: { lotEarmarks: true, quantity: earmarked, unit: 'kg', context },
    }));
  }

  return releaseAllReservations(session, order, actor, context);
}

module.exports = {
  computeRawMaterialRequired,
  _releaseAllReservations,
};
