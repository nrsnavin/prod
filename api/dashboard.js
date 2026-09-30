// ══════════════════════════════════════════════════════════════
//  DASHBOARD KPIs
//  File: api/dashboard.js
//  Mount: app.use('/api/v2/dashboard', require('./api/dashboard'));
//
//  Endpoints:
//    GET /kpis  — single roll-up call for the admin home screen
//                 returns: open jobs, pending leaves, today's
//                 attendance breakdown, low-stock count
// ══════════════════════════════════════════════════════════════
"use strict";

const express      = require("express");
const router       = express.Router();

const JobOrder     = require("../models/JobOrder");
const LeaveRequest = require("../models/LeaveRequest");
const Attendance   = require("../models/Attendence.js");
const RawMaterial  = require("../models/RawMaterial");
const Employee     = require("../models/Employee");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { sharedResult } = require("../utils/sharedResult");
const { currentDb } = require("../db/tenants");
const { isAuthenticated, isAdmin } = require("../middleware/auth");

const ACTIVE_JOB_STATUSES = [
  "preparatory", "weaving", "finishing", "checking", "packing",
];

// ─────────────────────────────────────────────────────────────
// GET /kpis
//   Single call so the dashboard doesn't fan out to 4 separate
//   endpoints just to render counters.
// ─────────────────────────────────────────────────────────────
router.get(
  "/kpis",
  isAuthenticated, isAdmin('admin', 'production', 'accounts'),
  catchAsyncErrors(async (req, res) => {
    // Every authorised caller gets the same answer, and the web app asks
    // for it every ten seconds per open dashboard. So concurrent and
    // recent callers share one computation (utils/sharedResult.js),
    // keyed by the request's database so a sandbox session never sees
    // production's numbers or the other way round. Five seconds of
    // staleness on a dashboard tile is invisible; a hundred identical
    // aggregations every ten seconds were not.
    const data = await sharedResult(
      `dashboard:kpis:${currentDb() || "primary"}`,
      KPI_TTL_MS,
      computeKpis
    );
    res.json({ success: true, data });
  })
);

const KPI_TTL_MS = 5_000;

async function computeKpis() {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const endOfToday   = new Date(); endOfToday.setHours(23, 59, 59, 999);

  const [
    openJobs,
    pendingLeaves,
    attendanceGroups,
    lowStock,
    totalEmployees,
  ] = await Promise.all([
    JobOrder.countDocuments({ status: { $in: ACTIVE_JOB_STATUSES } }),
    LeaveRequest.countDocuments({ status: "pending" }),
    Attendance.aggregate([
      { $match: { date: { $gte: startOfToday, $lte: endOfToday } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    // The five lowest materials AND how many there are, in ONE pass.
    // `$expr` comparing two fields of the same document cannot use an
    // index, so this is a collection scan whatever is done — and it
    // used to be two identical ones, a find and a count, side by side.
    RawMaterial.aggregate([
      { $match: { $expr: { $lte: ["$stock", "$minStock"] } } },
      {
        $facet: {
          items: [
            { $sort: { stock: 1 } },
            { $limit: 5 },
            { $project: { name: 1, category: 1, stock: 1, minStock: 1 } },
          ],
          total: [{ $count: "n" }],
        },
      },
    ]),
    Employee.countDocuments({}),
  ]);

  const breakdown = {
    present: 0, late: 0, half_day: 0, absent: 0, on_leave: 0,
  };
  let totalMarked = 0;
  for (const r of attendanceGroups) {
    if (breakdown[r._id] !== undefined) breakdown[r._id] = r.count;
    totalMarked += r.count;
  }

  const effectivePresent =
    breakdown.present + breakdown.late + breakdown.half_day * 0.5;
  const attendancePct = totalMarked > 0
    ? Math.round((effectivePresent / totalMarked) * 100)
    : 0;

  const lowStockMaterials = lowStock[0]?.items ?? [];
  const lowStockCount = lowStock[0]?.total[0]?.n ?? 0;

  return {
    openJobs,
    pendingLeaves,
    lowStock: {
      count: lowStockCount,
      items: lowStockMaterials.map((m) => ({
        id:       m._id,
        name:     m.name,
        category: m.category,
        stock:    m.stock,
        minStock: m.minStock,
      })),
    },
    attendanceToday: {
      totalMarked,
      totalEmployees,
      unmarked: Math.max(0, totalEmployees - totalMarked),
      attendancePct,
      breakdown,
    },
  };
}

module.exports = router;
