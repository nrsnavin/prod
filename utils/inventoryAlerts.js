'use strict';
//
// Side-effect helpers for raw-material lifecycle events. Routes call
// these after their main DB write completes so a failure here never
// rolls back the stock/price change. notify() never throws, but the
// guards below (PO-in-flight check, recent-usage check) issue Mongo
// reads — those are wrapped so a hiccup just skips the alert.

const PurchaseOrder   = require("../models/PurchaseOrder.js");
const MaterialOutward = require("../models/MaterialOut.cjs");
const Order           = require("../models/Order.js");
const { notify }      = require("./notify.js");

const PO_OPEN_STATUSES = ["Open", "Partial"];

// ── criticalStockout ──────────────────────────────────────────────
// Fire when stock crosses from healthy to at-or-below minStock, but
// only if there isn't already an open PO for that material — we
// don't want to nag the owner after they've already raised one.
//
// Skip conditions:
//   - minStock <= 0 (untracked material)
//   - newStock > minStock (still healthy)
//   - oldStock <= minStock (was already in alarm; throttle handles the rest)
//   - open PO in flight for this material
async function maybeFireCriticalStockout({ material, oldStock, newStock, reason }) {
  try {
    if (!material) return;
    const min = Number(material.minStock) || 0;
    if (min <= 0) return;
    if (Number(newStock) > min) return;
    if (Number(oldStock) <= min) return;

    const openPo = await PurchaseOrder.findOne({
      "items.rawMaterial": material._id,
      status: { $in: PO_OPEN_STATUSES },
    }).select("_id").lean();
    if (openPo) return;

    // Pending demand within 7 days — gives the alert urgency context.
    let pendingOrders = 0;
    try {
      const horizon = new Date(Date.now() + 7 * 86_400_000);
      pendingOrders = await Order.countDocuments({
        status: { $in: ["Pending", "Approved", "In Production"] },
        supplyDate: { $lte: horizon },
        "rawMaterialRequired.rawMaterial": material._id,
      });
    } catch { /* count is optional flavour, not a gate */ }

    await notify("criticalStockout", {
      materialName: material.name,
      category:     material.category,
      stock:        newStock,
      minStock:     min,
      pendingOrders,
      reason,
      _entity: { type: "RawMaterial", id: String(material._id) },
    });
  } catch (err) {
    console.warn(`[inventoryAlerts] criticalStockout check failed: ${err.message}`);
  }
}

// ── priceChangeAbove10 ────────────────────────────────────────────
// Fire when |Δprice| / oldPrice >= 10%. Skips dormant materials
// (zero recent consumption) so a long-tail SKU's catalogue cleanup
// doesn't ping at 3am.
async function maybeFirePriceChangeAlert({ material, oldPrice, newPrice, reason }) {
  try {
    if (!material) return;
    const op = Number(oldPrice);
    const np = Number(newPrice);
    if (!Number.isFinite(op) || !Number.isFinite(np)) return;
    if (op <= 0) return;
    if (op === np) return;

    const percent = ((np - op) / op) * 100;
    if (Math.abs(percent) < 10) return;

    // Recent-usage gate: skip materials with effectively no usage in
    // the last 30 days. Avoids noise from catalogue cleanup of stale
    // SKUs we don't actually consume.
    const since = new Date(Date.now() - 30 * 86_400_000);
    const used = await MaterialOutward.aggregate([
      { $match: {
          rawMaterial: material._id,
          outwardDate: { $gte: since },
          reversed: { $ne: true },
      }},
      { $group: { _id: null, total: { $sum: "$quantity" } } },
    ]);
    const recent = used?.[0]?.total || 0;
    if (recent <= 0) return;

    await notify("priceChangeAbove10", {
      materialName:      material.name,
      oldPrice:          op,
      newPrice:          np,
      percent,
      direction:         np > op ? "up" : "down",
      recentConsumption: recent,
      reason,
      _entity: { type: "RawMaterial", id: String(material._id) },
    });
  } catch (err) {
    console.warn(`[inventoryAlerts] priceChange check failed: ${err.message}`);
  }
}

// ── poReceivedForCritical ─────────────────────────────────────────
// Fire only when the inward refills a material that WAS below its
// min-stock floor before the inward. Routine PO receipts on healthy
// stock are silent.
async function maybeFirePoReceivedForCritical({ material, stockBefore, stockAfter, quantity, supplierName }) {
  try {
    if (!material) return;
    const min = Number(material.minStock) || 0;
    if (min <= 0) return;
    if (Number(stockBefore) >= min) return;

    await notify("poReceivedForCritical", {
      materialName: material.name,
      quantity,
      stockBefore,
      stockAfter,
      minStock: min,
      supplierName,
      _entity: { type: "RawMaterial", id: String(material._id) },
    });
  } catch (err) {
    console.warn(`[inventoryAlerts] poReceived check failed: ${err.message}`);
  }
}

module.exports = {
  maybeFireCriticalStockout,
  maybeFirePriceChangeAlert,
  maybeFirePoReceivedForCritical,
};
