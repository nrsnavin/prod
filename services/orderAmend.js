'use strict';
// ══════════════════════════════════════════════════════════════════
//  ADDING AN ELASTIC TO AN APPROVED ORDER — the rare case
//
//  An order's lines are set before approval, and approval is where
//  the yarn for them is drawn. Rarely the customer adds a product
//  after that, or the floor has to put one on a running loom that the
//  order never asked for. Rather than cancel and re-approve the whole
//  order — refunding and re-drawing every material — the one line is
//  added, with a reason, and its own yarn drawn the way approval would
//  have drawn it:
//
//    • the requirement for the added quantity alone is worked out and
//      checked against stock; short, it is refused with the shortfall,
//      or, forced with a reason, draws what there is — exactly the
//      force-approval rule, so the ledger reads the same either way;
//    • the draw is an ORDER_APPROVAL outward on the order (so a cancel
//      refunds it and the P&L sees it) with a ledger row of its own
//      type, ORDER_AMENDMENT, so the material's history says why;
//    • the elastic is reserved for the order, the order's pending and
//      requirement grow by the line, and the amendment is kept on the
//      order with what it drew and what it was short.
//
//  Once on the order, the elastic can go on a job: raised normally, or
//  put on a running loom mid-run (services/jobMidRun.js).
// ══════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');
const Order = require('../models/Order');
const RawMaterial = require('../models/RawMaterial');
const Elastic = require('../models/Elastic');
const MaterialOutward = require('../models/MaterialOut.cjs');
const ErrorHandler = require('../utils/ErrorHandler');
const { assertVersion } = require('../utils/versioning');
const { buildFingerprint, ACTION_CODES } = require('../utils/fingerprint');
const { applyMovement } = require('../utils/elasticStock');
const { appendStockMovement } = require('../utils/stockLedger');
const { costOf } = require('../utils/materialValuation');
const { computeMaterialRequirement } = require('../utils/materialRequirement');

const MIN_REASON = 8;
const AMENDABLE = ['Approved', 'InProgress'];
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * Add one elastic line to an approved order, drawing its yarn.
 *
 * @param {ClientSession} session   inside withTransaction
 * @param {object} input
 *   orderId, elastic, quantity, rate (optional, ₹/m), reason,
 *   force, forceReason (when drawing through a shortfall),
 *   actor, userId, req (for the version check)
 * @returns {{ order, line, requirement, shortfalls, drawn, forced, stockoutSnapshots }}
 */
