'use strict';
// Outbox handler registry — maps an event `kind` to the async function
// the dispatcher runs to deliver it. Handlers re-read whatever they need
// by id (the payload carries identifiers plus the values known at commit
// time), so a delayed delivery still reports accurate facts.
//
// Requires are lazy (inside functions) to keep this module import-cheap
// and cycle-free — utils/outbox.js requires this file at module load.

const HANDLERS = {
  // Generic passthrough: enqueue(session, "notify", { event, payload }).
  async notify({ event, payload }) {
    const { notify } = require("./notify.js");
    if (!event) throw new Error("notify handler needs payload.event");
    await notify(event, payload || {});
  },

  // High-wastage alert: fires only when today's wastage on this elastic/
  // machine exceeds 10% of today's production. Was a fire-and-forget IIFE
  // in api/wastage.js — a crash or restart lost the alert; now it retries.
  async "wastage.highEventCheck"({ wastageId, jobId, elasticId, quantity, actor }) {
    const mongoose    = require("mongoose");
    const JobOrder    = require("../models/JobOrder.js");
    const ShiftDetail = require("../models/ShiftDetail.js");
    const Wastage     = require("../models/Wastage.js");
    const { notify }  = require("./notify.js");

    const job = await JobOrder.findById(jobId).select("machine jobOrderNo").lean();
    if (!job?.machine) return;

    const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    const rows = await ShiftDetail.aggregate([
      { $match: {
          status:  "closed",
          machine: job.machine,
          date:    { $gte: startToday },
          "elastics.elastic": new mongoose.Types.ObjectId(String(elasticId)),
        } },
      { $group: { _id: null, total: { $sum: "$productionMeters" } } },
    ]);
    const dailyProduction = rows[0]?.total || 0;
    if (dailyProduction < quantity * 2) return; // % meaningless without production
    const pct = (quantity / dailyProduction) * 100;
    if (pct < 10) return;

    const wastage = await Wastage.findById(wastageId)
      .populate("elastic", "name")
      .populate("employee", "name")
      .lean();
    if (!wastage) return; // deleted before delivery — nothing to report

    await notify("wastageHighEvent", {
      jobNo:           job.jobOrderNo,
      elasticName:     wastage.elastic?.name,
      quantity,
      dailyProduction,
      percent:         pct,
      reason:          wastage.reason,
      employee:        wastage.employee?.name,
      _entity: { type: "JobOrder", id: String(jobId) },
      _actor:  actor || undefined,
    });
  },

  // Late-dispatch alert: DC cut after the linked order's promised date.
  // Was a fire-and-forget IIFE in api/deliveryChallan.js.
  async "dc.delayedDeliveryCheck"({ dcId, orderId }) {
    const Order           = require("../models/Order.js");
    const Customer        = require("../models/Customer.js");
    const DeliveryChallan = require("../models/DeliveryChallan.js");
    const { notify }      = require("./notify.js");

    if (!orderId) return;
    const [orderDoc, dc] = await Promise.all([
      Order.findById(orderId).select("orderNo supplyDate customer").lean(),
      DeliveryChallan.findById(dcId).select("dcNumber dispatchDate customerName").lean(),
    ]);
    if (!orderDoc?.supplyDate || !dc) return;

    const dispatched = dc.dispatchDate ? new Date(dc.dispatchDate) : new Date();
    const promised   = new Date(orderDoc.supplyDate);
    const lateMs     = dispatched.getTime() - promised.setHours(23, 59, 59, 999);
    if (lateMs <= 0) return;

    let custName = dc.customerName;
    if (orderDoc.customer) {
      const c = await Customer.findById(orderDoc.customer).select("name").lean();
      custName = c?.name || custName;
    }

    await notify("dcDelayedDelivery", {
      dcNumber:     dc.dcNumber,
      orderNo:      orderDoc.orderNo,
      customerName: custName,
      supplyDate:   orderDoc.supplyDate,
      dispatchDate: dispatched,
      lateDays:     Math.ceil(lateMs / 86_400_000),
      _entity: { type: "DeliveryChallan", id: String(dcId) },
    });
  },

  // Critical stockout: material crossed its min-stock floor with no open
  // PO. Values captured at commit time; the helper re-checks skip rules.
  async "inventory.stockoutCheck"({ materialId, oldStock, newStock, reason }) {
    const RawMaterial = require("../models/RawMaterial.js");
    const { maybeFireCriticalStockout } = require("./inventoryAlerts.js");
    const material = await RawMaterial.findById(materialId).lean();
    if (!material) return;
    await maybeFireCriticalStockout({ material, oldStock, newStock, reason });
  },
};

function getHandler(kind) {
  return HANDLERS[kind] || null;
}

module.exports = { getHandler, HANDLERS };
