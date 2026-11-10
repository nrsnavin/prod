// ══════════════════════════════════════════════════════════════════
//  ORDERS — APPROVE, ADD AN ELASTIC, CANCEL, START  (part of /api/v2/order)
//
//  Approval draws the yarn and reserves the elastic; cancelling gives
//  both back.
//
//    POST  /approve
//    POST  /:id/add-elastic
//    POST  /cancel
//    POST  /start-production
//
//  api/order.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const { isAuthenticated, isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const Order = require("../models/Order.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const { saveIf, changedMeanwhile } = require("../utils/conditionalSave");
const RawMaterial     = require("../models/RawMaterial.js");
const MaterialOutward = require("../models/MaterialOut.cjs");
const mongoose        = require("mongoose");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint.js");
const { appendStockMovement } = require("../utils/stockLedger.js");
const { addElasticToOrder } = require("../services/orderAmend");
const { receiveAtCost } = require("../utils/materialValuation.js");
const Customer             = require("../models/Customer.js");
const { notify }           = require("../utils/notify.js");
const { approveOrderTxn }  = require("../services/orderService.js");
const { _releaseAllReservations } = require("./orderShared");
const router = express.Router();

// ════════════════════════════════════════════════════════════════
//  SHARED — REFUND RAW MATERIALS ON CANCEL
//
//  Walks every MaterialOutward this order's APPROVAL emitted and
//  credits each material's stock back by exactly the quantity that
//  was actually drawn (not requiredWeight — under force-approval
//  these can differ). Records a paired ORDER_CANCEL_REFUND row in
//  stockMovements, marks the MaterialOutward as reversed, and
//  pushes a RAW_MATERIAL_RESTORED fingerprint per refunded row so
//  the timeline shows the credit clearly.
//
//  Returns the list of `{materialId, quantity, balanceAfter}` so
//  the cancel route can include a summary in its response.
//
//  Safe to call on Open orders (returns an empty list — no
//  approval has been recorded for them yet).
// ════════════════════════════════════════════════════════════════
async function _refundRawMaterialsForOrder(session, order, actor, userObjectId) {
  const refunded = [];

  // Only reverse outwards that haven't been reversed yet — protects
  // against any future code path that might call this helper twice.
  const outwards = await MaterialOutward.find({
    order:    order._id,
    type:     "ORDER_APPROVAL",
    reversed: { $ne: true },
  }).session(session);

  if (outwards.length === 0) return refunded;

  for (const ow of outwards) {
    const qty = Number(ow.quantity || 0);
    if (qty <= 0) continue;

    const material = await RawMaterial.findById(ow.rawMaterial).session(session);
    if (!material) continue;

    // The consumption counter first, on its own — `stock` and `avgCost`
    // are moved by receiveAtCost below and must not also be written
    // from this stale in-memory copy.
    material.totalConsumption = Math.max(
      0,
      (Number(material.totalConsumption) || 0) - qty
    );
    await material.save({ session });

    // Back at exactly what it left at. The outward row this is
    // reversing recorded the unit cost at issue time, so the yarn
    // returns to the shelf carrying the value it took off it —
    // crediting it at TODAY's average would quietly create money every
    // time an order was cancelled after a price rise.
    //
    // receiveAtCost moves the weighted average in the same atomic
    // update as the stock, the way any other receipt does.
    const refundCost = Number(ow.unitPrice) || 0;
    const restored = await receiveAtCost(ow.rawMaterial, qty, refundCost, session);
    material.stock = restored
      ? Number(restored.stock) || 0
      : (Number(material.stock) || 0) + qty;

    await appendStockMovement(material._id, {
      type:     "ORDER_CANCEL_REFUND",
      order:    order._id,
      refNo:    order.orderNo != null ? String(order.orderNo) : "",
      quantity: qty,
      balance:  material.stock,
      unitCost: refundCost,
    }, session);

    // Mark the outward row as reversed so audit + the dedupe filter
    // above stay self-consistent. The original outward stays in
    // place for history; no MaterialInward is created because this
    // wasn't a true receipt.
    ow.reversed   = true;
    ow.reversedAt = new Date();
    // reversedBy is an ObjectId ref to User; only assign when we
    // have a real mongo user id. The normalised `actor.id` can be
    // a string sentinel like "system" / "unknown" which would
    // CastError on save. The fingerprint already captures actor
    // identity for audit, so this field is purely a cross-ref.
    if (userObjectId) ow.reversedBy = userObjectId;
    await ow.save({ session });

    const fp = buildFingerprint(ACTION_CODES.RAW_MATERIAL_RESTORED, {
      entityId: order._id,
      actor,
      meta: {
        rawMaterialId:   ow.rawMaterial.toString(),
        rawMaterialName: material.name,
        quantity:        qty,
        unit:            "kg",
        balanceAfter:    material.stock,
        reversedFrom:    ow._id.toString(),
      },
    });
    order.fingerprints.push(fp);

    refunded.push({
      materialId:   ow.rawMaterial.toString(),
      materialName: material.name,
      quantity:     qty,
      balanceAfter: material.stock,
    });
  }

  return refunded;
}

