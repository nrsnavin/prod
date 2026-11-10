// ══════════════════════════════════════════════════════════════════
//  ORDERS — WHAT AN ORDER NEEDS, ITS LOTS, DELIVERIES AND POS  (part of /api/v2/order)
//
//    GET   /:id/mrp
//    GET   /:id/yarn-lots
//    GET   /:id/delivery-challans
//    POST  /:id/raise-po
//    GET   /:id/purchase-orders
//    GET   /:orderId/assignable-lots
//    POST  /assign-lots
//
//  api/order.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const { isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const Order = require("../models/Order.js");
const Job = require("../models/JobOrder.js");
const { computeMaterialRequirement } = require("../utils/materialRequirement.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const { onceAtATime } = require("../utils/onceAtATime");
const PurchaseOrder = require("../models/PurchaseOrder.js");
const { triageShortfall, createShortfallPos, skipReasons } = require("../services/shortfallPo.js");
const { issuedForOrder } = require("../services/orderIssuance.js");
const mongoose        = require("mongoose");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint.js");
const { assignableLots, LIVE_ORDER_STATUSES } = require("../services/lotAllocation");
const { applyLotAssignments } = require("../services/orderService.js");
const WarpingBatch         = require("../models/WarpingBatch.js");
const DeliveryChallan      = require("../models/DeliveryChallan.js");
const { plannedLotsByJob, distinctLots, emptyTrail } = require("../services/yarnLotTrail.js");
const router = express.Router();

// ══════════════════════════════════════════════════════════════
//  ORDER-LEVEL MATERIAL REQUIREMENT
//
//  GET  /:id/mrp       — what the whole order needs, and what is short
//  POST /:id/raise-po  — buy the gap, one PO per supplier
//
//  The job-level MRP answers "what does this run need". This answers
//  "what does the whole order need", which is the question asked before
//  the work is split into jobs at all — and the point at which yarn
//  actually has to be bought.
//
//  Computed from elasticOrdered, so it covers the entire order including
//  quantities no job has been raised for yet. The two views deliberately
//  disagree while an order is part-planned; that difference is the
//  unplanned quantity, and it is the thing worth seeing.
// ══════════════════════════════════════════════════════════════
router.get(
  '/:id/mrp',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const order = await Order.findById(req.params.id)
      .select('orderNo po date supplyDate status elasticOrdered customer')
      .populate('customer', 'name')
      .lean();
    if (!order) return next(new ErrorHandler('Order not found', 404));

    // Approval already took this order's material out of stock, so the
    // sheet has to know what it drew — otherwise it reads the reduced
    // balance as a shortage and offers to buy the same yarn again.
    const materials = await computeMaterialRequirement(order.elasticOrdered || [], {
      allocated: await issuedForOrder(order._id),
    });

    res.json({
      success: true,
      data: {
        orderId: String(order._id),
        orderNo: order.orderNo ?? null,
        customerPo: order.po || '',
        customerName: order.customer?.name || '',
        status: order.status,
        materials,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  GET /:id/yarn-lots — the dye lots this order's goods will carry
//
//  Shade complaints arrive quoting an order or a delivery note, not a
//  warping batch, so the trail has to be answerable from this end too.
//  It rolls up every job on the order: the lots each job's warping
//  programme committed to, and the lots its batches actually issued.
//
//  Sections whose lot has not been chosen are counted, not hidden. An
//  order two beams short of a decision looks exactly like a settled one
//  otherwise, and that is the state worth seeing before the machine
//  starts.
// ══════════════════════════════════════════════════════════════
router.get(
  '/:id/yarn-lots',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const order = await Order.findById(req.params.id).select('orderNo').lean();
    if (!order) return next(new ErrorHandler('Order not found', 404));

    // Read the jobs by their order ref rather than the order's `jobs`
    // array: the ref is the one a job cannot be created without.
    const jobs = await Job.find({ order: order._id })
      .select('jobOrderNo status elastics')
      .populate('elastics.elastic', 'name')
      .sort({ jobOrderNo: 1 })
      .lean();

    const jobIds = jobs.map((j) => j._id);
    const [planned, batches] = await Promise.all([
      plannedLotsByJob(jobIds),
      WarpingBatch.find({ job: { $in: jobIds } })
        .select('job batchNo status beamNos issuedDate allocations elastics')
        .populate('elastics', 'name')
        .sort({ createdAt: 1 })
        .lean(),
    ]);

    const issuedByJob = new Map(jobIds.map((id) => [String(id), []]));
    for (const b of batches) {
      // Cancelled batches went back on the rack; they are not in the goods.
      if (b.status === 'cancelled') continue;
      const bucket = issuedByJob.get(String(b.job));
      if (!bucket) continue;
      const names = (b.elastics || []).map((e) => e.name).filter(Boolean);
      for (const a of b.allocations || []) {
        bucket.push({
          source: 'issued',
          batchId: b._id,
          batchNo: b.batchNo,
          batchStatus: b.status,
          beamNos: b.beamNos || [],
          yarnLot: a.yarnLot,
          lotNo: a.lotNo || '',
          shade: a.shade || '',
          materialName: a.materialName || '',
          quantity: a.quantity,
          elasticNames: names,
          issuedDate: b.issuedDate || null,
        });
      }
    }

    const byJob = jobs.map((j) => {
      const trail = planned.get(String(j._id)) || emptyTrail();
      return {
        jobId: String(j._id),
        jobOrderNo: j.jobOrderNo,
        jobNo: `J-${j.jobOrderNo}`,
        status: j.status,
        elastics: (j.elastics || [])
          .map((e) => e.elastic?.name)
          .filter(Boolean),
        planned: trail.entries,
        issued: issuedByJob.get(String(j._id)) || [],
        sections: trail.sections,
        openBeamNos: trail.openBeamNos,
      };
    });

    const allRows = byJob.flatMap((j) => [...j.planned, ...j.issued]);
    const sections = byJob.reduce(
      (acc, j) => ({
        total: acc.total + j.sections.total,
        withLot: acc.withLot + j.sections.withLot,
        open: acc.open + j.sections.open,
      }),
      { total: 0, withLot: 0, open: 0 }
    );

    res.json({
      success: true,
      data: {
        orderId: String(order._id),
        orderNo: order.orderNo ?? null,
        byJob,
        lots: distinctLots(allRows),
        sections,
      },
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  GET /:id/delivery-challans — what has actually left the building
//
//  The order detail page could say what was ordered, planned, produced
//  and packed, and then stopped. Whether any of it had been DESPATCHED
//  — and against which delivery note — could only be answered by
//  leaving the order, opening the DC list and searching it by order
//  number. That is the question customers ring up about.
//
//  Matched on the reference AND the number snapshot. A DC carries both
//  (`order` and `orderNo`), and older rows can have one without the
//  other; matching on the reference alone would quietly drop them, and
//  a despatch list that is silently incomplete is worse than none. The
//  order number is unique, so the number match cannot pull in somebody
//  else's note.
//
//  Cancelled notes are listed but excluded from the despatched totals.
//  They are part of the history of the order — somebody raised them,
//  and "why is there a gap in the DC numbers" has to have an answer —
//  but nothing left the building on them.
// ══════════════════════════════════════════════════════════════
router.get(
  '/:id/delivery-challans',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    const order = await Order.findById(req.params.id)
      .select('orderNo elasticOrdered')
      .populate('elasticOrdered.elastic', 'name')
      .lean();
    if (!order) return next(new ErrorHandler('Order not found', 404));

    const match = [{ order: order._id }];
    if (order.orderNo != null) match.push({ orderNo: order.orderNo });

    const dcs = await DeliveryChallan.find({ $or: match })
      .select('dcNumber date dispatchDate status type items totalQuantity ' +
              'totalAmount vehicleNo transporter lrNumber customerName createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const LIVE = (dc) => dc.status !== 'cancelled';

    // What has gone out, per elastic, so the panel can sit the despatched
    // quantity next to what was ordered rather than leaving the reader to
    // add up the notes themselves.
    const dispatchedByElastic = new Map();
    for (const dc of dcs) {
      if (!LIVE(dc)) continue;
      for (const item of dc.items || []) {
        if (!item.elastic) continue;
        const key = String(item.elastic);
        const row = dispatchedByElastic.get(key) || { quantity: 0, name: item.elasticName || '' };
        row.quantity += Number(item.quantity) || 0;
        if (!row.name && item.elasticName) row.name = item.elasticName;
        dispatchedByElastic.set(key, row);
      }
    }

    const lines = (order.elasticOrdered || []).map((l) => {
      const key = String(l.elastic?._id || l.elastic);
      const sent = dispatchedByElastic.get(key);
      const ordered = Number(l.quantity) || 0;
      const dispatched = sent ? sent.quantity : 0;
      return {
        elasticId:   key,
        elasticName: l.elastic?.name || sent?.name || '',
        ordered,
        dispatched,
        // Negative would mean more went out than was ordered, which
        // happens and is worth seeing rather than clamping away.
        pending: Math.round((ordered - dispatched) * 1000) / 1000,
      };
    });

    const live = dcs.filter(LIVE);

    res.json({
      success: true,
      data: {
        orderId: String(order._id),
        orderNo: order.orderNo ?? null,
        dcs: dcs.map((dc) => ({
          id:            String(dc._id),
          dcNumber:      dc.dcNumber,
          date:          dc.date || dc.createdAt || null,
          dispatchDate:  dc.dispatchDate || null,
          status:        dc.status,
          type:          dc.type,
          customerName:  dc.customerName || '',
          totalQuantity: Number(dc.totalQuantity) || 0,
          totalAmount:   Number(dc.totalAmount) || 0,
          vehicleNo:     dc.vehicleNo || '',
          transporter:   dc.transporter || '',
          lrNumber:      dc.lrNumber || '',
          items: (dc.items || []).map((i) => ({
            elasticId:   i.elastic ? String(i.elastic) : null,
            elasticName: i.elasticName || i.description || '',
            quantity:    Number(i.quantity) || 0,
            unit:        i.unit || 'm',
          })),
        })),
        lines,
        totals: {
          count:      dcs.length,
          cancelled:  dcs.length - live.length,
          quantity:   Math.round(live.reduce((s, d) => s + (Number(d.totalQuantity) || 0), 0) * 1000) / 1000,
          ordered:    lines.reduce((s, l) => s + l.ordered, 0),
          dispatched: Math.round(lines.reduce((s, l) => s + l.dispatched, 0) * 1000) / 1000,
        },
      },
    });
  })
);

router.post(
  '/:id/raise-po',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    // One at a time for an order. What is short is worked out and then
    // bought: two taps together both found nothing on order yet and each
    // raised the purchase orders. The second now waits for the first and
    // is told the material is already on order.
    await onceAtATime(`raise-po:order:${req.params.id}`, async () => {
      const order = await Order.findById(req.params.id)
        .select('orderNo elasticOrdered status')
        .lean();
      if (!order) return next(new ErrorHandler('Order not found', 404));

      // Buying for an order happens BEFORE it is approved. Approval
      // allocates the stock to the order — takes it out of the balance
      // and holds it — so from that point the order's material question
      // is settled and a purchase raised against it would be buying for
      // a requirement already met.
      //
      // A forced approval is the exception the rule has to survive: it
      // allocated only what was there, and the rest is genuinely owed.
      // That gap is bought from the job that needs it or from the
      // purchase-order screen directly, both of which stay open — this
      // route is the one that used to double up, because it is the one
      // sitting next to the requirement.
      if (order.status !== 'Open') {
        const err = new ErrorHandler(
          `Stock for order #${order.orderNo} was allocated when it was approved — ` +
          `raise purchase orders before approval, or from the job that needs the material.`,
          400
        );
        err.code = 'ORDER_ALREADY_APPROVED';
        return next(err);
      }

      const requirement = await computeMaterialRequirement(order.elasticOrdered || [], {
        allocated: await issuedForOrder(order._id),
      });
      const { orderable, noSupplier, unresolved, anyShort, awaitingDelivery } =
        triageShortfall(requirement, req.body?.materials);

      if (!anyShort) {
        return next(new ErrorHandler(
          awaitingDelivery.length
            ? `Already on order — ${awaitingDelivery
                .map((m) => m.name)
                .join(', ')} ${awaitingDelivery.length === 1 ? 'is' : 'are'} short but bought and awaiting delivery.`
            : 'Nothing is short on this order — no purchase order to raise.',
          400
        ));
      }
      if (orderable.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'None of the short materials has a supplier set — set one before raising a PO.',
          skipped: skipReasons(unresolved, noSupplier),
        });
      }

      const created = await createShortfallPos(
        orderable,
        { forOrder: order._id },
        {
          expectedDate: req.body?.expectedDate,
          notes: req.body?.notes,
          defaultNote: `Raised for order #${order.orderNo} material shortfall`,
        }
      );

      try {
        const doc = await Order.findById(order._id);
        if (doc) {
          // buildFingerprint + push: this router imports the builder, not
          // the stamper, and the two produce the same row.
          doc.fingerprints.push(buildFingerprint(ACTION_CODES.PO_RAISED, {
            entityId: doc._id,
            actor: actorFromRequest(req),
            meta: {
              source: 'order-mrp-shortfall',
              purchaseOrders: created.map((c) => ({ poNo: c.poNo, supplier: c.supplierName })),
            },
          }));
          await doc.save();
        }
      } catch (fpErr) {
        console.warn('[order raise-po] fingerprint failed:', fpErr.message);
      }

      res.status(201).json({
        success: true,
        purchaseOrders: created,
        skipped: skipReasons(unresolved, noSupplier),
      });
    }, { what: 'Purchase orders for this order' });
  })
);

router.get(
  '/:id/purchase-orders',
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return next(new ErrorHandler('Invalid order id', 400));
    }
    // Everything bought for this order, including POs raised from one of
    // its jobs — from the order's point of view they are the same spend.
    const pos = await PurchaseOrder.find({ forOrder: req.params.id })
      .populate('supplier', 'name')
      .populate('items.rawMaterial', 'name')
      .populate('forJob', 'jobOrderNo')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ success: true, purchaseOrders: pos });
  })
);

