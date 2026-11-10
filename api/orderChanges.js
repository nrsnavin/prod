// ══════════════════════════════════════════════════════════════════
//  ORDERS — COMPLETE, EDIT, DELETE  (part of /api/v2/order)
//
//    POST  /complete
//    POST  /update-order
//    POST  /delete-order
//
//  api/order.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const { liveJobStatus } = require('../domain/jobStatus');
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const Order = require("../models/Order.js");
const Job = require("../models/JobOrder.js");
const Elastic = require("../models/Elastic.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const mongoose        = require("mongoose");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint.js");
const { requireReason } = require("../utils/auditReason.js");
const { readOrderLines, assertElasticsExist } = require("../utils/orderLines");
const { assertVersion } = require("../utils/versioning.js");
const { carryEarmarksForward } = require("../services/lotAllocation");
const Customer             = require("../models/Customer.js");
const { notify }           = require("../utils/notify.js");
const Notification         = require("../models/Notification.js");
const { computeRawMaterialRequired, _releaseAllReservations } = require("./orderShared");
const router = express.Router();

// ════════════════════════════════════════════════════════════════
//  COMPLETE ORDER
//
//  PR E: releases any remaining elastic reservations. Useful when
//  a customer accepts a partial delivery and the order is closed
//  with un-dispatched units still reserved.
// ════════════════════════════════════════════════════════════════
router.post(
  "/complete",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("Order ID is required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);

        if (order.status !== "InProgress") {
          throw new ErrorHandler("Only InProgress orders can be completed", 400);
        }

        // ── An order is finished when its WORK is finished ──────────
        //
        // This checked only the order's own status, so an operator
        // could close an order while a job was still on a machine —
        // releasing the reserved stock for goods that were still being
        // made, and freezing the order at Completed, which is terminal.
        //
        // The job cascade in api/job.js already had this right: it
        // closes the order only when every job is done. The same
        // question had two answers depending on which button was
        // pressed, which is the shape of every fault in this codebase
        // worth finding.
        //
        // A CANCELLED job counts as finished: it will never produce
        // anything, and refusing on it would leave the order with no
        // way to close. An order with no jobs at all passes too — it
        // was fulfilled from stock, and trapping it at InProgress would
        // be a rule with no escape.
        const openJobs = await Job.find({
          order: order._id,
          status: liveJobStatus(),
        }).select("jobOrderNo status").session(session).lean();

        if (openJobs.length > 0) {
          const named = openJobs
            .map((j) => `J-${j.jobOrderNo ?? "?"} (${j.status})`)
            .join(", ");
          const err = new ErrorHandler(
            `This order still has ${openJobs.length} unfinished job` +
            `${openJobs.length === 1 ? "" : "s"} — ${named}. ` +
            `Complete or cancel ${openJobs.length === 1 ? "it" : "them"} first.`,
            409
          );
          err.code = "ORDER_HAS_OPEN_JOBS";
          err.details = {
            jobs: openJobs.map((j) => ({
              id: String(j._id), jobOrderNo: j.jobOrderNo ?? null, status: j.status,
            })),
          };
          throw err;
        }

        const actor = actorFromRequest(req);
        const released = await _releaseAllReservations(
          session,
          order,
          actor,
          "order completed"
        );

        order.status      = "Completed";
        order.completedBy = req.user?._id || null;
        order.completedAt = new Date();

        const fp = buildFingerprint(ACTION_CODES.ORDER_COMPLETED, {
          entityId: order._id,
          actor,
          meta: {
            previousStatus: "InProgress",
            newStatus:      "Completed",
            releasedReservations: released.length,
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        // Snapshot for the post-response notification.
        resp = {
          status: order.status,
          fingerprint: fp,
          releasedReservations: released,
          // captured for the hook outside the txn
          _orderNo:       order.orderNo,
          _customer:      order.customer,
          _totalMeters:   (order.elasticOrdered || [])
            .reduce((s, e) => s + (Number(e.quantity) || 0), 0),
          _onTime:        order.supplyDate ? order.completedAt <= new Date(order.supplyDate) : undefined,
          _actorName:     actor?.name || "Admin",
          _orderId:       order._id,
        };
      });

      res.status(200).json({
        success: true,
        message: "Order completed",
        status:  resp.status,
        fingerprint:          resp.fingerprint,
        releasedReservations: resp.releasedReservations,
      });

      // Owner WhatsApp ping — confirms revenue-recognition moment.
      // Edge case: if a dcDelivered ping just fired for this same
      // order (within the last hour), skip — the owner already saw
      // "your order is done"; doubling up reads as system noise.
      (async () => {
        try {
          const recentDc = await Notification.findOne({
            event:       "dcDelivered",
            "entity.id": resp._orderId,
            status:      "sent",
            createdAt:   { $gte: new Date(Date.now() - 60 * 60 * 1000) },
          }).lean();
          if (recentDc) {
            console.log(`[notify:orderCompleted] order=${resp._orderNo} → skipped: dcDelivered fired ${Math.round((Date.now() - new Date(recentDc.createdAt).getTime()) / 1000)}s ago`);
            return;
          }
          const cust = resp._customer
            ? await Customer.findById(resp._customer).select("name").lean()
            : null;
          const result = await notify("orderCompleted", {
            orderNo:              resp._orderNo,
            customerName:         cust?.name,
            totalMeters:          resp._totalMeters,
            releasedReservations: resp.releasedReservations?.length || 0,
            onTime:               resp._onTime,
            by:                   resp._actorName,
            via:                  "Admin app",
            _entity: { type: "Order", id: resp._orderId },
            _actor:  { id: req.user?._id, name: resp._actorName },
          });
          console.log(`[notify:orderCompleted] order=${resp._orderNo} →`, JSON.stringify(result));
        } catch (err) {
          console.warn(`[notify:orderCompleted] hook crashed: ${err?.message}`);
        }
      })();
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ════════════════════════════════════════════════════════════════
//  UPDATE ORDER  (Open state only)
// ════════════════════════════════════════════════════════════════
router.post(
  "/update-order",
  catchAsyncErrors(async (req, res, next) => {
    const {
      orderId,
      po, supplyDate, description, customer,
    } = req.body;
    // `let`, because the validated + normalised lines replace the raw
    // ones below rather than being carried alongside them.
    let elasticOrdered = req.body.elasticOrdered;
    if (!orderId) return next(new ErrorHandler("orderId is required", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to edit", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);
        // Optimistic lock: reject the edit if another user saved since
        // this client loaded the order (409 → client reloads).
        assertVersion(order, req);
        if (order.status !== "Open") {
          throw new ErrorHandler(
            `Only Open orders can be edited (current: "${order.status}"). ` +
            `Cancel and recreate to change an approved order.`,
            400
          );
        }

        const changed = {};
        const previousValues = {};
        if (po !== undefined && po !== order.po) {
          previousValues.po = order.po;          order.po          = po;          changed.po          = po;
        }
        if (supplyDate !== undefined && supplyDate !== "" && !isNaN(new Date(supplyDate).getTime())
            && new Date(supplyDate).getTime() !== new Date(order.supplyDate).getTime()) {
          previousValues.supplyDate = order.supplyDate; order.supplyDate = new Date(supplyDate); changed.supplyDate = supplyDate;
        }
        if (description !== undefined && description !== order.description) {
          previousValues.description = order.description; order.description = description; changed.description = description;
        }
        if (customer !== undefined && String(customer) !== String(order.customer)) {
          previousValues.customer = order.customer?.toString?.(); order.customer = customer; changed.customer = customer;
        }

        if (Array.isArray(elasticOrdered) && elasticOrdered.length > 0) {
          // The same rules the create path enforces. A rule applied on
          // one and not the other is not a rule — an order that could
          // not be CREATED with a duplicated line could be edited into
          // one.
          const parsed = readOrderLines(elasticOrdered);
          if (parsed.error) throw new ErrorHandler(parsed.error, 400);
          const elasticError = await assertElasticsExist(parsed.lines, Elastic);
          if (elasticError) throw new ErrorHandler(elasticError, 400);
          elasticOrdered = parsed.lines;

          previousValues.elasticOrdered = order.elasticOrdered.map((e) => ({
            elastic:  e.elastic.toString(),
            quantity: e.quantity,
            // The rate belongs in the history too. Recording only the
            // quantity made a wiped price invisible in the audit trail
            // as well as on the order.
            rate:     e.rate ?? 0,
          }));

          const rawMaterialRequired = await computeRawMaterialRequired(elasticOrdered);

          // ── Keep the price that was agreed ────────────────────────
          //
          // This route owns QUANTITIES. The selling rate is owned by
          // PUT /pnl/order/:orderId/rates, which says so in its own
          // header — "Deliberately NOT part of /order/update-order".
          //
          // But assigning the incoming array wholesale let the route
          // silently destroy the field it does not manage: the web edit
          // sends { elastic, quantity } and nothing else, so `rate` fell
          // to its schema default of 0 on every line. Changing one
          // quantity unpriced the whole order, and the P&L — whose
          // revenue is exactly this field — then reported it as unpriced
          // with nothing anywhere saying why.
          //
          // So each line keeps the rate its elastic already had, unless
          // the caller states one. An explicit 0 is honoured rather than
          // overwritten: 0 is this system's own signal for "not priced
          // yet", and carrying the old rate over it would make unpricing
          // a line impossible — the same bug from the other side.
          const rateByElastic = new Map(
            (order.elasticOrdered || []).map((e) => [String(e.elastic), Number(e.rate) || 0])
          );
          const withRates = elasticOrdered.map((line) => ({
            ...line,
            rate: line?.rate !== undefined && line?.rate !== null && line?.rate !== ''
              ? Number(line.rate) || 0
              : rateByElastic.get(String(line.elastic)) ?? 0,
          }));

          order.elasticOrdered      = withRates;
          order.pendingElastic      = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: e.quantity }));
          order.producedElastic     = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: 0 }));
          order.packedElastic       = elasticOrdered.map((e) => ({ elastic: e.elastic, quantity: 0 }));
          // ── And keep the dye lots that were set aside ─────────────
          //
          // A GUARD, not a live fix — and worth knowing which. This
          // route refuses anything that is not Open, and /assign-lots
          // refuses anything that is not Approved or InProgress, so no
          // order reaching this line can currently be holding a lot.
          //
          // But it is the same shape as the bug described above for
          // `rate`, in the field beside it: computeRawMaterialRequired
          // returns rows with no `lots`, so assigning them wholesale
          // would release every bag silently. The day somebody widens
          // the status gate above — and the gate is a business rule, not
          // a law — that assignment starts throwing yarn away. Carrying
          // costs nothing and makes that impossible rather than
          // remembered. See tests/api/earmarksSurviveReplan.test.js,
          // which pins the disjointness this relies on.
          //
          // Carried rather than copied because this route can shrink a
          // requirement, and validateEarmarks refuses a total larger
          // than one. See services/lotAllocation.js.
          const carriedLots = carryEarmarksForward(
            order.rawMaterialRequired,
            rawMaterialRequired
          );
          order.rawMaterialRequired = carriedLots.rows;
          order.updatedItemsAt      = new Date();
          changed.elasticOrdered    = `${elasticOrdered.length} item(s)`;
          if (carriedLots.trimmed.length || carriedLots.dropped.length) {
            changed.dyeLots = [
              carriedLots.trimmed.length && `${carriedLots.trimmed.length} trimmed to fit`,
              carriedLots.dropped.length && `${carriedLots.dropped.length} released`,
            ].filter(Boolean).join(', ');
          }
        }

        if (Object.keys(changed).length === 0) {
          throw new ErrorHandler("No editable fields supplied", 400);
        }

        const fp = buildFingerprint(ACTION_CODES.ORDER_UPDATED, {
          entityId: order._id,
          actor:    actorFromRequest(req),
          meta: {
            changedFields: Object.keys(changed),
            previousValues,
            newValues:     changed,
            auditReason,
          },
        });
        order.fingerprints.push(fp);
        order.increment(); // bump __v so concurrent editors get a 409
        await order.save({ session });

        resp = { order, fingerprint: fp };
      });
      res.status(200).json({
        success: true,
        message: "Order updated",
        order:   resp.order,
        fingerprint: resp.fingerprint,
      });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// ════════════════════════════════════════════════════════════════
