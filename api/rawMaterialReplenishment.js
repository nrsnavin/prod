"use strict";
// ══════════════════════════════════════════════════════════════════
//  RAW MATERIALS — WHAT TO BUY, AND WHEN  (part of /api/v2/materials)
//
//    GET  /get-low-stock-materials
//    GET  /low-stock
//    GET  /replenishment-forecast
//    GET  /projected-stockout
//    GET  /reorder-suggestions
//
//  api/rawMaterial.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express           = require("express");
const RawMaterial       = require("../models/RawMaterial");
const PurchaseOrder     = require("../models/PurchaseOrder");
const MaterialInward    = require("../models/MaterialInward");
const MaterialOutward   = require("../models/MaterialOut.cjs");
const Order             = require("../models/Order");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const {
  dailyDemand,
  demandPattern,
  position,
  applyPurchaseRules,
  SERVICE_LEVELS,
  DEFAULT_SERVICE_LEVEL,
} = require("../services/replenishment");
const {
  observationsFrom,
  buildIndex,
  resolveLeadTime,
} = require("../services/leadTimeLearning");
const router = express.Router();

const DAY_MS = 86_400_000;

router.get(
  "/get-low-stock-materials",
  catchAsyncErrors(async (req, res, next) => {
    const materials = await RawMaterial.find({
      $expr: { $lte: ["$stock", "$minStock"] },
    })
      .populate("supplier", "name")
      .sort({ stock: 1 });
    res.status(200).json({ success: true, materials });
  })
);

