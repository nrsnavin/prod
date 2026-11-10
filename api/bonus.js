"use strict";

// routes/bonus.js
//
// Yearly bonus management.
//
// Routes (AUTH = login required; ADMIN = role 'admin'):
//   GET    /bonus/config              → ADMIN — get / auto-create config
//   PUT    /bonus/config              → ADMIN — update fields
//   POST   /bonus/trigger             → ADMIN — compute bonuses
//   GET    /bonus/records?year=       → ADMIN — list all records
//   GET    /bonus/employee/:id        → AUTH  — worker views own record
//   GET    /bonus/employee/:id/pdf    → AUTH  — worker downloads certificate
//   PUT    /bonus/records/:id/pay     → ADMIN — mark paid
//   DELETE /bonus/year/:year/reset    → ADMIN — reset year
//   PUT    /bonus/employee/:id/percent→ ADMIN — update employee percent
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
const { employedFrom } = require("../utils/employeeStatus");
const { factoryMonth, yearOf } = require("../utils/periods");
const ShiftDetail      = require("../models/ShiftDetail");
const Attendance       = require("../models/Attendence.js");
const Payroll          = require("../models/Payroll");
const { writeBonusCertificate, bonusFileName } = require("../services/bonusPdf");
const ledger           = require("../services/ledgerService");
const LedgerEntry      = require("../models/LedgerEntry");
const { isAuthenticated, isAdmin, selfOrAdmin } = require("../middleware/auth");
const { EMPLOYEE_CARD_FIELDS } = require("../utils/populateFields");

router.use(isAuthenticated);

// GET /employee/:id, /employee/:id/prediction and /employee/:id/pdf are
// selfOrAdmin — a worker's own bonus record is answerable to their
// identity, not to whether the admin ticked their Bonus checkbox, so
// those reads are exempt from the feature gate below. PUT
// /employee/:id/percent is a write (admin-only) and is NOT exempt.
//
// Whose bonus it is matters (middleware/ownRecords.js): one's own passes
// on identity; someone else's needs Bonus — or Payroll or Employees,
// whose screens show a person's bonus beside their pay and record.
router.use(require("../middleware/ownRecords").ownRecordsOr({
  features: ['/bonus'],
  ownPrefixes: ['/employee/'],
  alsoRead: ['/payroll', '/employees'],
}));

// "This year" and "this month" are the factory's, and a year that is
// not one is refused (utils/periods.js).
const factoryNow = factoryMonth;
const currentYear = () => factoryMonth().year;
const NOT_A_YEAR = "year is not a valid year";

function attendanceTier(rate) {
  if (rate >= 90) return { tier: "S", multiplier: 1.00 };
  if (rate >= 75) return { tier: "A", multiplier: 0.75 };
  if (rate >= 60) return { tier: "B", multiplier: 0.50 };
  return           { tier: "C", multiplier: 0.25 };
}

function shiftHours(shiftType) {
  // Both DAY and NIGHT shifts are 12-hour shifts.
  return 12;
}

