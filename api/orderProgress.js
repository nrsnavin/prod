// ══════════════════════════════════════════════════════════════════
//  ORDERS — OPEN WORK, ETAS, DELIVERY RISK, STATUS REPORTS  (part of /api/v2/order)
//
//    GET   /get-open-orders
//    GET   /get-pending-orders
//    GET   /delivery-risk
//    POST  /estimate-completion
//    GET   /:id/running-eta
//    POST  /running-eta-bulk
//    GET   /eta-risks
//    POST  /bulk/status-report.pdf
//    GET   /:id/status-report
//    GET   /:id/status-report.pdf
//
//  api/order.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require("express");
const { renderPdf } = require("../utils/renderPdf");
const { isAuthenticated, isAdmin } = require("../middleware/auth.js");
const catchAsyncErrors = require("../middleware/catchAsyncErrors.js");
const Order = require("../models/Order.js");
const ErrorHandler = require("../utils/ErrorHandler.js");
const { sendError } = require("../utils/routeError");
const { buildOrderStatusReport } = require("../services/orderStatusReport.js");
const { getPdfBranding } = require("../services/documentSettings.js");
const mongoose        = require("mongoose");
const { estimateOrderEta } = require("../utils/orderEta.js");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient.js");
// ETA forecast engine lives in its own service (Phase 4 god-file split).
// The routes below and utils/digest.js both consume these; keeping them
// in one module means the digest and the order card show identical numbers.
const {
  _computeRunningEtaForOrder,
  _loadPlantMetersPerMachineDay,
  _loadFreeMachineCount,
  buildEntryTimeAggregates,
} = require("../services/etaService.js");
const router = express.Router();

// ════════════════════════════════════════════════════════════════
//  GET OPEN ORDERS
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-open-orders",
  catchAsyncErrors(async (req, res, next) => {
    const openOrders = await Order.find({ status: "Open" })
      .populate("customer")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, openOrders });
  })
);

// ════════════════════════════════════════════════════════════════
//  GET PENDING (APPROVED) ORDERS
// ════════════════════════════════════════════════════════════════
router.get(
  "/get-pending-orders",
  catchAsyncErrors(async (req, res, next) => {
    const pending = await Order.find({ status: "Approved" })
      .populate("customer")
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, pending });
  })
);

