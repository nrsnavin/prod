"use strict";
// ══════════════════════════════════════════════════════════════
//  REPORTS ROUTES
//  File: api/reports.js
//  Mount: app.use('/api/v2/reports', gate(...), require('./api/reports'));
//
//  Read-only management reports. Each report takes a date window
//  (from/to or preset), an optional group-by, and an optional
//  period-over-period comparison, and returns { summary, rows,
//  series, comparison }. Append ?format=csv to download the rows.
//
//  Endpoints:
//    GET /production   — meters produced (group: machine|shift|elastic|operator|day)
//    GET /dispatch     — DC dispatches + value (group: customer|elastic|day)
//    GET /order-book   — order intake + pending + OTD (group: customer|status|supplyMonth)
//    GET /stock-purchases — RM stock valuation + PO purchases (group: material|category|supplier)
// ══════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { resolveRange } = require("../services/reports/range.js");
const { toCsv } = require("../services/reports/csv.js");
const { renderReportPdf } = require("../services/reports/reportPdf.js");
const { getPdfBranding } = require("../services/documentSettings.js");
const { productionReport } = require("../services/reports/productionReport.js");
const { dispatchReport } = require("../services/reports/dispatchReport.js");
const { orderBookReport } = require("../services/reports/orderBookReport.js");
const { stockPurchasesReport } = require("../services/reports/stockPurchasesReport.js");
const { stockMovementsReport } = require("../services/reports/stockMovementsReport.js");

const asBool = (v) => v === true || v === "true" || v === "1";
const n = (x) => (Number(x) || 0).toLocaleString("en-IN");
const inr = (x) => "₹" + Math.round(Number(x) || 0).toLocaleString("en-IN");

// Shared handler: resolve the window, run the report builder, and
// return JSON, a CSV of the rows, or a formatted PDF (format= query).
function reportRoute(build, { csvName, title, summaryLine }) {
  return catchAsyncErrors(async (req, res) => {
    let range;
    try {
      range = resolveRange(req.query);
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }

    const report = await build({
      from: range.from,
      to: range.to,
      groupBy: req.query.groupBy,
      compare: asBool(req.query.compare),
    });

    const format = (req.query.format || "").toLowerCase();
    const stamp = `${range.from.toISOString().slice(0, 10)}_${new Date(range.to.getTime() - 1).toISOString().slice(0, 10)}`;

    if (format === "csv") {
      const csv = toCsv(report.columns, report.rows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${csvName}_${stamp}.csv"`);
      return res.send(csv);
    }

    if (format === "pdf") {
      const branding = await getPdfBranding();
      const pdf = await renderReportPdf({
        title,
        rangeLabel: range.label,
        summaryLine: summaryLine ? summaryLine(report.summary) : undefined,
        company: branding.company,
        accent: branding.accent,
        columns: report.columns,
        rows: report.rows,
      });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${csvName}_${stamp}.pdf"`);
      return res.send(pdf);
    }

    return res.json({ success: true, report: { ...report, rangeLabel: range.label, preset: range.preset } });
  });
}

router.get("/production", reportRoute(productionReport, {
  csvName: "production-report", title: "Production Report",
  summaryLine: (s) => `${n(s.meters)} m produced · ${n(s.shifts)} shifts · avg ${n(s.avgPerShift)}/shift · wastage ${n(s.wastageMeters)} m (${s.wastagePct}%)`,
}));
router.get("/dispatch", reportRoute(dispatchReport, {
  csvName: "dispatch-sales-report", title: "Dispatch & Customer Sales",
  summaryLine: (s) => `${inr(s.amount)} dispatched · ${n(s.dcs)} DCs · ${n(s.quantity)} units · ${n(s.customers)} customers · avg rate ${inr(s.avgRate)}`,
}));
router.get("/order-book", reportRoute(orderBookReport, {
  csvName: "order-book-report", title: "Order Book & Fulfillment",
  summaryLine: (s) => `${n(s.orders)} orders · ${n(s.orderedQty)} m ordered · ${n(s.pendingQty)} m pending · ${n(s.overdueOrders)} overdue · OTD ${s.onTimePct == null ? "—" : s.onTimePct + "%"}`,
}));
router.get("/stock-purchases", reportRoute(stockPurchasesReport, {
  csvName: "stock-purchases-report", title: "Stock & Purchases",
  summaryLine: (s) => `Stock ${inr(s.stockValue)} · ${n(s.lowStock)} low · purchases ${inr(s.purchaseValue)} · pending ${inr(s.pendingValue)} across ${n(s.pos)} POs`,
}));
router.get("/stock-movements", reportRoute(stockMovementsReport, {
  csvName: "stock-movements-report", title: "Stock Movement Ledger",
  summaryLine: (s) => `In ${n(s.inQty)} kg · Out ${n(s.outQty)} kg · Net ${s.net >= 0 ? "+" : ""}${n(s.net)} kg`,
}));

module.exports = router;