// The year's settings, made if there are none — for the routes that
// change them. One write, so two requests for a year nobody has opened
// yet (the Bonus page asks for its settings and its preview together)
// do not both try to create it: one of them used to fail on the
// duplicate year.
async function getOrCreateConfig(year) {
  try {
    return await BonusConfig.findOneAndUpdate(
      { year }, { $setOnInsert: { year } }, { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return BonusConfig.findOne({ year }); // made by the other request
  }
}

// The year's settings for a READ: as stored, or the defaults, unsaved.
// Looking at a year is not a reason to write one — every read used to
// create the year it was asked about, a worker's own bonus page included.
async function configFor(year) {
  return (await BonusConfig.findOne({ year })) || new BonusConfig({ year });
}

// The Diwali-bonus salary window: the 12 months ENDING with the configured
// Diwali month (BonusConfig.bonusDate) — i.e. last Diwali → this Diwali.
// Falls back to the calendar year when no Diwali date is set.
function diwaliWindow(cfg, year) {
  let endYear = year, endMonth = 12;
  if (cfg?.bonusDate) {
    const d = new Date(cfg.bonusDate);
    endYear = d.getFullYear();
    endMonth = d.getMonth() + 1; // 1–12
  }
  const months = [];
  for (let i = 11; i >= 0; i--) {
    let m = endMonth - i, y = endYear;
    while (m <= 0) { m += 12; y -= 1; }
    months.push({ y, m });
  }
  const start = new Date(months[0].y, months[0].m - 1, 1);
  const end   = new Date(endYear, endMonth, 0, 23, 59, 59, 999);
  return { months, start, end, diwaliMonth: endMonth, diwaliYear: endYear };
}

function isDiwaliMonth(cfg) {
  if (!cfg?.bonusDate) return false;
  const d = new Date(cfg.bonusDate), now = factoryNow();
  return now.year === d.getFullYear() && now.month === d.getMonth() + 1;
}

// Compute one employee's Diwali bonus:
//   bonus = (salary received in the window) × bonusPercent × attendanceMultiplier
// "Salary received" is the sum of payroll net pay across the window months;
// before payroll exists it falls back to an hourlyRate × hours estimate so
// the preview still works.
async function computeEmployeeBonus(emp, cfg, win) {
  const payrolls = await Payroll.find({
    employee: emp._id,
    $or: win.months.map(w => ({ year: w.y, month: w.m })),
  }).select("netPay totalAdvanceDeduction advanceRecoveredAtPayment").lean();
  // What the month paid — with an advance recovered through the payslip
  // put back. An advance is salary handed over early: net pay is that
  // much less in the month it comes back, and summing net pay alone gave
  // a smaller bonus to whoever had taken one. (An advance recovered at
  // payment never reduced net pay, so there is nothing to put back.)
  const salaryReceived = payrolls.reduce((s, p) => s + (p.netPay || 0)
    + Math.max(0, (p.totalAdvanceDeduction || 0) - (p.advanceRecoveredAtPayment || 0)), 0);

  const shifts = await ShiftDetail.find({
    employee: emp._id, date: { $gte: win.start, $lte: win.end },
  }).select("shift date").lean();

  // ── Attendance ────────────────────────────────────────────────
  // Count days the employee ACTUALLY turned up, from the attendance
  // register — a scheduled shift is not proof of attendance. Using
  // ShiftDetail alone let someone marked absent every single day still
  // score 100% and take a full-tier bonus.
  const marks = await Attendance.find({
    employee: emp._id, date: { $gte: win.start, $lte: win.end },
  }).select("date shift status isApprovedLeave leaveType").lean();

  const dayKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`; };
  let attendanceDays, attendanceSource;
  if (marks.length > 0) {
    const worked = new Set(
      marks
        .filter(m => ['present', 'late', 'half_day'].includes(m.status) || m.isApprovedLeave === true)
        .map(m => dayKey(m.date))
    );
    attendanceDays = worked.size;
    attendanceSource = 'attendance';
  } else {
    // No attendance register for the window (legacy data) — fall back to
    // scheduled shifts so historical years still compute.
    attendanceDays = new Set(shifts.map(s => dayKey(s.date))).size;
    attendanceSource = 'scheduled_shifts';
  }

  // The estimate falls back on ATTENDED shifts, not scheduled ones.
  //
  // The attendance count above was deliberately moved off ShiftDetail —
  // "a scheduled shift is not proof of attendance… someone marked absent
  // every single day still scored 100%". The earnings estimate sitting
  // beside it kept counting scheduled shifts, so the very employee that
  // fix was written for still got a full-year earnings base whenever no
  // payroll existed for the window. Same evidence, same source.
  // Leave approved as unpaid earned nothing (services/payrollService.js),
  // so it adds nothing to an estimate of what was earned.
  const attendedShifts = marks.length > 0
    ? marks.filter((m) =>
        ['present', 'late', 'half_day'].includes(m.status)
        || (m.isApprovedLeave === true && m.leaveType !== 'unpaid'))
    : shifts;                       // legacy windows with no register at all
  const hoursWorked = attendedShifts.reduce(
    (sum, s) => sum + shiftHours(s.shift), 0
  );
  const estimatedEarnings = (emp.hourlyRate || 0) * hoursWorked;

  const basedOn = salaryReceived > 0 ? "salary_received" : "estimated";
  const base    = salaryReceived > 0 ? salaryReceived : estimatedEarnings;

  const bonusPercent   = emp.bonusPercent ?? 10;
  const rawBonusAmount = base * (bonusPercent / 100);

  const totalWorkingDays = cfg.yearlyWorkingDays;
  const attendanceRate   = Math.min(100, totalWorkingDays > 0 ? (attendanceDays / totalWorkingDays) * 100 : 0);
  const { tier, multiplier } = attendanceTier(attendanceRate);

  // Eligibility: below the minimum days worked no bonus is due (mirrors the
  // Payment of Bonus Act's 30-working-days rule; 0 disables the check).
  const minDays  = cfg.minDaysForEligibility ?? 30;
  const eligible = attendanceDays >= minDays;

  // Statutory floor: the attendance multiplier may not drag the effective
  // rate below the configured minimum percent of the base (default 8.33%,
  // the Act's floor). Set minBonusPercent to 0 to allow any amount.
  const floorPct = cfg.minBonusPercent ?? 8.33;
  const scaled   = rawBonusAmount * multiplier;
  const floored  = floorPct > 0 ? Math.max(scaled, base * (floorPct / 100)) : scaled;
  const bonusAmount = eligible ? Math.round(Math.min(floored, rawBonusAmount)) : 0;

  return {
    hourlyRate: emp.hourlyRate || 0, hoursWorked,
    salaryReceived: Math.round(salaryReceived),
    annualEarnings: Math.round(base),   // the bonus base (window salary)
    basedOn,
    bonusPercent, rawBonusAmount,
    attendanceDays, totalWorkingDays, attendanceSource,
    attendanceRate: parseFloat(attendanceRate.toFixed(1)),
    attendanceTier: tier, multiplier,
    eligible, minDaysForEligibility: minDays,
    bonusAmount,
  };
}

router.get(
  "/config",
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.query.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const config = await configFor(year);

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

router.put(
  "/config",
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.body.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const cfg  = await getOrCreateConfig(year);

    // The working-days denominator produced every generated amount, so it is
    // locked while any record computed from it still exists — whether the
    // year is 'triggered' or 'completed'. Resetting clears the UNPAID
    // records and unlocks it; paid records can never be removed, so a fully
    // paid year stays locked for good.
    if (req.body.yearlyWorkingDays !== undefined &&
        Number(req.body.yearlyWorkingDays) !== cfg.yearlyWorkingDays) {
      const existing = await BonusRecord.countDocuments({ year });
      if (existing > 0) {
        const paid = await BonusRecord.countDocuments({ year, status: "paid" });
        return next(new ErrorHandler(
          paid > 0
            ? `Cannot change working days — ${paid} bonus record(s) for ${year} are already paid. Reset removes only unpaid records, so this stays locked.`
            : `Cannot change working days while ${year}'s bonus is generated. Use "Reset ${year} bonus" to clear the ${existing} unpaid record(s), then change it.`,
          400
        ));
      }
    }

    const { bonusDate, bonusLabel, yearlyWorkingDays, minDaysForEligibility, minBonusPercent } = req.body;
    if (bonusDate    !== undefined) cfg.bonusDate         = bonusDate ? new Date(bonusDate) : null;
    if (bonusLabel   !== undefined) cfg.bonusLabel        = bonusLabel;
    if (yearlyWorkingDays !== undefined) {
      const wd = parseInt(yearlyWorkingDays);
      if (isNaN(wd) || wd < 1) return next(new ErrorHandler("yearlyWorkingDays must be ≥ 1", 400));
      cfg.yearlyWorkingDays = wd;
    }
    if (minDaysForEligibility !== undefined) {
      const md = parseInt(minDaysForEligibility);
      if (isNaN(md) || md < 0) return next(new ErrorHandler("minDaysForEligibility must be ≥ 0", 400));
      cfg.minDaysForEligibility = md;
    }
    if (minBonusPercent !== undefined) {
      const mp = parseFloat(minBonusPercent);
      if (isNaN(mp) || mp < 0 || mp > 100) return next(new ErrorHandler("minBonusPercent must be 0–100", 400));
      cfg.minBonusPercent = mp;
    }

    await cfg.save();
    res.status(200).json({ success: true, config: cfg });
  })
);

