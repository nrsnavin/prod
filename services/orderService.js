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
    const applied = Math.min(rm.requiredWeight, material.stock);
    material.stock = Math.max(0, material.stock - rm.requiredWeight);
    stockoutSnapshots.push({
      materialId: material._id,
      oldStock:   _oldStock,
      newStock:   Number(material.stock),
    });
    material.totalConsumption = (material.totalConsumption || 0) + applied;
    material.stockMovements?.push({
      date: new Date(), type: 'ORDER_APPROVAL', order: order._id,
      quantity: applied, balance: material.stock,
    });
    await material.save({ session });
    await MaterialOutward.create([{
      rawMaterial: rm.rawMaterial,
      quantity:    applied,
      order:       order._id,
      type:        'ORDER_APPROVAL',
      outwardDate: new Date(),
      unitPrice:   material.price ?? 0,
      remarks:     applied < rm.requiredWeight
        ? `Order #${order.orderNo ?? ''} approval (forced — requested ${rm.requiredWeight}, short ${rm.requiredWeight - applied})`
        : `Order #${order.orderNo ?? ''} approval`,
    }], { session });

    const deductFp = buildFingerprint(ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
      entityId: order._id,
      actor,
      meta: {
        rawMaterialId:   rm.rawMaterial.toString(),
        rawMaterialName: material.name,
        requested:       rm.requiredWeight,
        applied,
        unit:            'kg',
        balanceAfter:    material.stock,
      },
    });
    order.fingerprints.push(deductFp);
    deductionFingerprints.push(deductFp);
  }

  // ── Reserve elastic units ───────────────────────────────────────
  const reservationFingerprints = [];
  for (const line of order.elasticOrdered) {
    const qty = Number(line.quantity || 0);
    if (qty <= 0) continue;

    const elasticDoc = await Elastic.findById(line.elastic).session(session);
    if (!elasticDoc) throw new ErrorHandler(`Elastic ${line.elastic} not found`, 404);
    elasticDoc.reservedStock = (Number(elasticDoc.reservedStock) || 0) + qty;
    await elasticDoc.save({ session });

    order.reservations.push({ elastic: line.elastic, quantity: qty });

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
    stockoutSnapshots, shortfalls, forced: force === true && shortfalls.length > 0,
  };
}

module.exports = { approveOrderTxn };