// ══════════════════════════════════════════════════════════════
//  GET /delivery-risk?horizonDays=7
//  Orders whose supplyDate lands inside the horizon and still
//  have outstanding production (pendingElastic total > 0). Powers
//  the AIAdvisor "delivery risk" card on the admin dashboard.
//
//  Status filter excludes Completed, Cancelled, Deleted — those
//  are not going to ship anyway.
// ══════════════════════════════════════════════════════════════
router.get('/delivery-risk', async (req, res) => {
  try {
    const horizon = Math.max(1, parseInt(req.query.horizonDays, 10) || 7);
    const now     = new Date();
    const cutoff  = new Date(now.getTime() + horizon * 86_400_000);

    const orders = await Order.find({
      status:     { $in: ['Open', 'Approved', 'InProgress'] },
      supplyDate: { $lte: cutoff },
    })
      .select('orderNo customer status supplyDate pendingElastic')
      .populate('customer', 'name')
      .lean();

    const at_risk = [];
    for (const o of orders) {
      const pendingUnits = (o.pendingElastic || []).reduce(
        (sum, p) => sum + (Number(p.quantity) || 0),
        0
      );
      if (pendingUnits <= 0) continue;
      const daysToSupply = Math.ceil(
        (new Date(o.supplyDate).getTime() - now.getTime()) / 86_400_000
      );
      at_risk.push({
        orderId:      o._id,
        orderNo:      o.orderNo,
        customerName: o.customer?.name ?? '—',
        status:       o.status,
        supplyDate:   o.supplyDate,
        daysToSupply,
        pendingUnits,
      });
    }
    at_risk.sort((a, b) => a.daysToSupply - b.daysToSupply);

    return res.json({
      success: true,
      horizonDays: horizon,
      orders:  at_risk,
      count:   at_risk.length,
    });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ═════════════════════════════════════════════════════════════════
//  POST /api/v2/order/estimate-completion
//  Live ETA for an order while the admin is still typing it. Reads
//  recent production + attendance + machine state, feeds the pure
//  heuristic in utils/orderEta.js. Read-only — safe to call on every
//  keystroke (frontend debounces).
//
//  Body:
//    {
//      elasticOrdered: [{ elastic: id, quantity: meters }, ...],
//      supplyDate?: ISO date (optional, for risk chip),
//      machines?:   number   (optional, override default parallelism)
//    }
// ═════════════════════════════════════════════════════════════════
router.post(
  "/estimate-completion",
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const { elasticOrdered, supplyDate, machines } = req.body || {};
    if (!Array.isArray(elasticOrdered) || elasticOrdered.length === 0) {
      return res.status(400).json({
        success: false,
        message: "elasticOrdered must be a non-empty array of { elastic, quantity }",
      });
    }

    const now = new Date();

    // Gather + shape the plant/elastic/machine/attendance aggregates
    // (services/etaService.js) — one round-trip block, no req/res.
    const { aggregates, summary } = await buildEntryTimeAggregates(elasticOrdered, now);

    const result = estimateOrderEta({
      lines: elasticOrdered,
      machines,
      supplyDate,
      today: now,
      aggregates,
    });

    return res.json({
      success: true,
      ...result,
      aggregates: summary,
    });
  }),
);

// ETA engine (_computeRunningEtaForOrder, _fallbackEntryTimeEta,
// _loadPlantMetersPerMachineDay, _loadFreeMachineCount) moved to
// services/etaService.js — imported at the top of this file.

// ═════════════════════════════════════════════════════════════════
//  GET /api/v2/order/:id/running-eta
//
//  Live ETA for an in-flight order. Uses the per-(elastic, machine)
//  Bayesian rate posterior when available, falling back to the
//  plant-wide blended rate (then cold-start) when the posterior
//  doesn't have enough data for a pair yet.
//
//  Returned shape mirrors the Add-Order /estimate-completion route
//  enough that the frontend can share a card widget, plus a
//  perJob breakdown so the admin can see which job is dragging the
//  order late.
// ═════════════════════════════════════════════════════════════════
router.get(
  "/:id/running-eta",
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const orderId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const now = new Date();
    const [plantMetersPerMachineDay, freeMachines] = await Promise.all([
      _loadPlantMetersPerMachineDay(now),
      _loadFreeMachineCount(),
    ]);
    const result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines);

    return res.json({
      success: true,
      orderId: order._id,
      orderNo: order.orderNo,
      status:  order.status,
      ...result,
    });
  }),
);

// ═════════════════════════════════════════════════════════════════
//  POST /api/v2/order/running-eta-bulk
//
//  Compact ETA summary for many orders at once. Used by the order
//  list to render a per-row chip without N+1 round trips. Returns
//  one entry per order id including those not in an in-flight
//  state — the frontend decides whether to render a chip or not.
//
//  Body: { orderIds: [id, id, ...] }   max 50
// ═════════════════════════════════════════════════════════════════
router.post(
  "/running-eta-bulk",
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : null;
    if (!orderIds || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "orderIds must be a non-empty array",
      });
    }
    if (orderIds.length > 50) {
      return res.status(400).json({
        success: false,
        message: "orderIds capped at 50 per request",
      });
    }

    const validIds = orderIds
      .filter((id) => typeof id === "string" && mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const orders = await Order.find({ _id: { $in: validIds } })
      .select({ _id: 1, orderNo: 1, status: 1, supplyDate: 1 })
      .lean();
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

    const now = new Date();
    // Only load plant rate if we have at least one in-flight order to
    // compute — avoids a useless aggregation on lists of only Open or
    // Completed orders.
    const inFlight = orders.filter(
      (o) => o.status === "Approved" || o.status === "InProgress"
    );
    const [plantMetersPerMachineDay, freeMachines] = inFlight.length > 0
      ? await Promise.all([_loadPlantMetersPerMachineDay(now), _loadFreeMachineCount()])
      : [null, 1];

    const etas = {};
    for (const id of orderIds) {
      const order = orderById.get(String(id));
      if (!order) {
        etas[id] = { ok: false, reason: "NOT_FOUND" };
        continue;
      }
      if (order.status !== "Approved" && order.status !== "InProgress") {
        etas[id] = { ok: false, reason: "NOT_RUNNING", status: order.status };
        continue;
      }
      // Per-order try/catch so a single bad order can't poison the
      // whole batch — frontend chip just shows "ETA error" for that
      // row instead of every row failing.
      let result;
      try {
        result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines);
      } catch (err) {
        console.warn(
          "[running-eta-bulk] order", String(id), "failed:", err?.message
        );
        etas[id] = { ok: false, reason: "COMPUTE_ERROR", message: err?.message };
        continue;
      }
      if (result.ok) {
        etas[id] = {
          ok: true,
          expectedDate: result.expectedDate,
          workingDays:  result.workingDays,
          weavingDays:  result.weavingDays,
          leadDays:     result.leadDays,
          late:           result.risk?.late === true,
          lateWorkingDays: result.risk?.lateWorkingDays || 0,
          rateSources:  result.rateSources,
        };
      } else {
        etas[id] = { ok: false, reason: result.reason || "UNKNOWN" };
      }
    }

    return res.json({ success: true, etas });
  }),
);