router.post(
  "/trigger",
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.body.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const cfg  = await getOrCreateConfig(year);

    if (cfg.status === "completed") {
      return next(new ErrorHandler(
        "Bonus for this year is already completed. Reset to re-trigger.", 400
      ));
    }

    // Generate ONLY in the configured Diwali month — before that, the admin
    // sees the approximate figures via GET /bonus/preview.
    if (!cfg.bonusDate) {
      return next(new ErrorHandler("Set the Diwali date in the bonus config before generating.", 400));
    }
    if (!isDiwaliMonth(cfg)) {
      const d = new Date(cfg.bonusDate);
      return next(new ErrorHandler(
        `Bonus can only be generated in the Diwali month (${d.toLocaleString("en-IN", { month: "long", year: "numeric" })}). Use the preview until then.`,
        400
      ));
    }

    const win = diwaliWindow(cfg, year);
    // Everyone who worked any of the bonus year, a leaver included.
    const employees = await Employee.find(employedFrom(win.start)).select("name department hourlyRate bonusPercent");

    if (employees.length === 0) {
      return next(new ErrorHandler("No employees found", 404));
    }

    // Never recompute a record that has already been PAID — the money is
    // out the door and its amount is history.
    const paidIds = new Set(
      (await BonusRecord.find({ year, status: "paid" }).select("employee").lean())
        .map((r) => String(r.employee))
    );

    const records = [];
    for (const emp of employees) {
      if (paidIds.has(String(emp._id))) continue;
      const c = await computeEmployeeBonus(emp, cfg, win);
      records.push({ employee: emp._id, year, ...c, status: "pending" });
    }

    // Upsert keyed on (employee, year) — matching the unique index. The old
    // filter also matched on status:'pending', so a paid record never
    // matched and the upsert tried to INSERT a duplicate (E11000), or
    // silently reverted the paid row where the index was missing.
    const ops = records.map((r) => ({
      updateOne: {
        filter: { employee: r.employee, year: r.year },
        update: { $set: r },
        upsert: true,
      },
    }));

    // Everything — clearing stale drafts, writing records, flipping the
    // config and posting the ledger — lands in ONE transaction, so a
    // failure can't leave the year half-generated.
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Paid records, read again INSIDE the transaction. The list read
        // above is from before it: a bonus paid in between was reset to
        // pending with a recomputed amount, and re-posting it deleted its
        // payment from the ledger. A payment that commits while this
        // runs collides with the write below, so this is retried and
        // sees it.
        const paidNow = new Set(
          (await BonusRecord.find({ year, status: "paid" }).select("employee").session(session).lean())
            .map((r) => String(r.employee))
        );
        const live = records.filter((r) => !paidNow.has(String(r.employee)));
        const liveOps = ops.filter((o) => !paidNow.has(String(o.updateOne.filter.employee)));

        // Drop pending rows for employees who no longer qualify/exist.
        await BonusRecord.deleteMany(
          { year, status: "pending", employee: { $nin: live.map((r) => r.employee) } },
          { session }
        );
        if (liveOps.length) await BonusRecord.bulkWrite(liveOps, { session });
        cfg.status      = "triggered";
        cfg.triggeredAt = new Date();
        await cfg.save({ session });

        // The bonus belongs on the Diwali date itself, not the run date.
        const diwaliDate = cfg.bonusDate
          ? new Date(cfg.bonusDate)
          : new Date(win.diwaliYear, win.diwaliMonth - 1, 1);
        // Only (re)post the records this run touched — a paid record's
        // ledger rows must not be rewritten.
        const posted = await BonusRecord.find({
          year, status: { $ne: "paid" }, employee: { $in: live.map((r) => r.employee) },
        }).session(session);
        for (const rec of posted) {
          await ledger.postDiwaliBonus(rec, diwaliDate, session, {
            postedBy: req.user?.name || 'admin',
          });
        }
      });
    } finally { await session.endSession(); }

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