// ══════════════════════════════════════════════════════════════
//  10b. LOW STOCK  (auto-draft PO source)
//       GET /materials/low-stock
//
//  Returns materials at or below their min-stock threshold, each
//  decorated with a `suggestedQty` so the Flutter draft-PO sheet
//  can render a ready-to-submit form without further math.
//
//  Quantity heuristic: max(minStock * 2 - stock, minStock).
//  This refills back to ~2x the floor while always ordering at
//  least one full reorder cycle. Pure UI suggestion — the user
//  edits the value in the PO sheet before submitting.
//
//  Materials with no supplier are excluded from `materials` and
//  surfaced as `skippedNoSupplier` so the page can show a footer
//  count instead of silently swallowing them.
// ══════════════════════════════════════════════════════════════
router.get(
  "/low-stock",
  catchAsyncErrors(async (_req, res) => {
    const docs = await RawMaterial.find({
      $expr: { $lte: ["$stock", "$minStock"] },
      minStock: { $gt: 0 },
    })
      .populate("supplier", "name")
      .select("name stock minStock price supplier")
      .sort({ stock: 1 })
      .lean();

    const materials = [];
    let skippedNoSupplier = 0;

    for (const m of docs) {
      if (!m.supplier || !m.supplier._id) {
        skippedNoSupplier += 1;
        continue;
      }
      const suggestedQty = Math.max(m.minStock * 2 - m.stock, m.minStock);
      materials.push({
        _id:          m._id,
        name:         m.name,
        stock:        m.stock,
        minStock:     m.minStock,
        price:        m.price || 0,
        suggestedQty,
        supplier:     { _id: m.supplier._id, name: m.supplier.name },
      });
    }

    res.status(200).json({
      success: true,
      materials,
      skippedNoSupplier,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  GET /materials/replenishment-forecast
//      ?lookbackDays=60 &coverDays=30 &serviceLevel=95
//
//  WHAT TO BUY, AND THE LAST DAY IT CAN LEAVE.
//
//  The reorder-point model — see services/replenishment.js for the
//  arithmetic and the reasoning. This route's job is to gather the four
//  inputs honestly, which is where the previous version went wrong:
//
//  1. COMMITTED DEMAND WAS ALWAYS ZERO. It read `rm.quantity` off
//     Order.rawMaterialRequired, whose field is `requiredWeight`. The
//     endpoint advertised the Open-order pipeline as one of its three
//     inputs and that input contributed nothing, ever.
//
//  2. STOCK ON ORDER WAS IGNORED. A raised, unreceived PO is stock that
//     is coming; nothing looked at purchase orders, so the same
//     shortfall was recommended again every time the page was opened.
//
//  3. HALF THE CONSUMPTION WAS INVISIBLE. The run-rate counted
//     ORDER_APPROVAL draws only. Yarn issued against a job during the
//     run (JOB_CONSUMPTION) moved the rate not at all.
//
//  4. ARCHIVED MATERIALS WERE STILL RECOMMENDED. `find({})`, no filter.
//
//  5. THERE WAS NO LEAD TIME ANYWHERE, so "order this" never meant
//     "order this BY a date" — which is the only actionable output a
//     replenishment report has.
//
//  Deterministic throughout. The optional Claude summary explains the
//  ranking in words; it does not choose a number and cannot change one.
// ══════════════════════════════════════════════════════════════
router.get(
  "/replenishment-forecast",
  catchAsyncErrors(async (req, res) => {
    // A longer default window than the old 30 days: safety stock is
    // driven by the spread of daily demand, and a month of a mill's
    // draws is too few days to estimate a spread from.
    const lookbackDays = Math.min(Math.max(Number(req.query.lookbackDays) || 60, 7), 365);
    const coverDays    = Math.min(Math.max(Number(req.query.coverDays)    || 30, 1), 180);
    const serviceLevel = SERVICE_LEVELS[Number(req.query.serviceLevel)]
      ? Number(req.query.serviceLevel)
      : DEFAULT_SERVICE_LEVEL;

    // Kept so existing callers (and the web page) do not break; it no
    // longer drives the decision, because the reorder point is set by
    // the lead time rather than by an arbitrary look-ahead.
    const horizonDays = Math.min(Math.max(Number(req.query.horizonDays) || 14, 1), 120);

    // Return the materials that DON'T need ordering too.
    //
    // The buying list is the point of this endpoint, so by default it
    // returns only what breaches its reorder point. But that made the
    // whole model invisible whenever nothing did — and with no lead
    // times set, which is where every mill starts, almost nothing does.
    // The page then showed an empty state, which reads as "the system
    // has nothing to say" rather than "everything is comfortable, and
    // here is why".
    //
    // Off by default so the buying list stays a buying list.
    const includeHealthy = req.query.includeHealthy === '1'
      || req.query.includeHealthy === 'true';

    const now   = new Date();
    const since = new Date(now.getTime() - lookbackDays * DAY_MS);

    // Learning window: a year of deliveries. Long enough for a
    // seasonal pattern, short enough that a supplier's behaviour from
    // two mills ago is not still setting today's safety stock.
    const learnSince = new Date(now.getTime() - 365 * DAY_MS);

    const [materials, draws, openOrders, openPos, receipts, historicPos] = await Promise.all([
      // Archived materials are retired — out of every picker, and out of
      // the buying list too.
      RawMaterial.find({ archived: { $ne: true } })
        .select("-stockMovements")
        .populate("supplier", "name leadTimeDays minOrderQty packSize")
        .lean(),

      // BOTH ways yarn leaves stock. STOCK_ADJUST is excluded on
      // purpose: a write-off or a count correction is not demand, and
      // treating it as such would have the system buy yarn to replace
      // stock that was never consumed.
      MaterialOutward.find({
        type: { $in: ["ORDER_APPROVAL", "JOB_CONSUMPTION"] },
        reversed: { $ne: true },
        createdAt: { $gte: since },
      }).select("rawMaterial quantity createdAt outwardDate").lean(),

      // Not yet approved, so not yet drawn — this is demand still to
      // come out of stock.
      Order.find({ status: "Open" }).select("rawMaterialRequired").lean(),

      // Raised and not fully received: stock that is on its way.
      PurchaseOrder.find({ status: { $in: ["Open", "Partial"] } })
        .select("items")
        .lean(),

      // ── The ground truth the lead time is LEARNED from ────────
      // A goods receipt names the PO it came against, so
      // inwardDate − po.date is an observed lead time for that
      // supplier and material. Every delivery adds one; there is no
      // training step and no model file, because the estimate IS the
      // data, recomputed on read.
      MaterialInward.find({
        purchaseOrder: { $ne: null },
        inwardDate: { $gte: learnSince },
      }).select("purchaseOrder rawMaterial inwardDate createdAt").lean(),

      PurchaseOrder.find({ date: { $gte: new Date(learnSince.getTime() - 400 * DAY_MS) } })
        .select("date supplier")
        .lean(),
    ]);

    // ── What the deliveries say ───────────────────────────────
    const poById = new Map(historicPos.map((p) => [String(p._id), p]));
    const observations = observationsFrom(receipts, poById, { now, windowDays: 365 });
    const learned = buildIndex(observations);

    // ── Demand series, per material ───────────────────────────
    const drawsById = new Map();
    for (const d of draws) {
      const id = String(d.rawMaterial);
      if (!drawsById.has(id)) drawsById.set(id, []);
      drawsById.get(id).push({
        at: d.outwardDate || d.createdAt,
        quantity: Number(d.quantity) || 0,
      });
    }

    // ── Committed: `requiredWeight`, which is what the field is called
    const committedById = new Map();
    for (const o of openOrders) {
      for (const rm of o.rawMaterialRequired || []) {
        if (!rm?.rawMaterial) continue;
        const id = String(rm.rawMaterial);
        committedById.set(id, (committedById.get(id) || 0) + (Number(rm.requiredWeight) || 0));
      }
    }

    // ── On order: raised minus received, never negative ───────
    const onOrderById = new Map();
    for (const po of openPos) {
      for (const it of po.items || []) {
        if (!it?.rawMaterial) continue;
        const id = String(it.rawMaterial);
        // An over-receipt (allowed, within tolerance) must not become a
        // negative inbound that inflates the shortfall.
        const outstanding = Math.max(
          0,
          (Number(it.quantity) || 0) - (Number(it.receivedQuantity) || 0)
        );
        onOrderById.set(id, (onOrderById.get(id) || 0) + outstanding);
      }
    }

    const flagged = [];
    let skippedNoSupplier = 0;

    for (const m of materials) {
      const id = String(m._id);
      const materialDraws = drawsById.get(id) || [];
      const demand = dailyDemand(materialDraws, lookbackDays, now);

      // A typed figure wins over a learned one — somebody may know
      // something the history cannot. The learned figure is reported
      // alongside either way, so a manual entry the deliveries
      // contradict is visible rather than silently obeyed.
      const supplierId = m.supplier?._id ? String(m.supplier._id) : null;
      const lead = resolveLeadTime({
        materialLeadTime: m.leadTimeDays,
        supplierLeadTime: m.supplier?.leadTimeDays,
        observed: {
          material: learned.material.get(`${supplierId || '-'}:${id}`) || null,
          supplier: supplierId ? learned.supplier.get(supplierId) || null : null,
        },
      });

      const pos = position({
        onHand:    Number(m.stock) || 0,
        onOrder:   onOrderById.get(id) || 0,
        committed: committedById.get(id) || 0,
        minStock:  Number(m.minStock) || 0,
        leadTimeDays: lead.days,
        // Measured spread of the delivery time. Zero when there is no
        // history, which collapses the safety-stock formula back to
        // the fixed-lead-time one exactly.
        leadTimeSd: lead.sd,
        coverDays,
        serviceLevel,
        demand,
        now,
      });

      const needsOrder = pos.shouldOrder && pos.suggestedQty > 0;
      if (!needsOrder && !includeHealthy) continue;

      // A line nobody can act on is noise on a BUYING list — but it is
      // still a material whose position somebody may want to inspect,
      // so it is only dropped when the buying list is what was asked
      // for.
      if (!m.supplier || !m.supplier._id) {
        if (needsOrder) skippedNoSupplier += 1;
        if (!includeHealthy) continue;
      }

      const orderQty = applyPurchaseRules(pos.suggestedQty, {
        minOrderQty: m.supplier?.minOrderQty,
        packSize:    m.supplier?.packSize,
      });

      flagged.push({
        _id: id,
        name: m.name,
        category: m.category,
        unit: m.unit || "kg",
        price: Number(m.price) || 0,
        ...pos,

        // Where the lead time came from, and what the deliveries say.
        // A buyer who cannot see this cannot tell a measured 14 days
        // from a typed one, and the two deserve different trust.
        leadTimeSource: lead.source,
        leadTimeObserved: lead.learned
          ? {
              median: lead.learned.median,
              sd: lead.learned.sd,
              deliveries: lead.learned.n,
              confidence: lead.learned.confidence,
              fastest: lead.learned.min,
              slowest: lead.learned.max,
            }
          : null,
        // True when a typed lead time and the measured one are five or
        // more days apart. Not corrected automatically — surfaced, so
        // somebody decides.
        leadTimeDisagrees: lead.disagrees,

        // What the demand looks like, so a buyer can weigh the figure.
        // An intermittent yarn's safety stock is dominated by its zero
        // days and the suggestion reads high; saying so is better than
        // quietly switching formula behind their back.
        demandPattern: demandPattern(demand, materialDraws.length),
        drawsInWindow: materialDraws.length,

        // Legacy names, so the existing web page keeps rendering.
        onHand: pos.onHand,
        runRatePerDay: pos.dailyDemand,
        committedDemand: pos.committed,
        projectedStock: pos.netStock,
        daysToStockout: pos.daysOfCover != null ? Math.round(pos.daysOfCover) : null,

        suggestedQty: orderQty,
        rawSuggestedQty: pos.suggestedQty,
        estimatedCost: Math.round(orderQty * (Number(m.price) || 0)),
        // Says which of these is a line to act on, as its own field
        // rather than something a reader has to infer from a quantity.
        needsOrder,
        supplier: m.supplier?._id
          ? {
              _id: String(m.supplier._id),
              name: m.supplier.name,
              leadTimeDays: Number(m.supplier.leadTimeDays) || 0,
            }
          : null,
      });
    }

    // Everything below — the ordering, the per-supplier grouping, the
    // totals — is about the BUYING LIST, so it reads only the lines
    // that need ordering. A healthy material rides along for inspection
    // and must not appear in a draft PO or an estimated spend.
    const toBuy = flagged.filter((f) => f.needsOrder && f.supplier);

    // Late first — an order that cannot arrive in time is a different
    // and more urgent thing than one merely below its reorder point.
    // Then by how few days of cover are left.
    toBuy.sort((a, b) => {
      if (a.alreadyLate !== b.alreadyLate) return a.alreadyLate ? -1 : 1;
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      const ac = a.daysOfCover ?? -1;   // no demand at all sorts LAST,
      const bc = b.daysOfCover ?? -1;   // but a certain stockout does not
      if (ac < 0 || bc < 0) return ac < 0 ? 1 : -1;
      return ac - bc;
    });

    // One PO per vendor.
    const bySupplierMap = new Map();
    for (const f of toBuy) {
      const key = f.supplier._id;
      if (!bySupplierMap.has(key)) {
        bySupplierMap.set(key, { supplier: f.supplier, lines: [], estimatedCost: 0 });
      }
      const g = bySupplierMap.get(key);
      g.lines.push(f);
      g.estimatedCost += f.estimatedCost;
    }
    const bySupplier = [...bySupplierMap.values()];

    // Lead time is the input the whole model rests on, and it defaults
    // to zero. A mill that has set none gets the old behaviour and no
    // explanation of why nothing is ever flagged early — so say it.
    const noLeadTime = materials.filter(
      (m) => !(m.leadTimeDays ?? m.supplier?.leadTimeDays)
    ).length;

    const totals = {
      flagged: toBuy.length,
      critical: toBuy.filter((f) => f.severity === "critical").length,
      late: toBuy.filter((f) => f.alreadyLate).length,
      suppliers: bySupplier.length,
      estimatedCost: toBuy.reduce((s, f) => s + f.estimatedCost, 0),
      // Only meaningful when the healthy ones were asked for.
      reviewed: includeHealthy ? flagged.length : undefined,
    };

    const warnings = [];
    if (noLeadTime > 0) {
      warnings.push(
        `${noLeadTime} material(s) have no lead time set, on themselves or their supplier. ` +
        `Their reorder point is the manual minimum stock only, and no "order by" date can ` +
        `be worked out — set a lead time on the supplier to get one.`
      );
    }
    if (skippedNoSupplier > 0) {
      warnings.push(
        `${skippedNoSupplier} material(s) need reordering but have no supplier, so they ` +
        `cannot be put on a purchase order.`
      );
    }

    // ── The narrative ─────────────────────────────────────────
    // Explains the ranking; it does not decide it. Every number above
    // is already fixed by the time this runs, and a failure here loses
    // the prose and nothing else.
    let aiSummary = null, aiGenerated = false;
    const claude = anthropic();
    if (claude && toBuy.length > 0) {
      try {
        const facts = toBuy.slice(0, 8).map((f) =>
          `${f.name}: net ${f.netStock} ${f.unit} (on hand ${f.onHand}, on order ${f.onOrder}, ` +
          `committed ${f.committed}), uses ${f.dailyDemand}/day, lead time ${f.leadTimeDays}d, ` +
          `reorder point ${f.reorderPoint}, ${f.daysOfCover ?? "?"} days cover` +
          `${f.orderByDate ? `, order by ${f.orderByDate}` : ""}` +
          `${f.alreadyLate ? " (ALREADY LATE)" : ""} → buy ${f.suggestedQty}`
        ).join("\n");
        const msg = await claude.messages.create({
          model: TEXT_MODEL,
          max_tokens: 350,
          system:
            "You are a procurement planner for an elastic (narrow-fabric) plant. Given a raw-material " +
            "replenishment forecast, write 2-3 short bullet lines starting with '- ': which materials are " +
            "most urgent and why, and any consolidation worth doing (same supplier). Plain text, no preamble.",
          messages: [{ role: "user", content: `Horizon ${horizonDays} days.\n${facts}\n\nSummarise the replenishment need.` }],
        });
        aiSummary = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        aiGenerated = true;
      } catch (err) {
        console.warn("[replenishment-forecast] AI failed:", err?.message);
      }
    }

    res.json({
      success: true,
      horizonDays, lookbackDays, coverDays, serviceLevel,
      totals,
      // Everything that was assessed — the buying list when
      // includeHealthy is off, every material when it is on.
      materials: flagged,
      bySupplier, skippedNoSupplier,
      // The model rests on lead time and it defaults to zero. A mill
      // that has set none gets a reorder point of just its manual
      // minimum and no "order by" date — worth saying out loud rather
      // than letting the page look quietly empty.
      warnings,
      aiSummary, aiGenerated,
    });
  })
);

// ══════════════════════════════════════════════════════════════
//  PROJECTED STOCKOUT  (predictive low-stock)
//  GET /materials/projected-stockout?lookbackDays=30&horizonDays=7
//
//  For each material that is NOT already below its min-stock
//  floor (those are handled by /low-stock), project a stockout
//  date using its trailing daily consumption rate:
//
//      dailyRate     = Σ outward(quantity, last lookbackDays)
//                      / lookbackDays
//      daysToStockout = stock / dailyRate
//
//  Materials whose `daysToStockout < horizonDays` are returned
//  with a `suggestedQty` sized so the next reorder lands above
//  the floor after one trailing horizon's worth of consumption:
//
//      suggestedQty = max(minStock * 2 - stock + dailyRate * horizonDays,
//                         minStock)
//
//  Materials with reversed outward rows are excluded from the
//  consumption sum (the original write was rolled back).
// ══════════════════════════════════════════════════════════════
router.get(
  "/projected-stockout",
  catchAsyncErrors(async (req, res) => {
    const lookback  = Math.max(1, parseInt(req.query.lookbackDays, 10) || 30);
    const horizon   = Math.max(1, parseInt(req.query.horizonDays,  10) || 7);

    const since = new Date(Date.now() - lookback * 86_400_000);

    // Materials still in safe territory — strict > so we don't
    // double-count what /low-stock already surfaces.
    const mats = await RawMaterial.find({
      $expr: { $gt: ["$stock", "$minStock"] },
      stock:    { $gt: 0 },
      minStock: { $gt: 0 },
    })
      .populate("supplier", "name")
      .select("name stock minStock price supplier")
      .lean();

    if (mats.length === 0) {
      return res.json({ success: true, materials: [], count: 0 });
    }

    // One aggregation over MaterialOutward, bucketed per material.
    const totals = await MaterialOutward.aggregate([
      { $match: {
          rawMaterial: { $in: mats.map((m) => m._id) },
          outwardDate: { $gte: since },
          reversed:    { $ne: true },
        } },
      { $group: { _id: '$rawMaterial', total: { $sum: '$quantity' } } },
    ]);
    const consumedById = new Map(
      totals.map((t) => [String(t._id), t.total])
    );

    const out = [];
    for (const m of mats) {
      const consumed  = consumedById.get(String(m._id)) || 0;
      if (consumed <= 0) continue;
      const dailyRate = consumed / lookback;
      const daysToStockout = m.stock / dailyRate;
      if (daysToStockout >= horizon) continue;
      if (!m.supplier || !m.supplier._id) continue;

      const suggestedQty = Math.max(
        m.minStock * 2 - m.stock + dailyRate * horizon,
        m.minStock
      );

      out.push({
        _id:           m._id,
        name:          m.name,
        stock:         m.stock,
        minStock:      m.minStock,
        price:         m.price || 0,
        dailyRate:     parseFloat(dailyRate.toFixed(2)),
        daysToStockout: parseFloat(daysToStockout.toFixed(1)),
        suggestedQty:  parseFloat(suggestedQty.toFixed(2)),
        supplier:      { _id: m.supplier._id, name: m.supplier.name },
      });
    }
    out.sort((a, b) => a.daysToStockout - b.daysToStockout);

    res.json({
      success: true,
      lookbackDays: lookback,
      horizonDays:  horizon,
      materials:    out,
      count:        out.length,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /materials/reorder-suggestions
//
//  Every material at/below its minimum, grouped by default
//  supplier, with a suggested order quantity that tops stock
//  back up to 2× minStock (a simple min/max policy). The web
//  app turns each supplier group into a one-click PO draft.
// ─────────────────────────────────────────────────────────────
router.get(
  "/reorder-suggestions",
  catchAsyncErrors(async (req, res) => {
    const low = await RawMaterial.find({ $expr: { $lte: ["$stock", "$minStock"] } })
      .populate("supplier", "name")
      .select("name category stock minStock price supplier")
      .sort({ stock: 1 })
      .lean();

    const groups = new Map();
    let suggestedCount = 0;
    for (const m of low) {
      const suggestedQty = Math.max(0, m.minStock * 2 - m.stock);
      // Skip items with nothing to reorder — happens when minStock is
      // unset (0), which would otherwise put a zero-qty line into the PO
      // draft and get rejected by /create-po.
      if (suggestedQty <= 0) continue;
      suggestedCount += 1;
      const key = m.supplier?._id?.toString() ?? "none";
      if (!groups.has(key)) {
        groups.set(key, {
          supplierId: m.supplier?._id ?? null,
          supplierName: m.supplier?.name ?? "No default supplier",
          items: [],
          estimatedValue: 0,
        });
      }
      const g = groups.get(key);
      g.items.push({
        materialId: m._id,
        name: m.name,
        category: m.category,
        stock: m.stock,
        minStock: m.minStock,
        price: m.price,
        suggestedQty,
      });
      g.estimatedValue += suggestedQty * (m.price || 0);
    }

    res.json({
      success: true,
      count: suggestedCount,
      suppliers: [...groups.values()].map((g) => ({
        ...g,
        estimatedValue: Math.round(g.estimatedValue * 100) / 100,
      })),
    });
  })
);

module.exports = router;
