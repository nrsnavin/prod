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
  catchAsyncErrors(async (req, res) => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const endOfToday   = new Date(); endOfToday.setHours(23, 59, 59, 999);

    const [
      openJobs,
      pendingLeaves,
      attendanceGroups,
      lowStockMaterials,
      lowStockCount,
      totalEmployees,
    ] = await Promise.all([
      JobOrder.countDocuments({ status: { $in: ACTIVE_JOB_STATUSES } }),
      LeaveRequest.countDocuments({ status: "pending" }),
      Attendance.aggregate([
        { $match: { date: { $gte: startOfToday, $lte: endOfToday } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      // Surface the top 5 lowest-stock materials so the UI can show
      // them without a second round-trip when the admin taps the card.
      RawMaterial.find({ $expr: { $lte: ["$stock", "$minStock"] } })
        .select("name category stock minStock")
        .sort({ stock: 1 })
        .limit(5)
        .lean(),
      RawMaterial.countDocuments({ $expr: { $lte: ["$stock", "$minStock"] } }),
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

    res.json({
      success: true,
      data: {
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
      },
    });
  })
);

module.exports = router;