// Approximate bonus preview — computed live from salary received so far in
// the Diwali window, WITHOUT persisting. `approximate` is true until the
// Diwali month; `canGenerate` tells the UI when the real trigger is allowed.
router.get(
  "/preview",
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.query.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const cfg  = await configFor(year);
    const win  = diwaliWindow(cfg, year);

    // Everyone who worked any of the bonus year, a leaver included.
    const employees = await Employee.find(employedFrom(win.start)).select("name department hourlyRate bonusPercent");
    const rows = [];
    for (const emp of employees) {
      const c = await computeEmployeeBonus(emp, cfg, win);
      rows.push({ employeeId: emp._id, name: emp.name, department: emp.department, ...c });
    }
    rows.sort((a, b) => b.bonusAmount - a.bonusAmount);

    const onMonth = isDiwaliMonth(cfg);
    res.status(200).json({
      success:     true,
      year,
      approximate: !onMonth,           // true = figures will still change
      canGenerate: onMonth && cfg.status !== "completed",
      diwaliDate:  cfg.bonusDate,
      bonusLabel:  cfg.bonusLabel,
      configured:  !!cfg.bonusDate,
      config: {
        bonusDate: cfg.bonusDate,
        bonusLabel: cfg.bonusLabel,
        yearlyWorkingDays: cfg.yearlyWorkingDays,
        minDaysForEligibility: cfg.minDaysForEligibility ?? 30,
        minBonusPercent: cfg.minBonusPercent ?? 8.33,
        status: cfg.status,
      },
      window:      { start: win.start, end: win.end, months: win.months },
      totalPayout: rows.reduce((s, r) => s + r.bonusAmount, 0),
      eligibleCount:   rows.filter((r) => r.eligible).length,
      ineligibleCount: rows.filter((r) => !r.eligible).length,
      rows,
    });
  })
);

