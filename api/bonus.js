"use strict";

// routes/bonus.js
//
// Yearly bonus management.
//
// Routes:
//   GET    /bonus/config              → get / auto-create config for current year
//   PUT    /bonus/config              → update bonusDate, bonusLabel, yearlyWorkingDays
//   POST   /bonus/trigger             → compute & create BonusRecords for all employees
//   GET    /bonus/records?year=       → list BonusRecords (populated with employee name)
//   PUT    /bonus/records/:id/pay     → mark one record as paid
//   DELETE /bonus/year/:year/reset    → delete all records + reset config to pending
//
// Attendance tiers:
//   S ≥ 90% → ×1.00   A ≥ 75% → ×0.75   B ≥ 60% → ×0.50   C < 60% → ×0.25

const express        = require("express");
const router         = express.Router();
const mongoose       = require("mongoose");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler     = require("../utils/ErrorHandler");
const BonusConfig      = require("../models/BonusConfig");
const BonusRecord      = require("../models/BonusRecord");
const Employee         = require("../models/Employee");
const ShiftDetail      = require("../models/ShiftDetail");

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

function currentYear() {
  return new Date().getFullYear();
}

function attendanceTier(rate) {
  if (rate >= 90) return { tier: "S", multiplier: 1.00 };
  if (rate >= 75) return { tier: "A", multiplier: 0.75 };
  if (rate >= 60) return { tier: "B", multiplier: 0.50 };
  return           { tier: "C", multiplier: 0.25 };
}

// Shift hours: DAY = 12h, NIGHT = 8h
function shiftHours(shiftType) {
  return shiftType === "DAY" ? 12 : 8;
}

// Ensure a BonusConfig exists for the given year; return it.
async function getOrCreateConfig(year) {
  let cfg = await BonusConfig.findOne({ year });
  if (!cfg) cfg = await BonusConfig.create({ year });
  return cfg;
}