// ════════════════════════════════════════════════════════════════
//  DYE LOT EARMARKS
//
//  Approving an order debits RawMaterial.stock without saying which
//  bags the yarn comes out of. These two routes are that sentence:
//  which lots may be chosen, and which this order has chosen.
//
//  GET  /order/:orderId/assignable-lots?materialId=  what is free
//  POST /order/assign-lots                            record the choice
//
//  An earmark moves nothing on the lot — the yarn is still on the rack
//  and leaves when a warping batch draws it. See
//  services/lotAllocation.js for the arithmetic and why the two
//  counters must not be collapsed.
// ════════════════════════════════════════════════════════════════

router.get(
  "/:orderId/assignable-lots",
  catchAsyncErrors(async (req, res, next) => {
    const { orderId } = req.params;
    const { materialId } = req.query;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return next(new ErrorHandler("Invalid order id", 400));
    }
    if (!materialId || !mongoose.Types.ObjectId.isValid(String(materialId))) {
      return next(new ErrorHandler("materialId is required", 400));
    }

    const order = await Order.findById(orderId).select("rawMaterialRequired").lean();
    if (!order) return next(new ErrorHandler("Order not found", 404));

    const rm = (order.rawMaterialRequired || []).find(
      (r) => String(r.rawMaterial) === String(materialId)
    );
    if (!rm) {
      return next(new ErrorHandler("This order does not require that material", 400));
    }

    // Excluding this order's own earmarks from the "already promised"
    // total. Without it, re-opening the picker would show the lots this
    // order holds as having no room left — its own promise counted
    // against itself.
    const lots = await assignableLots(materialId, { excludeOrder: orderId });

    const assigned = (rm.lots || []).reduce((t, l) => t + (Number(l.quantity) || 0), 0);

    res.json({
      success: true,
      materialId: String(materialId),
      requiredWeight: Number(rm.requiredWeight) || 0,
      assigned: Math.round(assigned * 1000) / 1000,
      // Partial is normal, so the gap is reported rather than treated
      // as an error state.
      unassigned: Math.max(0, Math.round(((Number(rm.requiredWeight) || 0) - assigned) * 1000) / 1000),
      current: rm.lots || [],
      lots,
    });
  })
);