async function addElasticToOrder(session, {
  orderId, elastic, quantity, rate, reason, force = false, forceReason = '', actor, userId, req,
}) {
  if (!mongoose.isValidObjectId(orderId)) throw new ErrorHandler('Order not found', 404);
  if (!mongoose.isValidObjectId(elastic)) throw new ErrorHandler('Choose the elastic to add', 400);
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new ErrorHandler('quantity must be a positive number', 400);
  const why = String(reason || '').trim();
  if (why.length < MIN_REASON) {
    throw new ErrorHandler(`Adding to an approved order needs a reason (at least ${MIN_REASON} characters).`, 400);
  }
  const lineRate = rate === undefined || rate === null || rate === '' ? 0 : Number(rate);
  if (!Number.isFinite(lineRate) || lineRate < 0) throw new ErrorHandler('rate must be 0 or more', 400);

  const order = await Order.findById(orderId).session(session);
  if (!order) throw new ErrorHandler('Order not found', 404);
  if (req) assertVersion(order, req);
  if (!AMENDABLE.includes(order.status)) {
    throw new ErrorHandler(
      order.status === 'Open'
        ? 'This order is not approved yet: edit its lines instead.'
        : `An elastic can be added while the order is approved or in progress (it is ${order.status}).`,
      400
    );
  }
  if ((order.elasticOrdered || []).some((l) => String(l.elastic) === String(elastic))) {
    throw new ErrorHandler('That elastic is on the order already.', 400);
  }
  const elasticDoc = await Elastic.findById(elastic).select('name').session(session);
  if (!elasticDoc) throw new ErrorHandler('Elastic not found', 404);

  // ── The yarn this line alone needs, against the shelf ──────────
  const requirement = await computeMaterialRequirement([{ elastic, quantity: qty }]);
  const shortfalls = [];
  const materials = new Map();
  for (const rm of requirement) {
    const material = await RawMaterial.findById(rm.rawMaterial).session(session);
    if (!material) throw new ErrorHandler(`Raw material ${rm.name || rm.rawMaterial} not found`, 404);
    materials.set(String(rm.rawMaterial), material);
    const wanted = r3(rm.requiredWeight);
    const have = Number(material.stock) || 0;
    if (have < wanted) {
      const short = {
        materialId: String(material._id), rawMaterial: material._id, materialName: material.name, name: material.name,
        available: r3(have), required: wanted, short: r3(wanted - have),
      };
      if (!force) {
        const err = new ErrorHandler(
          `Insufficient stock for ${material.name} (have ${r3(have)}, need ${wanted}). Force it with a reason to draw what there is.`,
          400
        );
        err.code = 'INSUFFICIENT_STOCK';
        err.shortfall = short;
        err.details = { shortfalls: [short], requirement };
        throw err;
      }
      shortfalls.push(short);
    }
  }
  const forced = force === true && shortfalls.length > 0;
  const forceWhy = String(forceReason || '').trim();
  if (forced && forceWhy.length < MIN_REASON) {
    throw new ErrorHandler(`forceReason must be at least ${MIN_REASON} characters when drawing through a shortfall`, 400);
  }

  // ── Draw it, as approval does ───────────────────────────────────
  const now = new Date();
  const drawn = [];
  const stockoutSnapshots = [];
  for (const rm of requirement) {
    const material = materials.get(String(rm.rawMaterial));
    const oldStock = Number(material.stock) || 0;
    const wanted = r3(rm.requiredWeight);
    if (wanted <= 0) continue;
    const applied = r3(Math.max(0, Math.min(wanted, oldStock)));
    material.stock = r3(Math.max(0, oldStock - wanted));
    material.totalConsumption = r3((material.totalConsumption || 0) + applied);
    await material.save({ session });
    stockoutSnapshots.push({ materialId: material._id, oldStock, newStock: Number(material.stock) });
    await appendStockMovement(material._id, {
      type: 'ORDER_AMENDMENT', order: order._id,
      refNo: order.orderNo != null ? String(order.orderNo) : '',
      quantity: -applied, balance: material.stock,
      requested: applied === wanted ? undefined : -wanted,
      unitCost: costOf(material),
    }, session);
    // The same outward type as approval, so a cancel refunds it and the
    // order's issued material counts it; the remark says what it was.
    await MaterialOutward.create([{
      rawMaterial: material._id, quantity: applied, order: order._id, type: 'ORDER_APPROVAL', outwardDate: now,
      unitPrice: costOf(material),
      remarks: `Order #${order.orderNo ?? ''} amended — ${elasticDoc.name} added`
        + (applied < wanted ? ` (forced — requested ${wanted}, short ${r3(wanted - applied)})` : ''),
    }], { session });
    order.fingerprints.push(buildFingerprint(ACTION_CODES.RAW_MATERIAL_DEDUCTED, {
      entityId: order._id, actor,
      meta: { rawMaterialId: String(material._id), rawMaterialName: material.name, requested: wanted, applied, unit: 'kg', balanceAfter: material.stock, amendment: elasticDoc.name },
    }));
    drawn.push({ rawMaterial: material._id, name: material.name, requested: wanted, applied });

    // The order's requirement grows by this line; the lots it had set
    // aside on the material stay as they were.
    const row = (order.rawMaterialRequired || []).find((r) => String(r.rawMaterial) === String(material._id));
    if (row) row.requiredWeight = r3((Number(row.requiredWeight) || 0) + wanted);
    else order.rawMaterialRequired.push({ rawMaterial: material._id, name: material.name, requiredWeight: wanted });
  }

  // ── The line, and the hold on the elastic ───────────────────────
  const line = { elastic, quantity: qty, rate: lineRate, addedLater: true, addedAt: now };
  order.elasticOrdered.push(line);
  order.pendingElastic.push({ elastic, quantity: qty });
  order.producedElastic.push({ elastic, quantity: 0 });
  order.packedElastic.push({ elastic, quantity: 0 });
  order.reservations.push({ elastic, quantity: qty });
  await applyMovement(session, {
    elasticId: elastic, type: 'RESERVATION_HOLD', quantity: +qty,
    refType: 'Order', refId: order._id, reason: `Order ${order.orderNo ?? order._id} amended: ${elasticDoc.name} added`, by: userId,
  });
  order.fingerprints.push(buildFingerprint(ACTION_CODES.STOCK_RESERVED, {
    entityId: order._id, actor, meta: { elasticId: String(elastic), elasticName: elasticDoc.name, quantity: qty },
  }));

  order.amendments.push({
    elastic, elasticName: elasticDoc.name, quantity: qty, rate: lineRate, reason: why,
    forced, forceReason: forced ? forceWhy : '', shortfalls, materialsDrawn: drawn,
    recordedBy: userId || null, recordedAt: now,
  });
  order.fingerprints.push(buildFingerprint(ACTION_CODES.ORDER_ELASTIC_ADDED, {
    entityId: order._id, actor,
    meta: {
      elasticId: String(elastic), elasticName: elasticDoc.name, quantity: qty, rate: lineRate, auditReason: why,
      forced, forceReason: forced ? forceWhy : undefined, shortfalls, materialsDrawn: drawn,
    },
  }));
  order.updatedItemsAt = now;
  order.increment();
  await order.save({ session });

  return { order, line, elasticName: elasticDoc.name, requirement, shortfalls, drawn, forced, stockoutSnapshots };
}

module.exports = { addElasticToOrder, MIN_REASON };
