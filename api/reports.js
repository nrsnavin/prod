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

// ══════════════════════════════════════════════════════════════
//  EVERY REPORT, ONE ENGINE  (services/reportEngine)
//    GET    /catalog         datasets (with fields) and ready-made reports
//                            this person may read, and saved queries
//    GET    /run?payload=    (or POST /run) { report | query | sql, preset | from,to,
//                              filters[], format: json|xlsx|pdf|csv }
//    GET    /saved           saved queries (mine and shared)
//    POST   /saved           { name, query | sql, preset, shared }
//    DELETE /saved/:id       the person who saved it, or an admin
// ══════════════════════════════════════════════════════════════
const mongoose = require("mongoose");
const ErrorHandler = require("../utils/ErrorHandler");
const engine = {
  datasets: require("../services/reportEngine/datasets.js"),
  query: require("../services/reportEngine/query.js"),
  sql: require("../services/reportEngine/sql.js"),
  catalog: require("../services/reportEngine/catalog.js"),
  out: require("../services/reportEngine/export.js"),
  range: require("../services/reportEngine/range.js"),
};
const SavedReport = require("../models/SavedReport.js");

const roleOf = (req) => (req.user?.role === "admin" ? "admin" : req.user?.role);
const canRead = (role, datasetId) => !!engine.datasets.DATASETS[datasetId]?.access.includes(role);
const OP_WORDS = { "=": "is", "!=": "is not", "<": "under", "<=": "at most", ">": "over", ">=": "at least", contains: "contains", "not contains": "does not contain", starts: "starts with", in: "is one of", "not in": "is not one of", between: "between", empty: "is empty", "not empty": "is not empty" };

function filterLine(datasetId, where) {
  const ds = engine.datasets.DATASETS[datasetId];
  return (where || []).filter((c) => c.field !== "date").map((c) => {
    const key = Object.keys(ds.fields).find((k) => k.toLowerCase() === String(c.field).toLowerCase().replace(/_/g, "")) || c.field;
    const label = ds.fields[key]?.label || c.field;
    const v = Array.isArray(c.value) ? c.value.join(c.op === "between" ? " and " : ", ") : c.value;
    return `${label} ${OP_WORDS[c.op] || c.op}${v == null || v === "" ? "" : ` ${v}`}`;
  }).join(" · ");
}

router.get("/catalog", catchAsyncErrors(async (req, res) => {
  const role = roleOf(req);
  const datasets = engine.datasets.describe(role);
  const reports = engine.catalog.REPORTS.filter((r) => canRead(role, r.query.dataset)).map((r) => ({ ...r, dated: engine.datasets.DATASETS[r.query.dataset].dated }));
  const saved = await SavedReport.find({ $or: [{ createdBy: req.user?._id }, { shared: true }] }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ success: true, datasets, reports, saved: saved.filter((s) => !s.query?.dataset || canRead(role, s.query.dataset)), presets: engine.range.PRESETS });
}));

// Running a report only reads, so it is a GET (?payload=<json>) for anyone
// who may read reports; POST takes the same body for long queries.
const runReport = catchAsyncErrors(async (req, res, next) => {
  let b = req.body || {};
  if (req.method === "GET") {
    try { b = JSON.parse(String(req.query.payload || "{}")); } catch { return next(new ErrorHandler("payload must be JSON", 400)); }
    if (!b || typeof b !== "object") return next(new ErrorHandler("payload must be JSON", 400));
  }
  const role = roleOf(req);
  let query; let title;
  if (b.report) {
    const r = engine.catalog.find(String(b.report));
    if (!r) return next(new ErrorHandler("No such report", 404));
    query = JSON.parse(JSON.stringify(r.query)); title = r.title;
  } else if (typeof b.sql === "string" && b.sql.trim()) {
    if (b.sql.length > 4000) return next(new ErrorHandler("The query is too long", 400));
    query = engine.sql.parse(b.sql); title = b.title || "Query";
  } else if (b.query && typeof b.query === "object") {
    query = b.query; title = b.title || "Query";
  } else return next(new ErrorHandler("Pick a report, build a query or type one", 400));
  if (Array.isArray(b.filters) && b.filters.length) query.where = [...(query.where || []), ...b.filters.slice(0, 20)];

  const range = engine.range.resolve({ preset: b.preset, from: b.from, to: b.to });
  const format = String(b.format || "json").toLowerCase();
  if (!["json", "xlsx", "pdf", "csv"].includes(format)) return next(new ErrorHandler("format must be json, xlsx, pdf or csv", 400));
  const result = await engine.query.run(query, { role, from: range.from, to: range.to, maxRows: format === "json" ? 5000 : format === "pdf" ? 5000 : 100000 });
  const dated = engine.datasets.DATASETS[result.dataset].dated;
  const dateCond = (query.where || []).some((c) => String(c.field).toLowerCase() === "date");
  const rangeLabel = !dated ? `As on ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}`
    : dateCond && result.window ? `${new Date(result.window.from).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })} – ${new Date(new Date(result.window.to).getTime() - 1).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}`
      : range.label;
  const meta = { title, rangeLabel, filterLine: filterLine(result.dataset, query.where) };

  if (format === "json") return res.json({ success: true, title, ...meta, query, result });
  const branding = await getPdfBranding();
  const fileBase = `${String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report"}_${dated ? `${range.fromDay}_${range.toDay}` : engine.range.istToday()}`;
  const full = { ...meta, company: branding.company, accent: branding.accent };
  if (format === "xlsx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.xlsx"`);
    return res.send(await engine.out.toXlsx(result, full));
  }
  if (format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.pdf"`);
    return res.send(await engine.out.toPdf(result, full));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileBase}.csv"`);
  return res.send(engine.out.toCsv(result));
});
router.get("/run", runReport);
router.post("/run", runReport);

router.get("/saved", catchAsyncErrors(async (req, res) => {
  const saved = await SavedReport.find({ $or: [{ createdBy: req.user?._id }, { shared: true }] }).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ success: true, saved });
}));

router.post("/saved", catchAsyncErrors(async (req, res, next) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return next(new ErrorHandler("Give the report a name", 400));
  let query = null;
  if (typeof b.sql === "string" && b.sql.trim()) query = engine.sql.parse(b.sql);
  else if (b.query && typeof b.query === "object") query = b.query;
  else return next(new ErrorHandler("Nothing to save — build or type a query first", 400));
  // Checked now, so a saved report always runs.
  engine.query.normalise(query, roleOf(req));
  const doc = await SavedReport.create({ name: name.slice(0, 80), query, sql: typeof b.sql === "string" ? b.sql.slice(0, 4000) : "", preset: engine.range.PRESETS.includes(b.preset) ? b.preset : "month", shared: !!b.shared, createdBy: req.user?._id, createdByName: req.user?.name || "" });
  res.status(201).json({ success: true, saved: doc });
}));

router.delete("/saved/:id", catchAsyncErrors(async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return next(new ErrorHandler("Not found", 404));
  const doc = await SavedReport.findById(req.params.id).lean();
  if (!doc) return next(new ErrorHandler("Not found", 404));
  if (String(doc.createdBy) !== String(req.user?._id) && req.user?.role !== "admin") return next(new ErrorHandler("Only the person who saved it, or an admin, can remove it", 403));
  await SavedReport.deleteOne({ _id: doc._id });
  res.json({ success: true });
}));

module.exports = router;