router.post(
  "/assign-lots",
  isAdmin("admin", "production", "accounts"),
  catchAsyncErrors(async (req, res, next) => {
    const { orderId, assignments } = req.body || {};
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return next(new ErrorHandler("Valid orderId is required", 400));
    }
    if (!Array.isArray(assignments)) {
      return next(new ErrorHandler("assignments must be a list", 400));
    }

    const session = await mongoose.startSession();
    try {
      let order;
      await session.withTransaction(async () => {
        const doc = await Order.findById(orderId).session(session);
        if (!doc) throw new ErrorHandler("Order not found", 404);

        // Only an order that still holds yarn can promise any. An Open
        // order has not drawn stock yet and a Completed one has already
        // used what it drew — earmarking either would hold bags for a
        // claim that does not exist.
        if (!LIVE_ORDER_STATUSES.includes(doc.status)) {
          throw new ErrorHandler(
            `Order is ${doc.status} — lots can only be assigned while it is ` +
              LIVE_ORDER_STATUSES.join(" or "),
            409
          );
        }

        await applyLotAssignments(session, doc, assignments, {
          actor: actorFromRequest(req),
          userId: req.user?._id,
        });
        await doc.save({ session });
        order = doc;
      });

      res.json({
        success: true,
        message: "Dye lots assigned.",
        rawMaterialRequired: order.rawMaterialRequired,
      });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

module.exports = router;