// ─────────────────────────────────────────────────────────────
//  1.  GET CONFIG  —  GET /bonus/config?year=
// ─────────────────────────────────────────────────────────────
router.get(
  "/config",
  catchAsyncErrors(async (req, res) => {
    const year = parseInt(req.query.year) || currentYear();
    const config = await getOrCreateConfig(year);

    // Summary stats
    const totalRecords  = await BonusRecord.countDocuments({ year });
    const paidRecords   = await BonusRecord.countDocuments({ year, status: "paid" });
    const totalPayout   = await BonusRecord.aggregate([
      { $match: { year } },
      { $group: { _id: null, total: { $sum: "$bonusAmount" } } },
    ]);

    res.status(200).json({
      success: true,
      config,
      stats: {
        totalRecords,
        paidRecords,
        pendingRecords: totalRecords - paidRecords,
        totalPayout: totalPayout[0]?.total ?? 0,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  2.  UPDATE CONFIG  —  PUT /bonus/config
// ─────────────────────────────────────────────────────────────
router.put(
  "/config",
  catchAsyncErrors(async (req, res, next) => {
    const year = parseInt(req.body.year) || currentYear();
    const cfg  = await getOrCreateConfig(year);

    if (cfg.status === "triggered") {
      // Allow date/label updates even after trigger, but not workingDays
      // (changing workingDays after trigger would invalidate existing records)
      if (req.body.yearlyWorkingDays !== undefined) {
        return next(new ErrorHandler(
          "Cannot change yearlyWorkingDays after bonus has been triggered. Reset first.", 400
        ));
      }
    }

    const { bonusDate, bonusLabel, yearlyWorkingDays } = req.body;
    if (bonusDate    !== undefined) cfg.bonusDate         = bonusDate ? new Date(bonusDate) : null;
    if (bonusLabel   !== undefined) cfg.bonusLabel        = bonusLabel;
    if (yearlyWorkingDays !== undefined) {
      const wd = parseInt(yearlyWorkingDays);
      if (isNaN(wd) || wd < 1) return next(new ErrorHandler("yearlyWorkingDays must be ≥ 1", 400));
      cfg.yearlyWorkingDays = wd;
    }

    await cfg.save();
    res.status(200).json({ success: true, config: cfg });
  })
);

// ─────────────────────────────────────────────────────────────
//  3.  TRIGGER BONUS  —  POST /bonus/trigger
//
//  Computes BonusRecords for ALL employees.
//  Idempotent: deletes existing 'pending' records first, then
//  re-creates fresh ones.  Already 'paid' records are preserved.
// ─────────────────────────────────────────────────────────────
router.post(
  "/trigger",
  catchAsyncErrors(async (req, res, next) => {
    const year = parseInt(req.body.year) || currentYear();
    const cfg  = await getOrCreateConfig(year);

    if (cfg.status === "completed") {
      return next(new ErrorHandler(
        "Bonus for this year is already completed. Reset to re-trigger.", 400
      ));
    }

    // Delete only pending records (keep paid ones intact)
    await BonusRecord.deleteMany({ year, status: "pending" });

    // Date range for attendance: Jan 1 → Dec 31 of the year
    const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
    const yearEnd   = new Date(`${year}-12-31T23:59:59.999Z`);

    const employees = await Employee.find().select("name department hourlyRate bonusPercent");

    if (employees.length === 0) {
      return next(new ErrorHandler("No employees found", 404));
    }

    const records = [];

    for (const emp of employees) {
      // All shifts for this employee in the year
      const shifts = await ShiftDetail.find({
        employee: emp._id,
        date: { $gte: yearStart, $lte: yearEnd },
      }).select("shift date");

      // Unique shift-days (a DAY + NIGHT on the same date = 2 attendance entries
      // but we count calendar days present, so deduplicate by date string)
      const uniqueDates = new Set(
        shifts.map((s) => {
          const d = new Date(s.date);
          return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        })
      );
      const attendanceDays = uniqueDates.size;

      // Total hours worked
      const hoursWorked = shifts.reduce((sum, s) => sum + shiftHours(s.shift), 0);

      // Annual earnings
      const hourlyRate      = emp.hourlyRate || 0;
      const annualEarnings  = hourlyRate * hoursWorked;

      // Raw bonus (pre-attendance)
      const bonusPercent   = emp.bonusPercent ?? 10;
      const rawBonusAmount = annualEarnings * (bonusPercent / 100);

      // Attendance rate + tier
      const totalWorkingDays = cfg.yearlyWorkingDays;
      const attendanceRate   = Math.min(100,
        totalWorkingDays > 0 ? (attendanceDays / totalWorkingDays) * 100 : 0
      );
      const { tier, multiplier } = attendanceTier(attendanceRate);

      // Final bonus
      const bonusAmount = Math.round(rawBonusAmount * multiplier);

      records.push({
        employee:        emp._id,
        year,
        hourlyRate,
        hoursWorked,
        annualEarnings,
        bonusPercent,
        rawBonusAmount,
        attendanceDays,
        totalWorkingDays,
        attendanceRate:  parseFloat(attendanceRate.toFixed(1)),
        attendanceTier:  tier,
        multiplier,
        bonusAmount,
        status: "pending",
      });
    }

    // Bulk insert  (upsert to handle race conditions or re-trigger after partial pay)
    const ops = records.map((r) => ({
      updateOne: {
        filter: { employee: r.employee, year: r.year, status: "pending" },
        update:  { $set: r },
        upsert:  true,
      },
    }));
    await BonusRecord.bulkWrite(ops);

    // Update config status
    cfg.status      = "triggered";
    cfg.triggeredAt = new Date();
    await cfg.save();

    const created = await BonusRecord.find({ year })
      .populate("employee", "name department")
      .sort({ bonusAmount: -1 });

    const totalPayout = created.reduce((s, r) => s + r.bonusAmount, 0);

    console.log(`[bonus/trigger] ${year}: ${created.length} records | ₹${totalPayout} total`);

    res.status(200).json({
      success: true,
      recordCount: created.length,
      totalPayout,
      records: created,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  4.  LIST RECORDS  —  GET /bonus/records?year=
// ─────────────────────────────────────────────────────────────
router.get(
  "/records",
  catchAsyncErrors(async (req, res) => {
    const year    = parseInt(req.query.year) || currentYear();
    const status  = req.query.status || "all"; // 'all' | 'pending' | 'paid'

    const filter = { year };
    if (status !== "all") filter.status = status;

    const records = await BonusRecord.find(filter)
      .populate("employee", "name department role hourlyRate")
      .sort({ bonusAmount: -1 });

    const totalPayout   = records.reduce((s, r) => s + r.bonusAmount, 0);
    const paidPayout    = records.filter((r) => r.status === "paid")
                                 .reduce((s, r) => s + r.bonusAmount, 0);

    res.status(200).json({
      success: true,
      records,
      summary: {
        total: records.length,
        paid:    records.filter((r) => r.status === "paid").length,
        pending: records.filter((r) => r.status === "pending").length,
        totalPayout,
        paidPayout,
        pendingPayout: totalPayout - paidPayout,
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  5.  MARK PAID  —  PUT /bonus/records/:id/pay
// ─────────────────────────────────────────────────────────────
router.put(
  "/records/:id/pay",
  catchAsyncErrors(async (req, res, next) => {
    const record = await BonusRecord.findById(req.params.id);
    if (!record) return next(new ErrorHandler("Bonus record not found", 404));
    if (record.status === "paid") {
      return next(new ErrorHandler("Already marked as paid", 400));
    }

    record.status = "paid";
    record.paidAt = new Date();
    await record.save();

    // Check if ALL records for the year are paid → auto-complete config
    const pendingCount = await BonusRecord.countDocuments({ year: record.year, status: "pending" });
    if (pendingCount === 0) {
      await BonusConfig.updateOne({ year: record.year }, { status: "completed" });
    }

    res.status(200).json({ success: true, record });
  })
);

// ─────────────────────────────────────────────────────────────
//  6.  RESET  —  DELETE /bonus/year/:year/reset
//
//  Deletes ALL pending records and resets config to 'pending'.
//  Paid records are preserved (audit trail).
// ─────────────────────────────────────────────────────────────
router.delete(
  "/year/:year/reset",
  catchAsyncErrors(async (req, res, next) => {
    const year = parseInt(req.params.year);
    if (isNaN(year)) return next(new ErrorHandler("Invalid year", 400));

    const deleted = await BonusRecord.deleteMany({ year, status: "pending" });

    const cfg = await BonusConfig.findOne({ year });
    if (cfg) {
      cfg.status      = "pending";
      cfg.triggeredAt = null;
      await cfg.save();
    }

    console.log(`[bonus/reset] ${year}: deleted ${deleted.deletedCount} pending records`);

    res.status(200).json({
      success: true,
      deletedCount: deleted.deletedCount,
      message: `Reset ${year} bonus. Paid records are preserved.`,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  7.  UPDATE EMPLOYEE BONUS %  —  PUT /bonus/employee/:id/percent
// ─────────────────────────────────────────────────────────────
router.put(
  "/employee/:id/percent",
  catchAsyncErrors(async (req, res, next) => {
    const emp = await Employee.findById(req.params.id);
    if (!emp) return next(new ErrorHandler("Employee not found", 404));

    const pct = parseFloat(req.body.bonusPercent);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      return next(new ErrorHandler("bonusPercent must be 0–100", 400));
    }

    emp.bonusPercent = pct;
    await emp.save();

    res.status(200).json({ success: true, employee: { _id: emp._id, name: emp.name, bonusPercent: emp.bonusPercent } });
  })
);

module.exports = router;