// ═════════════════════════════════════════════════════════════════
//  GET /api/v2/order/eta-risks
//
//  Proactive delivery-risk detection: for every in-flight order, run
//  the ML ETA and surface the ones whose predicted completion slips
//  PAST the promised supply date (not just "date is near" — actually
//  predicted late). Each risk comes with a ready-to-send customer
//  message draft, so the admin approves & sends (human-in-the-loop)
//  instead of chasing manually.
// ═════════════════════════════════════════════════════════════════
function _fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
}
function _draftCustomerUpdate({ customerName, orderNo, expectedDate, promised, lateWorkingDays }) {
  const name = customerName && customerName !== '—' ? customerName : 'Sir/Madam';
  return (
    `Dear ${name}, an update on your order #${orderNo}: based on current production ` +
    `progress we now expect completion around ${_fmtDate(expectedDate)}, about ` +
    `${lateWorkingDays} working day${lateWorkingDays === 1 ? '' : 's'} later than the planned ` +
    `${_fmtDate(promised)}. We are prioritising it and will keep you updated. ` +
    `Thank you for your patience.`
  );
}

router.get(
  '/eta-risks',
  isAuthenticated, isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    const now = new Date();
    const orders = await Order.find({ status: { $in: ['Approved', 'InProgress'] } })
      .select('orderNo status supplyDate customer elasticOrdered producedElastic')
      .populate('customer', 'name phoneNumber')
      .lean();

    if (orders.length === 0) {
      return res.json({ success: true, count: 0, generatedAt: now, risks: [] });
    }

    const [plantMetersPerMachineDay, freeMachines] = await Promise.all([
      _loadPlantMetersPerMachineDay(now),
      _loadFreeMachineCount(),
    ]);
    const risks = [];
    for (const order of orders) {
      let result;
      try {
        result = await _computeRunningEtaForOrder(order, plantMetersPerMachineDay, now, freeMachines);
      } catch (err) {
        console.warn('[eta-risks] order', String(order._id), 'failed:', err?.message);
        continue;
      }
      if (!result.ok || !result.risk?.late) continue;
      const lateWorkingDays = result.risk.lateWorkingDays || 0;
      risks.push({
        orderId:         order._id,
        orderNo:         order.orderNo,
        status:          order.status,
        customer:        { name: order.customer?.name || '—', phone: order.customer?.phoneNumber || null },
        promised:        order.supplyDate,
        expectedDate:    result.expectedDate,
        workingDays:     result.workingDays,
        lateWorkingDays,
        draft: _draftCustomerUpdate({
          customerName: order.customer?.name,
          orderNo: order.orderNo,
          expectedDate: result.expectedDate,
          promised: order.supplyDate,
          lateWorkingDays,
        }),
      });
    }
    risks.sort((a, b) => b.lateWorkingDays - a.lateWorkingDays);

    // Upgrade the template drafts to genuinely AI-written messages when a
    // Claude key is configured. One call for all risks; on any failure we
    // keep the deterministic template so the feature never breaks.
    const claude = anthropic();
    let aiDrafted = false;
    if (claude && risks.length) {
      try {
        const message = await claude.messages.create({
          model: TEXT_MODEL,
          max_tokens: 1024,
          system:
            "You are a courteous customer-relations rep for an elastic (narrow-fabric) " +
            "manufacturer. For each order, write a short, warm, professional WhatsApp message " +
            "telling the customer their order will be slightly delayed. 2-3 sentences, plain " +
            "text, no emojis, no placeholders/brackets. Use the EXACT dates provided, apologise " +
            "briefly, and reassure them it's being prioritised.",
          messages: [{
            role: "user",
            content:
              'Return ONLY JSON: {"messages":[{"orderNo":<number>,"message":"..."}]}\n\nOrders:\n' +
              risks.map((r) =>
                `- Order #${r.orderNo}, customer ${r.customer.name}, promised ${_fmtDate(r.promised)}, ` +
                `now expected ${_fmtDate(r.expectedDate)} (${r.lateWorkingDays} working days late).`
              ).join("\n"),
          }],
        });
        const text = (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
        const m = text.match(/\{[\s\S]*\}/);
        const parsed = m ? JSON.parse(m[0]) : null;
        if (parsed && Array.isArray(parsed.messages)) {
          const byNo = new Map(parsed.messages.map((x) => [String(x.orderNo), x.message]));
          for (const r of risks) {
            const msg = byNo.get(String(r.orderNo));
            if (msg && typeof msg === "string" && msg.trim()) { r.draft = msg.trim(); r.aiDrafted = true; }
          }
          aiDrafted = true;
        }
      } catch (err) {
        console.warn("[eta-risks] AI draft failed, using templates:", err?.message);
      }
    }

    return res.json({ success: true, count: risks.length, generatedAt: now, aiDrafted, risks });
  }),
);