router.get(
  "/records",
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const year    = yearOf(req.query.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const status  = req.query.status || "all";

    const filter = { year };
    if (status !== "all") filter.status = status;

    const records = await BonusRecord.find(filter)
      .populate("employee", EMPLOYEE_CARD_FIELDS)
      .sort({ bonusAmount: -1 });

    const totalPayout = records.reduce((s, r) => s + r.bonusAmount, 0);
    const paidPayout  = records.filter((r) => r.status === "paid")
                                 .reduce((s, r) => s + r.bonusAmount, 0);

    res.status(200).json({
      success: true,
      records,
      summary: {
        total:   records.length,
        paid:    records.filter((r) => r.status === "paid").length,
        pending: records.filter((r) => r.status === "pending").length,
        totalPayout,
        paidPayout,
        pendingPayout: totalPayout - paidPayout,
      },
    });
  })
);

router.get(
  "/employee/:id",
  selfOrAdmin,
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.query.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }

    const [record, config] = await Promise.all([
      BonusRecord.findOne({ employee: id, year })
        .populate("employee", EMPLOYEE_CARD_FIELDS),
      BonusConfig.findOne({ year }),
    ]);

    res.status(200).json({
      success: true, year,
      record: record || null,
      config: config || null,
    });
  })
);

// ─────────────────────────────────────────────────────────────
// GET /employee/:id/prediction?year=
//   One employee's LIVE Diwali-bonus projection from current data —
//   window salary, attendance tier, eligibility and the resulting
//   amount — without persisting anything. Powers the prediction card on
//   the employee detail page. Returns the generated record too (when the
//   year has been triggered) so the UI can show projected vs locked-in.
// ─────────────────────────────────────────────────────────────
router.get(
  "/employee/:id/prediction",
  selfOrAdmin,
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.query.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }

    const emp = await Employee.findById(id).select("name department hourlyRate bonusPercent");
    if (!emp) return next(new ErrorHandler("Employee not found", 404));

    const cfg = await configFor(year);
    const win = diwaliWindow(cfg, year);
    const prediction = await computeEmployeeBonus(emp, cfg, win);
    const record = await BonusRecord.findOne({ employee: id, year }).lean();

    res.status(200).json({
      success: true,
      year,
      employee: { id: emp._id, name: emp.name, department: emp.department },
      approximate: !isDiwaliMonth(cfg),
      configured: !!cfg.bonusDate,
      diwaliDate: cfg.bonusDate,
      bonusLabel: cfg.bonusLabel,
      window: { start: win.start, end: win.end, months: win.months },
      prediction,
      record: record || null,     // the locked-in figure, once generated
    });
  })
);

