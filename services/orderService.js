'use strict';
//
// Order domain service. Extracts the transactional core of the fat
// api/order.js route handlers into composable, testable functions so
// the routes shrink to orchestration (session lifecycle + HTTP shaping
// + fire-and-forget side effects).
//
// These functions operate INSIDE a caller-provided Mongo session/
// transaction and never touch req/res — actor, userId and the WhatsApp
// provenance are passed explicitly. They mutate + save within the
// session and return the artefacts the route needs to build the
// response and post-commit hooks. Behaviour is byte-for-byte identical
// to the previous inline handler (pinned by the B0.2 characterization
// tests).

const ErrorHandler   = require('../utils/ErrorHandler');
const Order          = require('../models/Order');
const RawMaterial    = require('../models/RawMaterial');
const Elastic        = require('../models/Elastic');
const MaterialOutward = require('../models/MaterialOut.cjs');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { applyMovement } = require('../utils/elasticStock');
const { appendStockMovement } = require('../utils/stockLedger');
const { costOf } = require('../utils/materialValuation');
const YarnLot = require('../models/YarnLot');
const { validateEarmarks, allocatedByLot } = require('./lotAllocation');

/**
 * Write the dye-lot earmarks for an order, replacing whatever it held.
 *
 * ── Replace, not merge ───────────────────────────────────────────
 * A submission is the whole answer for the materials it names. Merging
 * would make "remove this lot" impossible to express: an absent row
 * and an unmentioned row would mean the same thing, and the only way
 * to unassign would be to send a zero, which the validator rejects.
 * Materials NOT named are left exactly as they were.
 *
 * Validation happens against the free balance excluding this order's
 * own current earmarks — re-saving 60 kg on a lot this order already
 * holds 60 kg of must not read as wanting 120.
 *
 * @param {Array} assignments [{ rawMaterial, lots: [{ yarnLot, quantity }] }]
 * @returns {Promise<Array>} one fingerprint per material touched
 */
async function applyLotAssignments(session, order, assignments, { actor, userId } = {}) {
  if (!Array.isArray(assignments) || assignments.length === 0) return [];

  const mongoose = require('mongoose');
  const fingerprints = [];

  for (const a of assignments) {
    const materialId = String(a?.rawMaterial ?? '');
    if (!mongoose.Types.ObjectId.isValid(materialId)) {
      throw new ErrorHandler('Lot assignment: invalid material', 400);
    }

    const rm = (order.rawMaterialRequired || []).find(
      (r) => String(r.rawMaterial) === materialId
    );
    if (!rm) {
      throw new ErrorHandler(
        'Lot assignment names a material this order does not require',
        400
      );
    }

    const rows = Array.isArray(a.lots) ? a.lots : [];

    // Every lot on the material, not only the open ones: the validator
    // has to be able to say "that lot is quarantined" rather than the
    // much less useful "that lot is not on this material".
    const lots = await YarnLot.find({ rawMaterial: materialId }).session(session);
    const allocated = await allocatedByLot(
      lots.map((l) => l._id),
      { excludeOrder: order._id, session }
    );

    const validated = validateEarmarks(rows, lots, allocated, rm.requiredWeight);
    const stamped = validated.map((v) => ({
      ...v, assignedAt: new Date(), assignedBy: userId || null,
    }));

    rm.lots = stamped;

    const fp = buildFingerprint(ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
      entityId: order._id,
      actor,
      meta: {
        lotAssignment:   true,
        rawMaterialId:   materialId,
        rawMaterialName: rm.name || '',
        requiredWeight:  Number(rm.requiredWeight) || 0,
        assigned:        stamped.reduce((t, r) => t + r.quantity, 0),
        lots:            stamped.map((r) => `${r.lotNo} (${r.quantity})`),
      },
    });
    order.fingerprints.push(fp);
    fingerprints.push(fp);
  }

  return fingerprints;
}

