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
// ══════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { resolveRange } = require("../services/reports/range.js");
const { toCsv } = require("../services/reports/csv.js");
const { productionReport } = require("../services/reports/productionReport.js");

const asBool = (v) => v === true || v === "true" || v === "1";

// Shared handler: resolve the window, run the report builder, and
// either return JSON or stream a CSV of its rows.
function reportRoute(build, { csvName }) {
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

    if ((req.query.format || "").toLowerCase() === "csv") {
      const csv = toCsv(report.columns, report.rows);
      const stamp = `${range.from.toISOString().slice(0, 10)}_${new Date(range.to.getTime() - 1).toISOString().slice(0, 10)}`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${csvName}_${stamp}.csv"`);
      return res.send(csv);
    }

    return res.json({ success: true, report: { ...report, rangeLabel: range.label, preset: range.preset } });
  });
}

router.get("/production", reportRoute(productionReport, { csvName: "production-report" }));

module.exports = router;