// ════════════════════════════════════════════════════════════════
//  APPROVE ORDER  (deducts raw stock; reserves elastic stock)
//
//  PR E: in addition to the existing raw-material deduction, the
//  approve route now reserves elastic units against the order.
//  For each elasticOrdered line:
//    1. $inc Elastic.reservedStock by the ordered quantity.
//    2. Push a {elastic, quantity} entry onto Order.reservations.
//    3. Emit a RESERVATION_HOLD info-row on the StockMovement
//       ledger and a STOCK_RESERVED fingerprint on the order.
// ════════════════════════════════════════════════════════════════
router.post(
  "/approve",
  catchAsyncErrors(async (req, res, next) => {
    const session = await mongoose.startSession();
    try {
      const {
        orderId, force = false, forceReason = "",
        // Optional: which dye lots this order's draw is expected to
        // come out of. Absent means unassigned, which is how every
        // approval before this behaved and how the WhatsApp path still
        // does — it carries no material detail at all.
        lotAssignments,
      } = req.body;
      const actor = actorFromRequest(req);

      // The transactional domain logic (validate → pre-flight → force
      // fingerprint → raw deduction → elastic reservation → approval
      // fingerprint + status flip) lives in services/orderService.js.
      // The route keeps only session lifecycle, HTTP shaping, and the
      // post-commit fire-and-forget notifications.
      //
      // withTransaction, not a hand-rolled startTransaction/commit pair:
      // approving two different orders that draw on the same raw material
      // makes their transactions collide on that material document, and
      // Mongo resolves the collision by aborting one with a WriteConflict.
      // Without the retry withTransaction provides, that surfaced to the
      // user as a 500 on a perfectly valid approval — the busier the floor,
      // the more often it fired. approveOrderTxn re-reads the order and
      // every material from the session on entry, so a replay starts from
      // clean state rather than compounding the aborted attempt's edits.
      let txn;
      await session.withTransaction(async () => {
        txn = await approveOrderTxn(session, {
          orderId, force, forceReason, actor,
          whatsappActor: req.body?.whatsappActor,
          userId:        req.user?._id,
          lotAssignments,
        });
      });

      const {
        order, approveFp, deductionFingerprints, reservationFingerprints,
        stockoutSnapshots,
      } = txn;

      // Responding and notifying only once the transaction has committed —
      // inside the callback a retry would try to send the response twice.
      res.status(200).json({
        success:                 true,
        message:                 "Order approved, raw stock deducted, elastic stock reserved",
        fingerprint:             approveFp,
        deductionFingerprints,
        reservationFingerprints,
      });

      // Owner WhatsApp pings — fire-and-forget AFTER the response so
      // a slow/failed notification can never delay the request. Two
      // separate events:
      //   • orderApproved       — always, for the normal happy-path
      //                           approve. Skipped when force=true so
      //                           it doesn't double up with the force
      //                           variant.
      //   • orderForceApproved — only when force=true (stock guard
      //                           override). Carries the reason.
      // The webhook-driven path also passes whatsappActor.from in
      // the body so the audit message tells the owner which channel
      // initiated the approval.
      (async () => {
        try {
          const cust = order.customer
            ? await Customer.findById(order.customer).select("name").lean()
            : null;
          const actorName = actorFromRequest(req)?.name || "Admin";
          const via = req.body?.whatsappActor?.from
            ? `WhatsApp (${req.body.whatsappActor.from})`
            : "Admin app";
          const totalMeters = (order.elasticOrdered || [])
            .reduce((s, e) => s + (Number(e.quantity) || 0), 0);

          const auditContext = {
            _entity: { type: "Order", id: order._id },
            _actor:  { id: req.user?._id, name: actorName, via },
          };
          if (force) {
            const result = await notify("orderForceApproved", {
              orderNo:      order.orderNo,
              customerName: cust?.name,
              by:           actorName,
              reason:       forceReason || "(no reason given)",
              via,
              ...auditContext,
            });
            console.log(`[notify:orderForceApproved] order=${order.orderNo} →`, JSON.stringify(result));
          } else {
            const result = await notify("orderApproved", {
              orderNo:      order.orderNo,
              customerName: cust?.name,
              totalMeters,
              by:           actorName,
              via,
              supplyDate:   order.supplyDate,
              ...auditContext,
            });
            console.log(`[notify:orderApproved] order=${order.orderNo} →`, JSON.stringify(result));
          }

          // Per-material critical-stockout pings — fire after the
          // transaction has committed so we never alert on a write
          // that subsequently got rolled back.
          const { maybeFireCriticalStockout } = require("../utils/inventoryAlerts");
          for (const snap of stockoutSnapshots) {
            const fresh = await RawMaterial.findById(snap.materialId).select("name category minStock _id");
            if (!fresh) continue;
            await maybeFireCriticalStockout({
              material:  fresh,
              oldStock:  snap.oldStock,
              newStock:  snap.newStock,
              reason:    `Order #${order.orderNo ?? ""} approval`,
            });
          }
        } catch (err) {
          console.warn(`[notify:order-approved-hooks] crashed: ${err?.message}`);
        }
      })();
    } catch (error) {
      // withTransaction has already aborted; only the session is ours to close.
      return next(error);
    } finally {
      session.endSession();
    }
  })
);