//  DELETE ORDER  (soft-delete; Open state only, no jobs)
// ════════════════════════════════════════════════════════════════
router.post(
  "/delete-order",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.body;
    if (!orderId) return next(new ErrorHandler("orderId is required", 400));
    const auditReason = requireReason(req);
    if (!auditReason) return next(new ErrorHandler("A reason (min 3 chars) is required to delete", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const order = await Order.findById(orderId).session(session);
        if (!order) throw new ErrorHandler("Order not found", 404);
        if (order.status !== "Open") {
          throw new ErrorHandler(
            `Only Open orders can be deleted (current: "${order.status}"). ` +
            `Use cancel for approved/in-progress orders.`,
            400
          );
        }
        if ((order.jobs || []).length > 0) {
          throw new ErrorHandler(
            `Cannot delete an order with jobs (${order.jobs.length}). Cancel the jobs first.`,
            400
          );
        }

        const previousStatus = order.status;
        order.status    = "Deleted";
        order.deletedBy = req.user?._id || null;
        order.deletedAt = new Date();

        const fp = buildFingerprint(ACTION_CODES.ORDER_DELETED, {
          entityId: order._id,
          actor:    actorFromRequest(req),
          meta: {
            previousStatus,
            newStatus: "Deleted",
            auditReason,
            orderNo:   order.orderNo,
          },
        });
        order.fingerprints.push(fp);
        await order.save({ session });

        resp = { fingerprint: fp, orderId: order._id, status: order.status };
      });
      res.status(200).json({ success: true, message: "Order deleted", ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

module.exports = router;
