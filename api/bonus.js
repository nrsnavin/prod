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
const PDFDocument      = require("pdfkit");

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
//  4b. ONE EMPLOYEE'S BONUS  —  GET /bonus/employee/:id?year=
//
//  Used by the Worker Portal so a worker only sees THEIR record,
//  not coworkers' salaries. Returns the BonusRecord + the
//  matching BonusConfig metadata (bonusLabel, bonusDate, status).
// ─────────────────────────────────────────────────────────────
router.get(
  "/employee/:id",
  catchAsyncErrors(async (req, res, next) => {
    const year = parseInt(req.query.year) || currentYear();
    const { id } = req.params;

    const [record, config] = await Promise.all([
      BonusRecord.findOne({ employee: id, year })
        .populate("employee", "name department role hourlyRate"),
      BonusConfig.findOne({ year }),
    ]);

    res.status(200).json({
      success: true,
      year,
      record: record || null,
      config: config || null,
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  4c. BONUS CERTIFICATE PDF  —  GET /bonus/employee/:id/pdf?year=
//
//  Streams a one-page A4 PDF certificate of the worker's yearly
//  bonus. The Flutter app downloads the bytes and shares/saves
//  via share_plus. 404 if no record exists for that year.
// ─────────────────────────────────────────────────────────────
router.get(
  "/employee/:id/pdf",
  catchAsyncErrors(async (req, res, next) => {
    const year = parseInt(req.query.year) || currentYear();
    const { id } = req.params;

    const [record, config] = await Promise.all([
      BonusRecord.findOne({ employee: id, year })
        .populate("employee", "name department role hourlyRate"),
      BonusConfig.findOne({ year }),
    ]);

    if (!record) {
      return next(new ErrorHandler(
        `No bonus record for employee ${id} in ${year}`, 404
      ));
    }

    const fileName = `bonus-${record.employee?.name?.replace(/\s+/g, "_") || "employee"}-${year}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    doc.pipe(res);

    // ── Header ───────────────────────────────────────────────
    doc.fillColor("#0D1B2A").rect(0, 0, doc.page.width, 110).fill();
    doc.fillColor("#FFFFFF")
       .font("Helvetica-Bold").fontSize(22)
       .text("Yearly Bonus Certificate", 50, 38);
    doc.font("Helvetica").fontSize(11).fillColor("#A8C0E0")
       .text(config?.bonusLabel || `Annual Bonus ${year}`, 50, 70);
    if (config?.bonusDate) {
      doc.text(
        `Payout date: ${new Date(config.bonusDate).toLocaleDateString("en-IN", { day:"2-digit", month:"long", year:"numeric" })}`,
        50, 86
      );
    }

    // ── Employee block ───────────────────────────────────────
    doc.moveDown(3);
    doc.fillColor("#1B2B45").font("Helvetica-Bold").fontSize(13)
       .text("EMPLOYEE", 50, 140);
    doc.font("Helvetica").fontSize(12).fillColor("#0D1B2A")
       .text(`Name        : ${record.employee?.name || "—"}`, 50, 160)
       .text(`Department  : ${record.employee?.department || "—"}`)
       .text(`Role        : ${record.employee?.role || "—"}`)
       .text(`Year        : ${year}`);

    // ── Bonus block ──────────────────────────────────────────
    doc.moveDown(1.5);
    doc.fillColor("#1B2B45").font("Helvetica-Bold").fontSize(13).text("BONUS DETAILS");
    doc.moveDown(0.5);
    const tableY = doc.y;
    const rows = [
      ["Hourly Rate",          `Rs. ${record.hourlyRate?.toFixed(2) || "0.00"}`],
      ["Hours Worked",         `${record.hoursWorked || 0} hrs`],
      ["Annual Earnings",      `Rs. ${record.annualEarnings?.toFixed(2) || "0.00"}`],
      ["Bonus Percent",        `${record.bonusPercent || 0}%`],
      ["Raw Bonus",            `Rs. ${record.rawBonusAmount?.toFixed(2) || "0.00"}`],
      ["Attendance Days",      `${record.attendanceDays || 0} / ${record.totalWorkingDays || 0}`],
      ["Attendance Rate",      `${record.attendanceRate?.toFixed(1) || 0}%`],
      ["Attendance Tier",      `${record.attendanceTier || "C"} (x${record.multiplier || 0})`],
    ];
    doc.font("Helvetica").fontSize(11).fillColor("#0D1B2A");
    rows.forEach((r, i) => {
      const y = tableY + (i * 18);
      doc.text(r[0], 60, y, { width: 200 });
      doc.text(r[1], 280, y, { width: 250 });
    });

    // ── Final amount banner ──────────────────────────────────
    const bannerY = tableY + (rows.length * 18) + 20;
    doc.fillColor("#1D6FEB").rect(50, bannerY, doc.page.width - 100, 70).fill();
    doc.fillColor("#FFFFFF").font("Helvetica").fontSize(12)
       .text("FINAL BONUS PAYABLE", 70, bannerY + 12);
    doc.font("Helvetica-Bold").fontSize(28)
       .text(`Rs. ${record.bonusAmount?.toLocaleString("en-IN") || "0"}`, 70, bannerY + 30);

    // ── Status & footer ──────────────────────────────────────
    const statusY = bannerY + 90;
    const statusColor = record.status === "paid" ? "#15803D" : "#D97706";
    doc.fillColor(statusColor).font("Helvetica-Bold").fontSize(12)
       .text(`Status: ${record.status?.toUpperCase() || "PENDING"}`, 50, statusY);
    if (record.status === "paid" && record.paidAt) {
      doc.fillColor("#475569").font("Helvetica").fontSize(10)
         .text(`Paid on ${new Date(record.paidAt).toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })}`,
              50, statusY + 16);
    }

    doc.fillColor("#94A3B8").font("Helvetica").fontSize(9)
       .text(
         "This is a system-generated certificate. For queries contact your supervisor.",
         50, doc.page.height - 70, { width: doc.page.width - 100, align: "center" }
       );

    doc.end();
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