// ════════════════════════════════════════════════════════════════
//  ADD AN ELASTIC TO AN APPROVED ORDER  — the rare case
//
//  POST /order/:id/add-elastic
//    { elastic, quantity, rate?, auditReason, force?, forceReason?, expectedVersion? }
//
//  The line's own yarn is drawn as approval would have drawn it: short
//  of stock it is refused with the shortfall (INSUFFICIENT_STOCK), or
//  forced with a reason draws what there is. See services/orderAmend.js.
// ════════════════════════════════════════════════════════════════
router.post(
  "/:id/add-elastic",
  isAuthenticated, isAdmin("admin", "production", "accounts"),
  catchAsyncErrors(async (req, res, next) => {
    const session = await mongoose.startSession();
    try {
      let out;
      await session.withTransaction(async () => {
        out = await addElasticToOrder(session, {
          orderId: req.params.id,
          elastic: req.body.elastic,
          quantity: req.body.quantity,
          rate: req.body.rate,
          reason: req.body.auditReason ?? req.body.reason,
          force: req.body.force === true,
          forceReason: req.body.forceReason,
          actor: actorFromRequest(req),
          userId: req.user?._id,
          req,
        });
      });
      const { order, elasticName, drawn, shortfalls, forced } = out;
      const note = drawn.length
        ? `${drawn.length} material${drawn.length === 1 ? "" : "s"} drawn`
          + (forced ? ` (forced through ${shortfalls.length} shortfall${shortfalls.length === 1 ? "" : "s"})` : "")
        : "no raw material needed";
      res.status(200).json({
        success: true,
        message: `${elasticName} added to order #${order.orderNo} for ${out.line.quantity} m — ${note}. Elastic reserved.`,
        line: out.line,
        materialsDrawn: drawn,
        shortfalls,
        forced,
        __v: order.__v,
      });

      // Critical-stockout pings after the commit, as approval does.
      (async () => {
        try {
          const { maybeFireCriticalStockout } = require("../utils/inventoryAlerts");
          for (const snap of out.stockoutSnapshots) {
            const fresh = await RawMaterial.findById(snap.materialId).select("name category minStock _id");
            if (!fresh) continue;
            await maybeFireCriticalStockout({
              material: fresh, oldStock: snap.oldStock, newStock: snap.newStock,
              reason: `Order #${order.orderNo ?? ""} amended (${elasticName} added)`,
            });
          }
        } catch (err) {
          console.warn(`[notify:order-amend-hooks] crashed: ${err?.message}`);
        }
      })();
    } catch (error) {
      return next(error);
    } finally {
      session.endSession();
    }
  })
);