// ══════════════════════════════════════════════════════════════
//  ORDER STATUS REPORT
//
//  GET /:id/status-report      — the computed report as JSON
//  GET /:id/status-report.pdf  — the same report as a printed sheet
//
//  Both are fed by services/orderStatusReport.js, so the screen and the
//  paper can never tell different stories.
// ══════════════════════════════════════════════════════════════
// POST /order/bulk/status-report.pdf  { ids }  — the selection's status
// reports as one PDF, an order after another.
router.post(
  '/bulk/status-report.pdf',
  catchAsyncErrors(async (req, res, next) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
    if (ids.length === 0) return next(new ErrorHandler('Select at least one order', 400));
    if (ids.length > 50) return next(new ErrorHandler('At most 50 orders at a time', 400));
    if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) return next(new ErrorHandler('Invalid order id', 400));
    const branding = await getPdfBranding();
    const pdfs = [];
    for (const id of ids) {
      const data = await buildOrderStatusReport(id);
      if (!data) continue;
      data.branding = branding;
      pdfs.push(await renderPdf('orderStatus', data));
    }
    if (!pdfs.length) return next(new ErrorHandler('None of those orders were found', 404));
    const { mergePdfs } = require('../utils/mergePdfs');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="order-status-${pdfs.length}.pdf"`);
    res.send(await mergePdfs(pdfs));
  })
);

router.get(
  '/:id/status-report',
  catchAsyncErrors(async (req, res, next) => {
    const data = await buildOrderStatusReport(req.params.id);
    if (!data) return next(new ErrorHandler('Order not found', 404));
    res.json({ success: true, data });
  })
);

router.get(
  '/:id/status-report.pdf',
  catchAsyncErrors(async (req, res, next) => {
    const data = await buildOrderStatusReport(req.params.id);
    if (!data) return next(new ErrorHandler('Order not found', 404));

    data.branding = await getPdfBranding();
    const pdf = await renderPdf('orderStatus', data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="order-status-${data.orderNo ?? req.params.id}.pdf"`
    );
    res.send(pdf);
  })
);

module.exports = router;