// Approve an Open order inside a transaction: pre-flight stock check,
// (optional) forced-override fingerprint, raw-material deduction +
// ledger + outward rows, elastic reservation, and the approval
// fingerprint + status flip.
//
// @param session   active Mongo session (caller owns the transaction)
// @param opts.orderId
// @param opts.force
// @param opts.forceReason
// @param opts.actor         normalised actor object (fingerprint author)
// @param opts.whatsappActor { from } | undefined (approve provenance)
// @param opts.userId        req.user._id | null (approvedBy / ledger by)
// @returns {
//   order, approveFp, deductionFingerprints, reservationFingerprints,
//   stockoutSnapshots, shortfalls, forced,
// }
async function approveOrderTxn(session, {
  orderId, force = false, forceReason = '', actor, whatsappActor, userId,
  lotAssignments,
} = {}) {
  const mongoose = require('mongoose');
  if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
    throw new ErrorHandler('Valid orderId is required', 400);
  }
  const order = await Order.findById(orderId).session(session);
  if (!order) throw new ErrorHandler('Order not found', 404);
  if (order.status !== 'Open')
    throw new ErrorHandler('Only Open orders can be approved', 400);
  if (!Array.isArray(order.elasticOrdered) || order.elasticOrdered.length === 0) {
    throw new ErrorHandler('Order has no elastic lines — cannot approve', 400);
  }

  // ── Pre-flight stock check ──────────────────────────────────────
  const shortfalls = [];
  for (const rm of order.rawMaterialRequired) {
    const material = await RawMaterial.findById(rm.rawMaterial).session(session);
    if (!material) throw new ErrorHandler('Raw material not found', 404);
    if (material.stock < rm.requiredWeight) {
      if (!force) {
        const err = new ErrorHandler(
          `Insufficient stock for ${material.name} (have ${material.stock}, need ${rm.requiredWeight})`,
          400
        );
        err.code = 'INSUFFICIENT_STOCK';
        err.shortfall = {
          materialId:   rm.rawMaterial.toString(),
          materialName: material.name,
          available:    material.stock,
          required:     rm.requiredWeight,
          short:        rm.requiredWeight - material.stock,
        };
        throw err;
      }
      shortfalls.push({
        materialId:   rm.rawMaterial.toString(),
        materialName: material.name,
        available:    material.stock,
        required:     rm.requiredWeight,
        short:        rm.requiredWeight - material.stock,
      });
    }
  }
  // Reason only demanded when force actually overrides something.
  if (force && shortfalls.length > 0) {
    const reason = String(forceReason || '').trim();
    if (reason.length < 8) {
      throw new ErrorHandler(
        'forceReason must be at least 8 characters when forcing through a shortfall',
        400
      );
    }
  }

  // Standalone force fingerprint (before deductions) capturing the
  // override reason + shortfalls.
  if (force && shortfalls.length > 0) {
    order.fingerprints.push(buildFingerprint(ACTION_CODES.ORDER_APPROVED, {
      entityId: order._id,
      actor,
      meta: { forced: true, reason: String(forceReason).trim(), shortfalls },
    }));
  }

  // ── Deduct raw materials ────────────────────────────────────────
  const deductionFingerprints = [];
  const stockoutSnapshots = [];
  for (const rm of order.rawMaterialRequired) {
    const material = await RawMaterial.findById(rm.rawMaterial).session(session);
    const _oldStock = Number(material.stock) || 0;
    // What was wanted, and what the shelf could actually give. These
    // differ only on a forced approval through a shortfall — which is
    // precisely the case somebody comes back to this ledger to
    // understand, so the gap is recorded on the row rather than left
    // to be inferred from the balance.
    const wanted  = Math.max(0, Number(rm.requiredWeight) || 0);
    const applied = Math.max(0, Math.min(wanted, _oldStock));
    material.stock = Math.max(0, _oldStock - wanted);
    stockoutSnapshots.push({
      materialId: material._id,
      oldStock:   _oldStock,
      newStock:   Number(material.stock),
    });
    material.totalConsumption = (material.totalConsumption || 0) + applied;
    await material.save({ session });
    await appendStockMovement(material._id, {
      // Negative: this debits stock. Stored positive for years, which
      // made every approval read as a receipt on the material's ledger.
      type: 'ORDER_APPROVAL', order: order._id,
      // The order number as well as the id: the ledger has to still name
      // the order years later, when it may have been deleted.
      refNo: order.orderNo != null ? String(order.orderNo) : '',
      quantity: -applied, balance: material.stock,
      // Only when the approval was forced through a shortfall. On the
      // ordinary approval the two agree and the field stays absent, so
      // its presence on a row is a signal rather than noise.
      requested: applied === wanted ? undefined : -wanted,
      // What this yarn was worth as it left. Snapshotted on the row
      // because the average moves with the next receipt, so looking it
      // up later would price this movement at a cost it never had.
      unitCost: costOf(material),
    }, session);
    await MaterialOutward.create([{
      rawMaterial: rm.rawMaterial,
      quantity:    applied,
      order:       order._id,
      type:        'ORDER_APPROVAL',
      outwardDate: new Date(),
      // The weighted average of what the stock cost, not the latest
      // purchase price. This row is what the order P&L reads, so
      // costing it at the newest quote made every order look worse the
      // moment a supplier raised theirs — on yarn bought months before.
      unitPrice:   costOf(material),
      remarks:     applied < wanted
        ? `Order #${order.orderNo ?? ''} approval (forced — requested ${wanted}, short ${wanted - applied})`
        : `Order #${order.orderNo ?? ''} approval`,
    }], { session });

    const deductFp = buildFingerprint(ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
      entityId: order._id,
      actor,
      meta: {
        rawMaterialId:   rm.rawMaterial.toString(),
        rawMaterialName: material.name,
        requested:       wanted,
        applied,
        unit:            'kg',
        balanceAfter:    material.stock,
      },
    });
    order.fingerprints.push(deductFp);
    deductionFingerprints.push(deductFp);
  }

  // ── Earmark the dye lots this draw comes out of ─────────────────
  //
  // Optional, and skipped entirely when the caller sends nothing —
  // which is every approval made before this existed, and the WhatsApp
  // approval path, which carries no material detail. An order with no
  // earmarks behaves exactly as it always has and leaves every
  // downstream picker unconstrained.
  //
  // Earmarking moves NOTHING on the lot. The stock debit above is the
  // commercial draw; the yarn is still on the rack and leaves when a
  // warping batch takes it. See services/lotAllocation.js for why the
  // two must not be collapsed.
  const earmarkFingerprints = await applyLotAssignments(
    session, order, lotAssignments, { actor, userId }
  );

  // ── Reserve elastic units ───────────────────────────────────────
  const reservationFingerprints = [];
  for (const line of order.elasticOrdered) {
    const qty = Number(line.quantity || 0);
    if (qty <= 0) continue;

    const elasticDoc = await Elastic.findById(line.elastic).session(session);
    if (!elasticDoc) throw new ErrorHandler(`Elastic ${line.elastic} not found`, 404);

    order.reservations.push({ elastic: line.elastic, quantity: qty });

    // applyMovement owns reservedStock, as it owns stock. Raising it
    // here as well would double the hold, and writing it by hand at all
    // is why no ledger row could state the reserved balance.
    await applyMovement(session, {
      elasticId: line.elastic,
      type:      'RESERVATION_HOLD',
      quantity:  +qty,
      refType:   'Order',
      refId:     order._id,
      reason:    `Order ${order.orderNo ?? order._id} approved`,
      by:        userId,
    });

    const resFp = buildFingerprint(ACTION_CODES.STOCK_RESERVED, {
      entityId: order._id,
      actor,
      meta: {
        elasticId:   line.elastic.toString(),
        elasticName: elasticDoc.name,
        quantity:    qty,
      },
    });
    order.fingerprints.push(resFp);
    reservationFingerprints.push(resFp);
  }

  // ── Approval fingerprint + status flip ──────────────────────────
  const whatsappFrom = whatsappActor?.from || null;
  const approvalVia  = whatsappFrom ? 'whatsapp' : 'admin';

  const approveFp = buildFingerprint(ACTION_CODES.ORDER_APPROVED, {
    entityId: order._id,
    actor,
    meta: {
      previousStatus:    'Open',
      newStatus:         'Approved',
      forced:            force === true && shortfalls.length > 0,
      forceReason:       force ? String(forceReason).trim() : undefined,
      shortfallCount:    shortfalls.length,
      materialsDeducted: deductionFingerprints.length,
      elasticsReserved:  reservationFingerprints.length,
      via:               approvalVia,
      whatsappFrom:      whatsappFrom || undefined,
    },
  });
  order.fingerprints.push(approveFp);

  order.status               = 'Approved';
  order.approvedBy           = userId || null;
  order.approvedAt           = new Date();
  order.approvalVia          = approvalVia;
  order.approvalWhatsappFrom = whatsappFrom || undefined;
  await order.save({ session });

  return {
    order, approveFp, deductionFingerprints, reservationFingerprints,
    earmarkFingerprints,
    stockoutSnapshots, shortfalls, forced: force === true && shortfalls.length > 0,
  };
}

module.exports = { approveOrderTxn, applyLotAssignments };