// ════════════════════════════════════════════════════════════════
//  CANCEL ORDER
//
//  Releases any remaining elastic reservations AND refunds raw
//  materials previously deducted during /approve. The refund walks
//  the order's MaterialOutward records (which carry the actually-
//  applied quantity — correct under force-approval where less than
//  requiredWeight was drawn). Refund only happens for Approved /
//  InProgress orders; Open orders never deducted anything.
// ════════════════════════════════════════════════════════════════
router.post(
  "/cancel",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId, cancelReason } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      let snapshot; // populated inside the txn for the post-response notification
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);

        if (!["Open", "Approved", "InProgress"].includes(order.status)) {
          throw new ErrorHandler(
            `Cannot cancel an order with status "${order.status}"`,
            400
          );
        }

        const previousStatus = order.status;
        const actor = actorFromRequest(req);

        const released = await _releaseAllReservations(
          session,
          order,
          actor,
          "order cancelled"
        );

        const refunded = previousStatus === "Open"
          ? []
          : await _refundRawMaterialsForOrder(
              session,
              order,
              actor,
              req.user?._id,
            );

        order.status      = "Cancelled";
        order.cancelledBy = req.user?._id || null;
        order.cancelledAt = new Date();

        // Capture the cancel reason on the audit fingerprint when
        // the caller supplied one. The WhatsApp inbound webhook will
        // pass it through as part of the body; the admin app is
        // expected to prompt for it for any non-Open cancel.
        const fp = buildFingerprint(ACTION_CODES.ORDER_CANCELLED, {
          entityId: order._id,
          actor,
          meta: {
            previousStatus,
            newStatus: "Cancelled",
            releasedReservations: released.length,
            refundedMaterials:    refunded.length,
            reason:               cancelReason ? String(cancelReason).trim() : undefined,
            via:                  req.body?.whatsappActor?.from ? "whatsapp" : "admin",
            whatsappFrom:         req.body?.whatsappActor?.from || undefined,
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        snapshot = {
          orderNo:      order.orderNo,
          customer:     order.customer,
          previousStatus,
          released:     released.length,
          refunded:     refunded.length,
          reason:       cancelReason ? String(cancelReason).trim() : undefined,
          via:          req.body?.whatsappActor?.from
            ? `WhatsApp (${req.body.whatsappActor.from})`
            : "Admin app",
          actorName:    actor?.name || "Admin",
          actorId:      req.user?._id || null,
        };

        resp = {
          orderId: order._id,
          status:  order.status,
          fingerprint: fp,
          releasedReservations: released,
          refundedMaterials:    refunded,
        };
      });

      res.status(200).json({ success: true, message: "Order cancelled", ...resp });

      // Owner WhatsApp ping — fire-and-forget AFTER the response so
      // a slow notification can never delay or break a cancel. Skip
      // when the actor is themselves the recipient (you don't ping
      // yourself for an action you just took in the app).
      if (snapshot) {
        (async () => {
          try {
            const cust = snapshot.customer
              ? await Customer.findById(snapshot.customer).select("name").lean()
              : null;
            const result = await notify("orderCancelled", {
              orderNo:              snapshot.orderNo,
              customerName:         cust?.name,
              previousStatus:       snapshot.previousStatus,
              releasedReservations: snapshot.released,
              refundedMaterials:    snapshot.refunded,
              reason:               snapshot.reason || "(not provided)",
              by:                   snapshot.actorName,
              via:                  snapshot.via,
              _entity: { type: "Order", id: resp.orderId },
              _actor:  { id: snapshot.actorId, name: snapshot.actorName, via: snapshot.via },
            });
            console.log(`[notify:orderCancelled] order=${snapshot.orderNo} →`, JSON.stringify(result));
          } catch (err) {
            console.warn(`[notify:orderCancelled] hook crashed: ${err?.message}`);
          }
        })();
      }
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ════════════════════════════════════════════════════════════════
//  START PRODUCTION  (Approved → InProgress)
// ════════════════════════════════════════════════════════════════
router.post(
  "/start-production",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const order = await Order.findById(orderId);
    if (!order) return next(new ErrorHandler("Order not found", 404));

    if (order.status !== "Approved") {
      return next(new ErrorHandler("Order must be Approved before starting production", 400));
    }

    order.status    = "InProgress";
    order.startedBy = req.user?._id || null;
    order.startedAt = new Date();

    const fp = buildFingerprint(ACTION_CODES.ORDER_PRODUCTION_STARTED, {
      entityId: order._id,
      actor:    actorFromRequest(req),
      meta:     { previousStatus: "Approved", newStatus: "InProgress" },
    });
    order.fingerprints.push(fp);
    // Only while still Approved, in the same write: an order cancelled
    // (or completed) after the check above must not be revived.
    if (!(await saveIf(order, { status: "Approved" }))) {
      return next(changedMeanwhile(`Order #${order.orderNo ?? ""}`.trim(), "changed"));
    }

    res.status(200).json({
      success: true,
      message: "Order moved to InProgress",
      status:  order.status,
      fingerprint: fp,
    });

    // Owner WhatsApp ping — fire-and-forget. Confirms operations
    // actually picked up the order vs. it sitting in Approved limbo.
    //
    // Edge case: if production starts within 60s of approval (e.g.
    // an automated planner kicked in), the back-to-back pings read
    // weirdly ("approved then started one second later"). Skip in
    // that window — owner already got the approve ping; the start
    // is implied.
    (async () => {
      try {
        const approvedTooRecent = order.approvedAt &&
          (Date.now() - new Date(order.approvedAt).getTime() < 60_000);
        if (approvedTooRecent) {
          console.log(`[notify:orderProductionStarted] order=${order.orderNo} → skipped: approve was <60s ago`);
          return;
        }
        const cust = order.customer
          ? await Customer.findById(order.customer).select("name").lean()
          : null;
        const totalMeters = (order.elasticOrdered || [])
          .reduce((s, e) => s + (Number(e.quantity) || 0), 0);
        const actorName = actorFromRequest(req)?.name || "Admin";
        const result = await notify("orderProductionStarted", {
          orderNo:      order.orderNo,
          customerName: cust?.name,
          totalMeters,
          by:           actorName,
          via:          "Admin app",
          _entity: { type: "Order", id: order._id },
          _actor:  { id: req.user?._id, name: actorName },
        });
        console.log(`[notify:orderProductionStarted] order=${order.orderNo} →`, JSON.stringify(result));
      } catch (err) {
        console.warn(`[notify:orderProductionStarted] hook crashed: ${err?.message}`);
      }
    })();
  })
);

module.exports = router;