router.get(
  "/employee/:id/pdf",
  selfOrAdmin,
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.query.year);
    if (year == null) return next(new ErrorHandler(NOT_A_YEAR, 400));
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid employee id", 400));
    }

    const [record, config] = await Promise.all([
      BonusRecord.findOne({ employee: id, year })
        .populate("employee", EMPLOYEE_CARD_FIELDS),
      BonusConfig.findOne({ year }),
    ]);

    if (!record) {
      return next(new ErrorHandler(
        `No bonus record for employee ${id} in ${year}`, 404
      ));
    }

    const file = bonusFileName(record, year);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", require("../utils/sendFile").contentDisposition("attachment", file.name, file.fallback));
    // The page itself is services/bonusPdf.js.
    writeBonusCertificate(record, config, year, res);
  })
);

router.put(
  "/records/:id/pay",
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const existing = await BonusRecord.findById(req.params.id).select("status").lean();
    if (!existing) return next(new ErrorHandler("Bonus record not found", 404));
    if (existing.status === "paid") {
      return next(new ErrorHandler("Already marked as paid", 400));
    }

    // Marking paid + the ledger payment row are one atomic step, and the
    // "not yet paid" check is IN the write. Checked beforehand only, two
    // clicks both passed it; the second transaction collided, was
    // retried, and posted the payment to the ledger a second time.
    let record;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        record = await BonusRecord.findOneAndUpdate(
          { _id: req.params.id, status: { $ne: "paid" } },
          { $set: { status: "paid", paidAt: new Date() } },
          { new: true, session }
        );
        if (!record) throw new ErrorHandler("Already marked as paid", 400);
        await ledger.postBonusPaid(record, session, { postedBy: req.user?.name || 'admin' });
      });
    } finally { await session.endSession(); }

    const pendingCount = await BonusRecord.countDocuments({ year: record.year, status: "pending" });
    if (pendingCount === 0) {
      await BonusConfig.updateOne({ year: record.year }, { status: "completed" });
    }

    res.status(200).json({ success: true, record });
  })
);

router.delete(
  "/year/:year/reset",
  isAdmin('admin', 'accounts'),
  catchAsyncErrors(async (req, res, next) => {
    const year = yearOf(req.params.year);
    if (year == null) return next(new ErrorHandler("Invalid year", 400));

    // Deleting the records must also retract their ledger rows, or each
    // employee's ledger keeps showing a Diwali bonus that no longer exists
    // (and their balance stays inflated). Both happen in one transaction.
    let deleted = { deletedCount: 0 };
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const doomed = await BonusRecord.find({ year, status: "pending" })
          .select("_id").session(session).lean();
        const ids = doomed.map((d) => d._id);
        if (ids.length) {
          await LedgerEntry.deleteMany({ source: "bonus", sourceId: { $in: ids } }, { session });
        }
        deleted = await BonusRecord.deleteMany({ year, status: "pending" }, { session });

        const cfg = await BonusConfig.findOne({ year }).session(session);
        if (cfg) {
          // A year that was fully paid out stays completed: nothing was
          // cleared, and resetting must not reopen it. A year that was
          // only part paid goes back to "not generated" for the rest —
          // it used to be marked completed too, and then could not be
          // generated again: the people whose unpaid records had just
          // been cleared were left with no bonus and no way to get one.
          // (Generating never touches a record already paid.)
          const paidLeft = await BonusRecord.countDocuments({ year, status: "paid" }).session(session);
          const fullyPaid = paidLeft > 0 && deleted.deletedCount === 0;
          cfg.status      = fullyPaid ? "completed" : "pending";
          cfg.triggeredAt = paidLeft > 0 ? cfg.triggeredAt : null;
          await cfg.save({ session });
        }
      });
    } finally { await session.endSession(); }

    console.log(`[bonus/reset] ${year}: deleted ${deleted.deletedCount} pending records`);

    res.status(200).json({
      success: true,
      deletedCount: deleted.deletedCount,
      message: `Reset ${year} bonus. Paid records are preserved.`,
    });
  })
);

router.put(
  "/employee/:id/percent",
  isAdmin('admin', 'accounts'),
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
