'use strict';
// ══════════════════════════════════════════════════════════════════
//  GIVING BACK WHAT AN ORDER WAS HOLDING
//
//  Approving an order RESERVES elastic stock: `Elastic.reservedStock`
//  goes up, and the order carries a `reservations` array saying how
//  much of each is held for it. Everywhere the floor reads availability
//  it reads `stock − reservedStock`, so a reservation nobody releases
//  is stock that exists and cannot be sold.
//
//  ── Why this is a service and not a helper in one router ─────────
//  An order reaches Completed by TWO doors:
//
//    POST /order/complete      an operator closing it directly
//    POST /job/update-status   the last job finishing, which cascades
//                              through applyOrderStatus
//
//  The first released its reservations. The second only set the status
//  — and Completed is terminal, so /order/complete could never be run
//  on that order afterwards. The stock stayed held for a finished order
//  permanently, and every later order saw less available than there was.
//
//  Nothing errored, and the order looked correctly completed on every
//  screen. A rule enforced at one of two doors into the same state is
//  not a rule, so both now call this.
// ══════════════════════════════════════════════════════════════════

const { applyMovement } = require('../utils/elasticStock');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');

/**
 * Release every remaining reservation on an order.
 *
 * Mutates `order` — appends the fingerprints and empties
 * `order.reservations` — but does NOT save it. The caller owns the
 * save, because both callers are already inside a transaction that has
 * other writes to make.
 *
 * Idempotent by construction: the rows are cleared as they are
 * released, so a second call on the same document finds nothing to do.
 * That matters because the cancel path may already have released them.
 *
 * @param {mongoose.ClientSession} session
 * @param {mongoose.Document} order
 * @param {{id?: string, name?: string}} actor
 * @param {string} context  what to write on the movement, e.g. "order completed"
 * @returns {Promise<Array<{elastic, quantity, fingerprint}>>}
 */
async function releaseAllReservations(session, order, actor, context) {
  if (!order?.reservations || order.reservations.length === 0) return [];
  const released = [];

  for (const r of order.reservations) {
    const qty = Number(r.quantity || 0);
    if (qty <= 0) continue;

    // applyMovement lowers reservedStock and records the resulting
    // balance on the row. Doing it here as well would release twice.
    await applyMovement(session, {
      elasticId: r.elastic,
      type:      'RESERVATION_RELEASE',
      quantity:  +qty,
      refType:   'Order',
      refId:     order._id,
      reason:    `${context} (order ${order.orderNo ?? order._id})`,
      by:        actor?.id,
    });

    const fp = buildFingerprint(ACTION_CODES.STOCK_RELEASED, {
      entityId: order._id,
      actor,
      meta: {
        elasticId: r.elastic.toString(),
        quantity:  qty,
        context,
      },
    });
    order.fingerprints.push(fp);
    released.push({ elastic: r.elastic, quantity: qty, fingerprint: fp });
  }

  // Emptied, not left at zero. A row saying "0 held" and an elastic
  // saying the same thing are two records of one fact, and the pair
  // can only ever drift apart.
  order.reservations = [];
  order.markModified('reservations');

  return released;
}

module.exports = { releaseAllReservations };
