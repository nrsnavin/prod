// ══════════════════════════════════════════════════════════════════
//  ORDERS — ONE ORDER  (part of /api/v2/order)
//
//  Everything the order page shows about one order.
//
//    GET  /get-orderDetail
//
//  api/order.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const Order = require("../models/Order.js");
const Elastic = require("../models/Elastic.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const { issuedForOrder } = require("../services/orderIssuance.js");
const RawMaterial     = require("../models/RawMaterial.js");
const mongoose        = require("mongoose");
const DeliveryChallan      = require("../models/DeliveryChallan.js");
const { draftedForJobs }   = require("../services/floorDrafts.js");
const router = express.Router();

// ════════════════════════════════════════════════════════════════
//  GET ORDER DETAIL
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-orderDetail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Order ID is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid order id", 400));
    }

    const order = await Order.findById(id)
      .populate("customer",  "name gstin")
      // elasticOrdered.elastic is deliberately NOT populated: mongoose turns
      // an unresolvable ref into null, discarding the id the produced/packed/
      // pending joins below key on. Names are resolved from a lookup map
      // instead, so a deleted elastic master degrades one row's label rather
      // than throwing and taking the whole order page down with it.
      // The job's own elastic names come along so the order page can show a
      // per-job breakdown without a round trip per job.
      .populate({
        path: "jobs.job",
        populate: [
          { path: "elastics.elastic",        select: "name" },
          { path: "producedElastic.elastic", select: "name" },
          { path: "packedElastic.elastic",   select: "name" },
        ],
      })
      .populate("createdBy",  "name role")
      .populate("updatedBy",  "name role")
      .populate("approvedBy", "name role")
      .populate("cancelledBy","name role")
      .populate("startedBy",  "name role")
      .populate("completedBy","name role")
      .populate("deletedBy",  "name role")
      .lean();

    if (!order) return next(new ErrorHandler("Order not found", 404));

    // Name lookup for every elastic referenced anywhere on this order. A row
    // whose master has since been deleted simply has no entry and is labelled
    // rather than dropped — the ordered quantity is still real.
    const elasticIds = [
      ...(order.elasticOrdered || []),
      ...(order.producedElastic || []),
      ...(order.packedElastic || []),
      ...(order.pendingElastic || []),
      // Excess rows name their own elastic; it is always on the order
      // too, but relying on that would break the day it isn't.
      ...(order.excessPlanning || []),
      ...(order.amendments || []),
    ]
      .map((row) => row?.elastic)
      .filter(Boolean);
    const elasticNames = new Map(
      (await Elastic.find({ _id: { $in: elasticIds } }).select("name").lean())
        .map((el) => [String(el._id), el.name])
    );

    // Matching on strings rather than ObjectId.equals(): a null id on either
    // side used to throw here and 500 the whole page.
    const qtyFor = (rows, id) =>
      (rows || []).find((p) => p?.elastic && String(p.elastic) === id)?.quantity;

    // ── What has actually reached the customer ──────────────────────
    // Packed is goods in a box in this building; DELIVERED is goods that
    // left it on a delivery note. The page reported the first and called
    // it progress, which reads as further along than the order really
    // is — an order can be fully packed and nothing despatched.
    //
    // Summed from the notes rather than stored on the order, so it
    // cannot drift from them. Matched on the reference AND the order
    // number, because a note carries both and older rows can have one
    // without the other. Cancelled notes are excluded: nothing left the
    // building on them.
    const dcMatch = [{ order: order._id }];
    if (order.orderNo != null) dcMatch.push({ orderNo: order.orderNo });
    const orderDcs = await DeliveryChallan.find({
      $or: dcMatch,
      status: { $ne: "cancelled" },
    }).select("items").lean();

    const deliveredByElastic = new Map();
    for (const dc of orderDcs) {
      for (const item of dc.items || []) {
        if (!item.elastic) continue;
        const key = String(item.elastic);
        deliveredByElastic.set(
          key,
          (deliveredByElastic.get(key) || 0) + (Number(item.quantity) || 0)
        );
      }
    }
    const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

    // ── Entered on the floor, not verified yet ──────────────────────
    // What `produced` will become once the office verifies the floor's
    // entries (services/floorDrafts.js). Shown beside the verified
    // figure, never added to it. Per job here, summed per elastic for
    // the order's own rows below.
    const orderJobIds = (order.jobs || [])
      .map((ref) => (ref.job && typeof ref.job === "object" ? ref.job._id : ref.job))
      .filter(Boolean);
    const draftsByJob = await draftedForJobs(orderJobIds);
    const draftedByElastic = new Map();
    let draftShifts = 0;
    for (const { shifts, byElastic } of draftsByJob.values()) {
      draftShifts += shifts;
      for (const [eid, m] of byElastic) draftedByElastic.set(eid, round3((draftedByElastic.get(eid) || 0) + m));
    }

    const elastics = order.elasticOrdered.map((e) => {
      const id = String(e.elastic ?? "");
      return {
        id:       e.elastic ?? null,
        name:     elasticNames.get(id) ?? "Unknown elastic",
        ordered:  e.quantity,
        produced: qtyFor(order.producedElastic, id) || 0,
        drafted:  draftedByElastic.get(id) || 0,
        packed:   qtyFor(order.packedElastic, id)   || 0,
        // Two questions that were long conflated under "pending":
        //   notAssigned — ordered minus what jobs have been raised for.
        //     A planning figure, and the cap when allocating to a job.
        //   pendingDelivery — ordered minus packed. A delivery figure:
        //     what the customer is still owed. Work can be fully
        //     planned and still entirely pending.
        notAssigned:     qtyFor(order.pendingElastic, id) ?? e.quantity,
        pendingDelivery: Math.max(
          0,
          e.quantity - (qtyFor(order.packedElastic, id) || 0)
        ),
        // Goods that have actually left, on a delivery note. Sits beside
        // `packed` because the two are a step apart and are constantly
        // read as one.
        delivered: round3(deliveredByElastic.get(id) || 0),
        // Ordered minus delivered — what the customer is still waiting
        // for, as against `pendingDelivery` which stops at packed.
        // Negative would mean an over-despatch, which happens and is
        // worth seeing rather than clamped away.
        undelivered: round3(e.quantity - (deliveredByElastic.get(id) || 0)),
        // Legacy alias for notAssigned — the mobile app reads it as the
        // allocation cap, so its meaning must not drift.
        pending:  qtyFor(order.pendingElastic, id)  ?? e.quantity,
        reserved: qtyFor(order.reservations, id)    ?? 0,
        // Added after approval, with its own yarn draw (services/orderAmend.js).
        addedLater: !!e.addedLater,
        addedAt: e.addedAt || null,
      };
    });

    // Per-job elastic breakdown, so the order page can show at a glance what
    // each job covers and how much of it is still to weave.
    //
    // Note the two senses of "pending". At ORDER level it means "not yet
    // committed to any job" (ordered − planned; see services/orderPending.js).
    // Here it means "committed to this job but not yet woven" (planned −
    // produced). They answer different questions and must not be conflated.
    const jobs = (order.jobs || []).map((ref) => {
      const job = ref.job && typeof ref.job === "object" ? ref.job : null;
      if (!job) return ref;

      const qtyBy = (arr) => {
        const map = new Map();
        for (const row of arr || []) {
          const id = row.elastic?._id ?? row.elastic;
          if (!id) continue;
          map.set(String(id), (map.get(String(id)) || 0) + (row.quantity || 0));
        }
        return map;
      };
      const produced = qtyBy(job.producedElastic);
      const packed   = qtyBy(job.packedElastic);
      const jobDrafts = draftsByJob.get(String(job._id));

      const elasticSummary = (job.elastics || []).map((e) => {
        const id = String(e.elastic?._id ?? e.elastic ?? "");
        const planned = e.quantity || 0;
        const made    = produced.get(id) || 0;
        return {
          drafted: jobDrafts?.byElastic.get(id) || 0,
          id,
          // Falls back to the order's own naming when the job's elastic ref
          // no longer resolves (deleted master), rather than dropping the row.
          name: e.elastic?.name
            ?? elastics.find((oe) => String(oe.id) === id)?.name
            ?? "Unknown",
          planned,
          produced: made,
          packed:   packed.get(id) || 0,
          // Over-production is a data issue, not a negative outstanding qty.
          pending:  Math.max(0, planned - made),
        };
      });

      return { ...ref, elasticSummary };
    });

    // One query for every material on the order, not one per material. This
    // was a findById inside a map — an order with 20 materials opened 20
    // connections and paid 20 round trips to render one page.
    const requirementIds = (order.rawMaterialRequired || [])
      .map((rm) => rm.rawMaterial)
      .filter(Boolean);
    const materialsById = new Map(
      (await RawMaterial.find({ _id: { $in: requirementIds } })
        .select("name stock unit")
        .lean()
      ).map((m) => [String(m._id), m])
    );

    // What approval already drew for this order. Without it every
    // approved order's material panel turned red the moment it was
    // approved: the requirement had come OUT of the stock figure it was
    // then being compared against.
    const drawn = await issuedForOrder(order._id);

    const liveRawMaterials = (order.rawMaterialRequired || []).map((rm) => {
      const mat = materialsById.get(String(rm.rawMaterial));
      // A deleted material is reported as absent rather than as zero stock:
      // see utils/materialRequirement.js — "0 in stock" and "we no longer
      // know" look identical on screen but mean very different things.
      const inStock = mat?.stock ?? 0;
      const required = Number(rm.requiredWeight) || 0;
      const allocated = Math.min(required, drawn.get(String(rm.rawMaterial)) || 0);
      const outstanding = Math.max(0, Math.round((required - allocated) * 1000) / 1000);
      return {
        rawMaterial:     rm.rawMaterial,
        name:            mat?.name ?? rm.name ?? "—",
        unit:            mat?.unit ?? "kg",
        requiredWeight:  required,
        // Taken out of stock and held for this order at approval; nil
        // before it, and nil again after a cancel hands it back.
        allocated:       Math.round(allocated * 1000) / 1000,
        outstanding,
        // full  — the whole requirement is held for this order
        // partial — a forced approval drew what there was; the rest is
        //           still owed and nothing is holding it
        // none  — not approved yet, or the allocation was handed back
        allocationState: allocated <= 0
          ? "none"
          : outstanding > 0 ? "partial" : "full",
        inStock,
        stockSufficient: inStock >= outstanding,
        // The dye lots this order has set aside for the material.
        // This projection is hand-built, so a field not named here
        // simply never reaches the client — which is why the assign
        // panel had nothing to show even on orders that had earmarks.
        lots: (rm.lots || []).map((l) => ({
          yarnLot:  l.yarnLot,
          lotNo:    l.lotNo || "",
          shade:    l.shade || "",
          quantity: Number(l.quantity) || 0,
          assignedAt: l.assignedAt,
        })),
      };
    });

    const canApprove = order.status === "Open"
      ? liveRawMaterials.every((m) => m.stockSufficient)
      : undefined;

    const fingerprints = (order.fingerprints || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at));

    res.status(200).json({
      success: true,
      data: {
        _id:         order._id,
        // The document version, for the optimistic lock on /update-order.
        // This projection is hand-built and never included it, so the
        // edit form has been sending `expectedVersion: undefined` — and
        // assertVersion no-ops on an absent value, which left the lock
        // decorative: two people editing the same order both saved, and
        // the second silently won.
        __v:         order.__v,
        orderNo:     order.orderNo,
        po:          order.po,
        status:      order.status,
        date:        order.date,
        supplyDate:  order.supplyDate,
        description: order.description,
        // Floor entries on this order's jobs waiting to be verified.
        draftShifts,
        customer:    order.customer,
        elastics,
        jobs,
        rawMaterialRequired: liveRawMaterials,
        // Jobs planned past what this order asked for. Surfaced as its
        // own list rather than folded into the job rows: an excess is a
        // decision someone made and had to justify, and it is the thing
        // that explains why this order's yarn draw exceeds its lines.
        excessPlanning: (order.excessPlanning || []).map((x) => ({
          elastic:         x.elastic,
          // The snapshot survives a rename; the live name is preferred
          // when the master is still there, as everywhere else here.
          name:            elasticNames.get(String(x.elastic)) || x.elasticName || "—",
          job:             x.job,
          jobOrderNo:      x.jobOrderNo ?? null,
          jobNo:           x.jobOrderNo != null ? `J-${x.jobOrderNo}` : "—",
          orderedQuantity: x.orderedQuantity ?? 0,
          plannedQuantity: x.plannedQuantity ?? 0,
          excessQuantity:  x.excessQuantity ?? 0,
          excessPct:       x.excessPct ?? 0,
          // "" means the excess was inside the free allowance and no
          // reason was ever asked for — not that one was withheld.
          reason:          x.reason || "",
          materialsDrawn:  x.materialsDrawn || [],
          // The job was created though the yarn was short (jobRaise.js).
          forced:          !!x.forced,
          forceReason:     x.forceReason || "",
          recordedAt:      x.recordedAt || null,
        })),
        // Elastics added after approval, each with the yarn it drew and
        // what it was short — a decision someone made, with a reason.
        amendments: (order.amendments || []).map((a) => ({
          elastic:        a.elastic,
          name:           elasticNames.get(String(a.elastic)) || a.elasticName || "—",
          quantity:       a.quantity ?? 0,
          rate:           a.rate ?? 0,
          reason:         a.reason || "",
          forced:         !!a.forced,
          forceReason:    a.forceReason || "",
          shortfalls:     a.shortfalls || [],
          materialsDrawn: a.materialsDrawn || [],
          recordedAt:     a.recordedAt || null,
        })),
        canApprove,
        createdBy:   order.createdBy  || null,
        createdAt:   order.createdAt  || null,
        updatedBy:   order.updatedBy  || null,
        updatedAt:   order.updatedAt  || null,
        approvedBy:  order.approvedBy || null,
        approvedAt:  order.approvedAt || null,
        cancelledBy: order.cancelledBy|| null,
        cancelledAt: order.cancelledAt|| null,
        startedBy:   order.startedBy  || null,
        startedAt:   order.startedAt  || null,
        completedBy: order.completedBy|| null,
        completedAt: order.completedAt|| null,
        deletedBy:   order.deletedBy  || null,
        deletedAt:   order.deletedAt  || null,
        fingerprints,
      },
    });
  })
);

module.exports = router;
