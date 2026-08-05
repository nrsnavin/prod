// ══════════════════════════════════════════════════════════════
//  PAYROLL ROUTE  v3
//  Mount: app.use('/api/v2/payroll', require('./api/payroll.js'));
//
//  Auth (AUTH = login required; ADMIN = role 'admin'):
//    Worker-facing (AUTH): GET /slip/:empId, POST /advance
//    Everything else        ADMIN
// ══════════════════════════════════════════════════════════════
'use strict';

const express          = require('express');
const mongoose         = require('mongoose');
const PDFDocument      = require('pdfkit');
const router           = express.Router();
const Attendance       = require('../models/Attendence');
const Employee         = require('../models/Employee');
const Payroll          = require('../models/Payroll');
const PayrollSettings  = require('../models/PayrollSettings');
const AdvanceRequest   = require('../models/Advance');
const ShiftDetail      = require('../models/ShiftDetail');
const Wastage          = require('../models/Wastage');
const { isAuthenticated, isAdmin, selfOrAdmin, requireFeature, requireFeatureRead } = require('../middleware/auth');
const { EMPLOYEE_CARD_FIELDS } = require('../utils/populateFields');
const { resolveEmployeeId } = require('../utils/resolveEmployee');
// The ~200-line pure pay computation lives in services/payrollService.js.
// Re-exported below (router.computePayroll) so existing callers/tests
// that reach it via the payroll router keep working.
const { computePayroll } = require('../services/payrollService');
const ledger = require('../services/ledgerService');
const LedgerEntry = require('../models/LedgerEntry');

router.use(isAuthenticated);
// Per-user feature gate. The worker self-service advance request
// (POST /advance) is exempt from writes — an employee requests their own
// advance without holding the /payroll management feature. The selfOrAdmin
// reads (own payslip/ledger/history/range) are exempt from the read gate
// for the same reason: a worker's own pay record is answerable to their
// identity, not to whether the admin ticked their Payroll checkbox.
router.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/advance') return next();
  const isSelfRead = (req.method === 'GET' || req.method === 'HEAD') &&
    (req.path.startsWith('/slip/') || req.path.startsWith('/ledger/') ||
     req.path.startsWith('/history/') || req.path.startsWith('/range/'));
  if (isSelfRead) return next();
  requireFeature('/payroll')(req, res, (err) => {
    if (err) return next(err);
    requireFeatureRead('/payroll')(req, res, next);
  });
});

const r2 = (n) => Math.round(n * 100) / 100;


router.get('/settings', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const s = await PayrollSettings.findOne({}).lean() ?? {};
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/settings', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const allowed = ['casualLeavesPerMonth','sickLeavesPerMonth','lateGracePeriodMinutes',
                     'penaltyPerExcessAbsent','noLeaveBonus','perfectAttendanceBonus','streakBonusPer7Shifts',
                     'overtimeMultiplier','overtimeGraceMinutes',
                     'pfPercent','pfWageCeiling','esiPercent','esiWageCeiling'];
    const update = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = Number(req.body[k]);
    const s = await PayrollSettings.findOneAndUpdate({}, { $set: update }, { upsert: true, new: true });
    res.json({ success: true, data: s });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/employees', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const emps = await Employee.find({})
      .select('name department role skill hourlyRate').sort({ name: 1 }).lean();
    res.json({
      success: true,
      data: emps.map(e => ({
        id: e._id, name: e.name, department: e.department,
        role: e.role ?? '', skill: e.skill ?? 0,
        hourlyRate: e.hourlyRate ?? 0,
        dayShiftPay:   (e.hourlyRate ?? 0) * 12,
        nightShiftPay: (e.hourlyRate ?? 0) * 8,
      })),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/employees/:id/rate', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const rate = Number(req.body.hourlyRate);
    if (isNaN(rate) || rate < 0)
      return res.status(400).json({ success: false, message: 'hourlyRate must be ≥ 0' });
    const emp = await Employee.findByIdAndUpdate(
      req.params.id, { $set: { hourlyRate: rate } }, { new: true }
    ).select('name department hourlyRate');
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({
      success: true,
      message: `Rate updated for ${emp.name}`,
      data: { id: emp._id, name: emp.name, department: emp.department,
              hourlyRate: emp.hourlyRate, dayShiftPay: emp.hourlyRate * 12,
              nightShiftPay: emp.hourlyRate * 8 },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/generate', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { year, month, employeeId } = req.body;
    if (!year || !month)
      return res.status(400).json({ success: false, message: 'year and month required' });

    let empIds, skipped = [];
    if (employeeId) {
      empIds = [employeeId];
    } else {
      const all = await Employee.find({}, '_id name hourlyRate').lean();
      empIds  = all.filter(e => (e.hourlyRate ?? 0) > 0).map(e => e._id.toString());
      // Report (don't silently drop) employees with no rate — a missing
      // rate = a missing paycheck, so surface exactly who was skipped.
      skipped = all.filter(e => (e.hourlyRate ?? 0) <= 0)
        .map(e => ({ employeeId: e._id, name: e.name, reason: 'no hourlyRate set' }));
    }

    if (!empIds.length)
      return res.status(400).json({ success: false, message: 'No employees with hourlyRate set', skipped });

    const results = [], errors = [];
    for (const id of empIds) {
      // Never overwrite a finalized/paid payroll. /generate upserts with
      // $set:data (status:'draft'), so a re-run would silently revert a
      // paid slip to draft and recompute the amount AFTER payment. Only
      // draft (or not-yet-existing) rows may be regenerated.
      const existing = await Payroll.findOne(
        { employee: id, year: +year, month: +month }, 'status amountPaid'
      ).lean();
      if (existing && ['finalized', 'paid', 'partially_paid'].includes(existing.status)) {
        errors.push({ employeeId: id, error: `Payroll already ${existing.status} — not regenerated` });
        continue;
      }
      // Belt and braces: any slip money has been paid against is off limits
      // even if its status somehow says draft. Regenerating would reset it
      // to draft and recompute the amount AFTER cash was handed over,
      // re-opening it for a second finalize/pay.
      if (existing && (existing.amountPaid ?? 0) > 0) {
        errors.push({ employeeId: id, error: `Payroll already has ₹${existing.amountPaid} paid — not regenerated` });
        continue;
      }

      try {
        const data = await computePayroll(id, +year, +month);
        // Draft is a PREVIEW: store the per-advance recovery plan but do
        // NOT touch advance balances — regenerating a draft must never
        // double-recover. The recovery is committed to the advances only
        // at /finalize (which is a guarded one-way transition).
        data.advanceRecoveries = (data._advanceRecoveries || [])
          .map(r => ({ advance: r.id, amount: r.recovered }));
        delete data._advanceRecoveries;

        await Payroll.findOneAndUpdate(
          { employee: id, year: +year, month: +month },
          { $set: data },
          { upsert: true, new: true }
        );

        results.push({ employeeId: id, netPay: data.netPay, status: data.status });
      } catch (err) {
        errors.push({ employeeId: id, error: err.message });
      }
    }

    res.json({
      success: true,
      message: `Generated ${results.length} payroll(s)`
        + (skipped.length ? ` — ${skipped.length} skipped (no rate)` : ''),
      data: results,
      skipped: skipped.length ? skipped : undefined,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/dashboard', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);
    const payrolls = await Payroll.find({ year, month })
      .populate('employee', 'name department hourlyRate').lean();

    // One corrupt row used to poison every total via NaN propagation;
    // skip any field that isn't a finite number.
    const sum = (key) => payrolls.reduce(
      (s, p) => s + (Number.isFinite(p[key]) ? p[key] : 0), 0
    );
    const totalNetPay     = sum('netPay');
    const totalGross      = sum('grossEarnings');
    const totalDeductions = sum('totalDeductions');
    const totalBonuses    = sum('totalBonuses');

    res.json({
      success: true, year, month,
      summary: {
        totalEmployees:   payrolls.length,
        totalNetPay:      r2(totalNetPay),
        totalGross:       r2(totalGross),
        totalDeductions:  r2(totalDeductions),
        totalBonuses:     r2(totalBonuses),
        perfectCount:     payrolls.filter(p => p.perfectAttendance).length,
        paidCount:        payrolls.filter(p => p.status === 'paid').length,
        partiallyPaidCount: payrolls.filter(p => p.status === 'partially_paid').length,
        finalizedCount:   payrolls.filter(p => p.status === 'finalized').length,
        draftCount:       payrolls.filter(p => p.status === 'draft').length,
        totalPaid:        r2(sum('amountPaid')),
      },
      employees: payrolls.map(p => ({
        id:              p._id,
        employeeId:      p.employee?._id ?? p.employee,
        name:            p.employee?.name ?? '–',
        department:      p.employee?.department ?? '–',
        hourlyRate:      p.hourlyRate,
        totalShifts:     p.totalShifts,
        presentShifts:   p.presentShifts,
        absentShifts:    p.absentShifts,
        excessAbsents:   p.excessAbsents ?? 0,
        grossEarnings:   p.grossEarnings,
        totalDeductions: p.totalDeductions,
        totalBonuses:    p.totalBonuses,
        totalAdvanceDeduction: p.totalAdvanceDeduction ?? 0,
        netPay:          p.netPay,
        amountPaid:      p.amountPaid ?? 0,
        totalCashPaid:   p.totalCashPaid ?? 0,
        advanceRecoveredAtPayment: p.advanceRecoveredAtPayment ?? 0,
        payouts:         p.payouts ?? [],
        perfectAttendance: p.perfectAttendance,
        status:          p.status,
      })).sort((a,b) => b.netPay - a.netPay),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Worker-facing — employees view their own payslip.
// selfOrAdmin blocks one worker from reading another's slip by id swap.
// A month is comparable as year*12 + (month-1) so a [from, to] window is a
// simple numeric range regardless of year boundaries.
const monthKey = (y, m) => y * 12 + (m - 1);
function parseRange(req) {
  const now = new Date();
  const toYear   = +(req.query.toYear   || now.getFullYear());
  const toMonth  = +(req.query.toMonth  || now.getMonth() + 1);
  // Default window: the trailing 6 months ending at `to`.
  const def = new Date(toYear, toMonth - 1 - 5, 1);
  const fromYear  = +(req.query.fromYear  || def.getFullYear());
  const fromMonth = +(req.query.fromMonth || def.getMonth() + 1);
  return { fromYear, fromMonth, toYear, toMonth,
    fromKey: monthKey(fromYear, fromMonth), toKey: monthKey(toYear, toMonth) };
}

// Aggregated payroll across a month range — one summed row per employee.
// Powers the payroll page's "Range" view.
router.get('/dashboard-range', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const rg = parseRange(req);
    if (rg.fromKey > rg.toKey)
      return res.status(400).json({ success: false, message: '`from` month is after `to` month' });

    const rows = await Payroll.aggregate([
      { $addFields: { _key: { $add: [{ $multiply: ['$year', 12] }, { $subtract: ['$month', 1] }] } } },
      { $match: { _key: { $gte: rg.fromKey, $lte: rg.toKey } } },
      { $group: {
          _id: '$employee',
          grossEarnings:   { $sum: '$grossEarnings' },
          totalDeductions: { $sum: '$totalDeductions' },
          totalBonuses:    { $sum: '$totalBonuses' },
          totalAdvanceDeduction: { $sum: '$totalAdvanceDeduction' },
          netPay:          { $sum: '$netPay' },
          amountPaid:      { $sum: '$amountPaid' },
          months:          { $sum: 1 },
          paidMonths:      { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
      } },
      { $lookup: { from: 'employees', localField: '_id', foreignField: '_id', as: 'emp' } },
      { $unwind: { path: '$emp', preserveNullAndEmptyArrays: true } },
    ]);

    const employees = rows.map(r => ({
      employeeId:      r._id,
      name:            r.emp?.name ?? '-',
      department:      r.emp?.department ?? '-',
      grossEarnings:   r2(r.grossEarnings),
      totalDeductions: r2(r.totalDeductions),
      totalBonuses:    r2(r.totalBonuses),
      totalAdvanceDeduction: r2(r.totalAdvanceDeduction),
      netPay:          r2(r.netPay),
      amountPaid:      r2(r.amountPaid),
      months:          r.months,
      paidMonths:      r.paidMonths,
      fullyPaid:       r.paidMonths === r.months,
    })).sort((a, b) => b.netPay - a.netPay);

    const sum = (k) => employees.reduce((s, e) => s + (Number.isFinite(e[k]) ? e[k] : 0), 0);
    res.json({
      success: true,
      range: { fromYear: rg.fromYear, fromMonth: rg.fromMonth, toYear: rg.toYear, toMonth: rg.toMonth },
      summary: {
        totalEmployees:  employees.length,
        totalNetPay:     r2(sum('netPay')),
        totalGross:      r2(sum('grossEarnings')),
        totalDeductions: r2(sum('totalDeductions')),
        totalBonuses:    r2(sum('totalBonuses')),
        totalPaid:       r2(sum('amountPaid')),
      },
      employees,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/slip/:empId', selfOrAdmin, async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);
    const p = await Payroll.findOne({ employee: req.params.empId, year, month })
      .populate('employee', EMPLOYEE_CARD_FIELDS).lean();
    if (!p) return res.status(404).json({ success: false, message: 'Not generated yet' });
    res.json({ success: true, data: p });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Printable payslip PDF for a month. selfOrAdmin — workers get their own.
const MONTHS_PDF = ['January','February','March','April','May','June','July','August','September','October','November','December'];
// ─────────────────────────────────────────────────────────────
// GET /ledger/:empId?from=YYYY-MM-DD&to=YYYY-MM-DD
//   One employee's full money trail over a date range: every shift's
//   salary, overtime, bonuses, penalties, statutory cuts, advances given
//   and recovered, salary payments, and the Diwali bonus (dated on the
//   festival). Oldest first with a running balance, plus the opening
//   balance carried in from before `from`. selfOrAdmin.
// ─────────────────────────────────────────────────────────────
router.get('/ledger/:empId', selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(empId))
      return res.status(400).json({ success: false, message: 'Invalid employee id' });

    const parseDay = (s, endOfDay) => {
      if (!s) return null;
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
      return d;
    };
    // Default window: the last 3 months.
    const to   = parseDay(req.query.to, true) || parseDay(new Date(), true);
    const dflt = new Date(to); dflt.setMonth(dflt.getMonth() - 3);
    const from = parseDay(req.query.from, false) || parseDay(dflt, false);
    if (from > to)
      return res.status(400).json({ success: false, message: '`from` is after `to`' });

    const data = await ledger.getLedger(empId, { from, to });
    const emp = await Employee.findById(empId, 'name department hourlyRate').lean();
    return res.json({
      success: true,
      employee: emp ? { id: emp._id, name: emp.name, department: emp.department } : null,
      range: { from, to },
      ...data,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/slip/:empId/pdf', selfOrAdmin, async (req, res, next) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = +(req.query.month || new Date().getMonth() + 1);
    const p = await Payroll.findOne({ employee: req.params.empId, year, month })
      .populate('employee', EMPLOYEE_CARD_FIELDS).lean();
    if (!p) return res.status(404).json({ success: false, message: 'Payroll not generated for that month' });

    const rupee = (n) => `Rs. ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const fileName = `payslip-${(p.employee?.name || 'employee').replace(/\s+/g, '_')}-${MONTHS_PDF[month - 1]}-${year}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    // ── Printable payslip: A4, uniform margins, ruled tables ───
    const M = 50;                               // uniform page margin (all sides)
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true });
    doc.pipe(res);

    const W     = doc.page.width;
    const H     = doc.page.height;
    const RIGHT = W - M;
    const CW    = W - 2 * M;                    // content width
    const BOTTOM = H - M - 28;                  // keep clear of the footer

    const INK   = '#1A1D24';
    const MUTE  = '#6B7280';
    const LINE  = '#C9CDD6';                    // table rules (print-safe grey)
    const HAIR  = '#E5E7EB';                    // inner row rules
    const HEAD  = '#F1F3F7';                    // table header fill
    const NEG   = '#B42318';

    // pdfkit's built-in Helvetica is WinAnsi-only: strip emoji / non-Latin1
    // glyphs and spell ₹ as "Rs." so nothing renders as a blank box.
    const clean = (s) => String(s ?? '')
      .replace(/₹\s?/g, 'Rs. ')
      .replace(/[^\x20-\xFF]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    let y = M;

    // ── Title bar ──────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
       .text('PAYSLIP', M, y, { characterSpacing: 1 });
    doc.font('Helvetica').fontSize(10).fillColor(MUTE)
       .text(`${MONTHS_PDF[month - 1]} ${year}`, M, y + 20);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTE)
       .text(clean((p.status || 'draft').replace('_', ' ')).toUpperCase(),
             RIGHT - 160, y + 4, { width: 160, align: 'right', characterSpacing: 1 });
    y += 40;
    doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(1.2).strokeColor(INK).stroke();
    y += 16;

    // ── Employee details table (2 columns of label/value) ──────
    const detail = [
      ['Employee',    clean(p.employee?.name) || '-'],
      ['Department',  clean(p.employee?.department) || '-'],
      ['Hourly rate', rupee(p.hourlyRate)],
      ['Shifts',      `${p.presentShifts ?? 0} present / ${p.absentShifts ?? 0} absent / ${p.approvedLeaveShifts ?? 0} leave`],
    ];
    const dRowH = 20, dCol = CW / 2, dLabW = 78;
    const dRows = Math.ceil(detail.length / 2);
    doc.lineWidth(0.6).strokeColor(LINE);
    doc.rect(M, y, CW, dRowH * dRows).stroke();
    detail.forEach(([lab, val], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = M + col * dCol, ry = y + row * dRowH;
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTE)
         .text(lab.toUpperCase(), x + 8, ry + 6.5, { width: dLabW });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
         .text(val, x + 8 + dLabW, ry + 5.5, { width: dCol - dLabW - 16, ellipsis: true, lineBreak: false });
    });
    for (let r = 1; r < dRows; r++)
      doc.moveTo(M, y + r * dRowH).lineTo(RIGHT, y + r * dRowH).lineWidth(0.5).strokeColor(HAIR).stroke();
    doc.moveTo(M + dCol, y).lineTo(M + dCol, y + dRowH * dRows).lineWidth(0.5).strokeColor(HAIR).stroke();
    y += dRowH * dRows + 20;

    // ── Earnings & deductions table ────────────────────────────
    // Columns: description | earnings | deductions
    const C2 = 110, C3 = 110;                   // amount column widths
    const C1 = CW - C2 - C3;
    const X1 = M, X2 = M + C1, X3 = M + C1 + C2;
    const ROW = 19, HEADH = 22;

    const tableHeader = () => {
      doc.rect(M, y, CW, HEADH).fillAndStroke(HEAD, LINE);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
      doc.text('DESCRIPTION', X1 + 8, y + 7, { width: C1 - 16 });
      doc.text('EARNINGS',    X2 + 8, y + 7, { width: C2 - 16, align: 'right' });
      doc.text('DEDUCTIONS',  X3 + 8, y + 7, { width: C3 - 16, align: 'right' });
      y += HEADH;
    };
    const vRules = (fromY, toY) => {
      doc.lineWidth(0.5).strokeColor(LINE);
      [M, X2, X3, RIGHT].forEach((x) => doc.moveTo(x, fromY).lineTo(x, toY).stroke());
    };

    tableHeader();
    let secTop = y;
    for (const li of p.lineItems || []) {
      if (y + ROW > BOTTOM) {                   // page break: close + repeat header
        vRules(secTop, y);
        doc.addPage(); y = M; tableHeader(); secTop = y;
      }
      const neg = li.amount < 0;
      doc.font('Helvetica').fontSize(9).fillColor(INK)
         .text(clean(li.label), X1 + 8, y + 5.5, { width: C1 - 16, ellipsis: true, lineBreak: false });
      doc.fillColor(neg ? NEG : INK)
         .text(rupee(Math.abs(li.amount)), neg ? X3 + 8 : X2 + 8, y + 5.5,
               { width: (neg ? C3 : C2) - 16, align: 'right' });
      y += ROW;
      doc.moveTo(M, y).lineTo(RIGHT, y).lineWidth(0.4).strokeColor(HAIR).stroke();
    }
    // Column totals row
    const totalEarn = (p.lineItems || []).filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0);
    const totalDed  = (p.lineItems || []).filter(l => l.amount < 0).reduce((s, l) => s - l.amount, 0);
    if (y + ROW + 4 > BOTTOM) { vRules(secTop, y); doc.addPage(); y = M; tableHeader(); secTop = y; }
    doc.rect(M, y, CW, ROW + 3).fillAndStroke(HEAD, LINE);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text('Total', X1 + 8, y + 6, { width: C1 - 16 });
    doc.text(rupee(totalEarn), X2 + 8, y + 6, { width: C2 - 16, align: 'right' });
    doc.text(rupee(totalDed),  X3 + 8, y + 6, { width: C3 - 16, align: 'right' });
    y += ROW + 3;
    vRules(secTop, y);
    y += 20;

    // ── Summary table ──────────────────────────────────────────
    const sum = [
      ['Gross earnings',   rupee(p.grossEarnings)],
      ['Total bonuses',    rupee(p.totalBonuses)],
      ['Total deductions', rupee(p.totalDeductions)],
    ];
    if (p.totalAdvanceDeduction) sum.push(['   incl. advance recovery', rupee(p.totalAdvanceDeduction)]);
    if (p.amountPaid)            sum.push(['Amount already paid', rupee(p.amountPaid)]);

    const sW = 260, sX = RIGHT - sW, sRow = 19;
    const sH = sRow * sum.length;
    if (y + sH + 46 > BOTTOM) { doc.addPage(); y = M; }
    doc.lineWidth(0.6).strokeColor(LINE).rect(sX, y, sW, sH).stroke();
    sum.forEach(([lab, val], i) => {
      const ry = y + i * sRow;
      if (i) doc.moveTo(sX, ry).lineTo(RIGHT, ry).lineWidth(0.4).strokeColor(HAIR).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(MUTE).text(lab, sX + 10, ry + 5.5, { width: sW - 130 });
      doc.font('Helvetica').fontSize(9).fillColor(INK)
         .text(val, sX + sW - 118, ry + 5.5, { width: 108, align: 'right' });
    });
    y += sH;

    // Net pay row — the emphasised bottom row of the summary table
    doc.rect(sX, y, sW, 30).fillAndStroke(HEAD, INK);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
       .text('NET PAY', sX + 10, y + 10, { characterSpacing: 0.8 });
    doc.font('Helvetica-Bold').fontSize(14).fillColor(INK)
       .text(rupee(p.netPay), sX + sW - 148, y + 7.5, { width: 138, align: 'right' });
    y += 30 + 34;

    // ── Signature line ─────────────────────────────────────────
    if (y + 40 < BOTTOM) {
      doc.moveTo(RIGHT - 170, y).lineTo(RIGHT, y).lineWidth(0.6).strokeColor(LINE).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(MUTE)
         .text('Authorised signatory', RIGHT - 170, y + 5, { width: 170, align: 'center' });
    }

    // ── Footer on every page ───────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      const fy = H - M - 14;
      doc.moveTo(M, fy - 6).lineTo(RIGHT, fy - 6).lineWidth(0.5).strokeColor(HAIR).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTE)
         .text('System-generated payslip - contact your supervisor for any queries.', M, fy, { width: CW - 120 });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTE)
         .text(`Page ${i + 1} of ${pages.count}`, RIGHT - 120, fy, { width: 120, align: 'right' });
    }
    doc.flushPages();
    doc.end();
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────
// GET /history/:empId?limit=6
//   Recent payslips (most recent first) plus the total salary still
//   owed — the sum of net pay on every payslip not yet marked 'paid'.
//   selfOrAdmin: a worker can read their own history, admins anyone's.
// ─────────────────────────────────────────────────────────────
router.get('/history/:empId', selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(empId))
      return res.status(400).json({ success: false, message: 'Invalid employee id' });

    const limit = Math.min(Math.max(+(req.query.limit || 6), 1), 24);

    const payslips = await Payroll.find({ employee: empId })
      .sort({ year: -1, month: -1 })
      .limit(limit)
      .select('year month netPay grossEarnings totalDeductions status finalizedAt paidAt createdAt')
      .lean();

    // Salary still owed = net pay MINUS whatever has already been paid on
    // each non-'paid' payslip. Summing raw netPay overstated the liability
    // for a partially-paid slip (it ignored the cash already handed over).
    const agg = await Payroll.aggregate([
      { $match: { employee: new mongoose.Types.ObjectId(empId), status: { $ne: 'paid' } } },
      { $addFields: {
          _owed: { $max: [0, { $subtract: ['$netPay', { $ifNull: ['$amountPaid', 0] }] }] },
      } },
      { $group: { _id: null, total: { $sum: '$_owed' }, count: { $sum: 1 } } },
    ]);
    const unpaid = agg[0] || { total: 0, count: 0 };

    res.json({
      success: true,
      data: {
        payslips,
        unpaidTotal: unpaid.total || 0,
        unpaidCount: unpaid.count || 0,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ─────────────────────────────────────────────────────────────
// GET /range/:empId?fromYear&fromMonth&toYear&toMonth
//   Every payslip for one employee within a month window, oldest first,
//   plus the range totals. selfOrAdmin — a worker can read their own.
// ─────────────────────────────────────────────────────────────
router.get('/range/:empId', selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(empId))
      return res.status(400).json({ success: false, message: 'Invalid employee id' });
    const rg = parseRange(req);
    if (rg.fromKey > rg.toKey)
      return res.status(400).json({ success: false, message: '`from` month is after `to` month' });

    const all = await Payroll.find({ employee: empId })
      .select('year month netPay grossEarnings totalBonuses totalDeductions totalAdvanceDeduction amountPaid status paidAt finalizedAt')
      .lean();
    const slips = all
      .filter(p => { const k = monthKey(p.year, p.month); return k >= rg.fromKey && k <= rg.toKey; })
      .sort((a, b) => monthKey(a.year, a.month) - monthKey(b.year, b.month));

    const sum = (k) => slips.reduce((s, p) => s + (Number.isFinite(p[k]) ? p[k] : 0), 0);
    res.json({
      success: true,
      range: { fromYear: rg.fromYear, fromMonth: rg.fromMonth, toYear: rg.toYear, toMonth: rg.toMonth },
      slips,
      totals: {
        months:          slips.length,
        grossEarnings:   r2(sum('grossEarnings')),
        totalBonuses:    r2(sum('totalBonuses')),
        totalDeductions: r2(sum('totalDeductions')),
        totalAdvanceDeduction: r2(sum('totalAdvanceDeduction')),
        netPay:          r2(sum('netPay')),
        amountPaid:      r2(sum('amountPaid')),
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// draft → finalized. Commits the advance recovery to the advances'
// remainingBalance (capped at what each advance still owes, so a stale
// preview can never over-recover), then locks the slip.
// Commit a draft's advance recoveries (capped at each advance's remaining
// balance) and mark it finalized. Refunds any over-planned recovery so the
// slip never short-pays. Mutates `p` in place; caller saves within `session`.
async function finalizeDraft(p, session) {
  let shortfall = 0;
  for (const rec of p.advanceRecoveries || []) {
    const adv = await AdvanceRequest.findById(rec.advance).session(session);
    if (!adv) { shortfall = r2(shortfall + rec.amount); continue; }
    const current = adv.remainingBalance != null ? adv.remainingBalance : adv.amount;
    const take = Math.min(rec.amount, current);
    shortfall = r2(shortfall + (rec.amount - take));
    rec.amount = take;                                  // record what was actually taken
    adv.remainingBalance = r2(current - take);
    if (adv.remainingBalance <= 0) {
      adv.deductedInPayroll = true;
      adv.status      = 'recovered';
      adv.recoveredAt = new Date();
    }
    await adv.save({ session });
  }

  // The draft over-deducted by `shortfall` — give it back so net pay
  // reflects what was actually recovered.
  if (shortfall > 0) {
    p.totalAdvanceDeduction = r2((p.totalAdvanceDeduction || 0) - shortfall);
    p.totalDeductions       = r2((p.totalDeductions || 0) - shortfall);
    p.netPay                = r2(Math.max(0, (p.grossEarnings || 0) - p.totalDeductions + (p.totalBonuses || 0)));
    p.lineItems.push({
      label:  `Advance recovery capped — ₹${shortfall} carried to next month`,
      amount: shortfall,
      type:   'earning',
    });
    p.markModified('advanceRecoveries');
    p.markModified('lineItems');
  }

  p.status = 'finalized';
  p.finalizedAt = new Date();
}

// Post a finalized slip to the employee ledger. Separate from finalizeDraft
// so it runs AFTER the slip is saved (the rows reference its final line
// items) but inside the same transaction.
async function postPayrollToLedger(p, session, createdBy) {
  await ledger.postPayroll(p, session, { postedBy: createdBy });
}

router.put('/:id/finalize', isAdmin('admin', 'accounts'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const p = await Payroll.findById(req.params.id).session(session);
      if (!p) { out = { code: 404, body: { success: false, message: 'Not found' } }; return; }
      if (p.status !== 'draft') {
        out = { code: 400, body: { success: false, message: `Only a draft payroll can be finalized (this one is ${p.status})` } };
        return;
      }
      await finalizeDraft(p, session);
      await p.save({ session });
      await postPayrollToLedger(p, session, req.user?.name || 'admin');
      await p.populate('employee', 'name');
      out = { code: 200, body: { success: true, data: p } };
    });
    return res.status(out.code).json(out.body);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    await session.endSession();
  }
});

// Record a payment. Pays the full remaining net by default, or a custom
// `amount` (partial pay → status 'partially_paid'). A draft is auto-finalized
// first (committing its advance recoveries) so pay works in one step. The
// payer is the authenticated user, never a client-supplied name.
router.put('/:id/pay', isAdmin('admin', 'accounts'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const { paymentNote = '' } = req.body;
      const p = await Payroll.findById(req.params.id).session(session);
      if (!p) { out = { code: 404, body: { success: false, message: 'Not found' } }; return; }
      if (p.status === 'paid') { out = { code: 400, body: { success: false, message: 'Already fully paid' } }; return; }

      // One-step pay: finalize the draft (commits advances) before disbursing.
      const wasDraft = p.status === 'draft';
      if (wasDraft) await finalizeDraft(p, session);

      const alreadyPaid = r2(p.amountPaid || 0);
      const remaining   = r2(Math.max(0, (p.netPay || 0) - alreadyPaid));
      if (remaining <= 0) { out = { code: 400, body: { success: false, message: 'Nothing left to pay' } }; return; }

      // ── Recover advances out of THIS payment ────────────────────
      // Settling the slip = cash handed over + advance recovered. The
      // recovery reduces the cash the employee receives, not what they
      // earned, so netPay/totalDeductions are untouched; each recovery is
      // capped at the advance's outstanding balance AND the slip's
      // remaining balance, all inside this transaction.
      const wanted = Array.isArray(req.body.recoverAdvances) ? req.body.recoverAdvances : [];
      let budget = remaining;
      let recovered = 0;
      const recoveredRows = [];
      for (const w of wanted) {
        if (budget <= 0) break;
        const advId = w?.advance ?? w?._id;
        if (!advId || !mongoose.Types.ObjectId.isValid(String(advId))) continue;
        const adv = await AdvanceRequest.findById(advId).session(session);
        if (!adv || !AdvanceRequest.RECOVERABLE_STATUSES.includes(adv.status)) continue;
        if (String(adv.employee) !== String(p.employee)) continue;   // never touch another worker's advance
        const bal = adv.remainingBalance != null ? adv.remainingBalance : adv.amount;
        if (bal <= 0) continue;
        const ask  = Number(w?.amount);
        const take = r2(Math.min(Number.isFinite(ask) && ask > 0 ? ask : bal, bal, budget));
        if (take <= 0) continue;
        adv.remainingBalance = r2(bal - take);
        if (adv.remainingBalance <= 0) {
          adv.deductedInPayroll = true;
          adv.status      = 'recovered';
          adv.recoveredAt = new Date();
        }
        await adv.save({ session });
        budget    = r2(budget - take);
        recovered = r2(recovered + take);
        recoveredRows.push({ advance: adv._id, amount: take, balance: adv.remainingBalance });
        p.advanceRecoveries.push({ advance: adv._id, amount: take });
        p.lineItems.push({
          label:  `${ledger.PAYMENT_RECOVERY_PREFIX} Rs.${take}${adv.remainingBalance > 0 ? ` (Rs.${adv.remainingBalance} still outstanding)` : ''}`,
          amount: -take,
          type:   'deduction',
        });
      }
      if (recoveredRows.length) {
        p.totalAdvanceDeduction = r2((p.totalAdvanceDeduction || 0) + recovered);
        p.markModified('advanceRecoveries');
        p.markModified('lineItems');
      }

      // Cash paid out — defaults to whatever is left after recoveries.
      const requested = req.body.amount != null ? Number(req.body.amount) : budget;
      if (!Number.isFinite(requested) || requested < 0) {
        out = { code: 400, body: { success: false, message: 'Payment amount must be a positive number' } };
        return;
      }
      const pay = r2(Math.min(requested, budget));
      if (pay <= 0 && recovered <= 0) {
        out = { code: 400, body: { success: false, message: 'Payment amount must be greater than 0' } };
        return;
      }

      p.amountPaid    = r2(alreadyPaid + pay + recovered);
      p.totalCashPaid = r2((p.totalCashPaid || 0) + pay);
      p.advanceRecoveredAtPayment = r2((p.advanceRecoveredAtPayment || 0) + recovered);
      p.status      = p.amountPaid >= (p.netPay || 0) ? 'paid' : 'partially_paid';
      p.paidAt      = new Date();
      p.paidBy      = req.user?.name || 'admin';
      if (paymentNote) p.paymentNote = paymentNote;
      // Record this payout so the slip carries a full payment history:
      // how much cash went out and how much was held back against advances.
      p.payouts.push({
        at: p.paidAt,
        cash: pay,
        advanceRecovered: recovered,
        total: r2(pay + recovered),
        paidBy: p.paidBy,
        note: paymentNote || '',
        advances: recoveredRows.map((rr) => ({ advance: rr.advance, amount: rr.amount })),
      });
      p.markModified('payouts');
      await p.save({ session });

      // ── Ledger (same transaction) ───────────────────────────────
      const who = req.user?.name || 'admin';
      // A slip paid straight from draft was only just finalized, so its
      // earnings/deductions still need posting.
      if (wasDraft) await postPayrollToLedger(p, session, who);
      await ledger.postPayment(p, { cash: pay, recovered, at: p.paidAt, postedBy: who }, session);
      // Advance recovered at payment time reduces what the worker owes.
      for (const rr of recoveredRows) {
        await LedgerEntry.create([{
          employee: p.employee, date: p.paidAt, kind: 'advance_recovered',
          amount: rr.amount, // +ve: cancels the negative advance_issued row
          label: `Advance recovered from ${MONTHS_PDF[(p.month || 1) - 1]} ${p.year} pay`,
          year: p.year, month: p.month,
          source: 'advance', sourceId: rr.advance, postedBy: who,
        }], { session });
      }

      await p.populate('employee', 'name');
      out = { code: 200, body: { success: true, data: p, cashPaid: pay, advanceRecovered: recovered } };
    });
    return res.status(out.code).json(out.body);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  } finally {
    await session.endSession();
  }
});

router.get('/advance', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const filter = {};
    if (req.query.employeeId) filter.employee = req.query.employeeId;
    if (req.query.status)     filter.status   = req.query.status;
    const advances = await AdvanceRequest.find(filter)
      .populate('employee', 'name department')
      .sort({ createdAt: -1 })
      .limit(+(req.query.limit || 100))
      .lean();
    res.json({ success: true, data: advances });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Admin/finance entry — record an advance GIVEN to any employee, born
// approved with its deduction month set (no separate approval step:
// the person entering it IS the approver). Distinct from the
// worker-facing POST /advance below, which creates a pending request.
router.post('/advance/admin-create', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { employee, amount, deductMonth, deductYear, reason = '' } = req.body;
    if (!employee || !amount)
      return res.status(400).json({ success: false, message: 'employee and amount required' });
    if (!deductMonth || !deductYear)
      return res.status(400).json({ success: false, message: 'deductMonth and deductYear required (which payroll month recovers it)' });
    const emp = await Employee.findById(employee, 'name').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    // Creating the advance and booking it to the ledger must be atomic —
    // cash handed over with no ledger row would silently under-state what
    // the worker owes back.
    const session = await mongoose.startSession();
    let adv;
    try {
      await session.withTransaction(async () => {
        // Admin/finance entry records cash handed over at the counter, so
        // it is born already paid out (approver and payer are the same act).
        const [created] = await AdvanceRequest.create([{
          employee, amount: +amount, reason,
          status: 'paid_out',
          deductMonth: +deductMonth, deductYear: +deductYear,
          approvedBy: req.user?.name || 'admin',
          approvedAt: new Date(),
          paidOutAt:  new Date(),
          paidOutBy:  req.user?.name || 'admin',
        }], { session });
        adv = created;
        await ledger.postAdvanceIssued(adv, session, { postedBy: req.user?.name || "admin" });
      });
    } finally { await session.endSession(); }
    res.status(201).json({ success: true, message: `Advance of ₹${adv.amount} recorded for ${emp.name}`, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Worker-facing — an authenticated employee can request an advance
// FOR THEMSELVES. Admins may request on behalf of anyone.
router.post('/advance', async (req, res) => {
  try {
    const { amount, reason = '' } = req.body;
    const employeeId = resolveEmployeeId(req);
    if (!employeeId)
      return res.status(403).json({ success: false, message: 'Cannot determine employee — your account has no linked employee' });
    if (!amount)
      return res.status(400).json({ success: false, message: 'amount required' });
    const emp = await Employee.findById(employeeId, 'name').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });

    const adv = await AdvanceRequest.create({ employee: employeeId, amount: +amount, reason });
    res.json({ success: true, message: `Advance request submitted for ${emp.name}`, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/advance/:id/approve', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { deductMonth, deductYear, adminNotes = '', approvedBy = 'admin' } = req.body;
    if (!deductMonth || !deductYear)
      return res.status(400).json({ success: false, message: 'deductMonth and deductYear required' });
    // Approval commits to the advance but no cash has moved yet, so nothing
    // is booked to the ledger until it is paid out (PUT /advance/:id/pay-out).
    const adv = await AdvanceRequest.findByIdAndUpdate(req.params.id, {
      $set: {
        status: 'approved', deductMonth: +deductMonth, deductYear: +deductYear,
        adminNotes, approvedBy, approvedAt: new Date(),
      },
    }, { new: true }).populate('employee', 'name');
    if (!adv) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: `Approved ₹${adv.amount} for ${adv.employee?.name}`, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// approved → paid_out. Hands the cash over: this is the moment the
// employee owes it back, so it is booked to their ledger here, atomically.
router.put('/advance/:id/pay-out', isAdmin('admin', 'accounts'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      const adv = await AdvanceRequest.findById(req.params.id).session(session);
      if (!adv) { out = { code: 404, body: { success: false, message: 'Not found' } }; return; }
      if (adv.status === 'paid_out' || adv.status === 'recovered') {
        out = { code: 400, body: { success: false, message: `Already paid out (${adv.status})` } }; return;
      }
      if (adv.status !== 'approved') {
        out = { code: 400, body: { success: false, message: `Approve before paying out (this one is ${adv.status})` } }; return;
      }
      adv.status    = 'paid_out';
      adv.paidOutAt = new Date();
      adv.paidOutBy = req.user?.name || 'admin';
      await adv.save({ session });
      await ledger.postAdvanceIssued(adv, session, { postedBy: adv.paidOutBy });
      await adv.populate('employee', 'name');
      out = { code: 200, body: { success: true, message: `Paid out ₹${adv.amount}`, data: adv } };
    });
    return res.status(out.code).json(out.body);
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  } finally { await session.endSession(); }
});

router.put('/advance/:id/reject', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const adv = await AdvanceRequest.findByIdAndUpdate(req.params.id, {
      $set: { status: 'rejected', adminNotes: req.body.adminNotes || '' },
    }, { new: true }).populate('employee', 'name');
    if (!adv) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: adv });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// NOTE: the flat 10%-of-net-pay "yearly bonus" was removed. The
// attendance-tiered bonus (api/bonus.js — BonusConfig/BonusRecord, the
// Diwali bonus with a per-employee editable %) is the single yearly-bonus
// system now, so there are no longer two competing sources of truth.

router.get('/analytics', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const year  = +(req.query.year  || new Date().getFullYear());
    const month = req.query.month ? +req.query.month : null;

    const filter = { year };
    if (month) filter.month = month;
    const payrolls = await Payroll.find(filter)
      .populate('employee', 'name department hourlyRate').lean();

    const empStats = {};
    for (const p of payrolls) {
      const id  = (p.employee?._id ?? p.employee).toString();
      const name = p.employee?.name ?? '–';
      const dept = p.employee?.department ?? '–';
      if (!empStats[id]) {
        empStats[id] = {
          employeeId: id, name, department: dept,
          hourlyRate: p.hourlyRate ?? 0,
          months: 0, totalShifts: 0, presentShifts: 0,
          absentShifts: 0, approvedLeaveShifts: 0,
          totalLateMinutes: 0, totalGross: 0, totalBonuses: 0,
          totalDeductions: 0, totalNetPay: 0, perfectMonths: 0,
          longestStreak: 0,
        };
      }
      const s = empStats[id];
      s.months++;
      s.totalShifts          += p.totalShifts         ?? 0;
      s.presentShifts        += p.presentShifts        ?? 0;
      s.absentShifts         += p.absentShifts         ?? 0;
      s.approvedLeaveShifts  += p.approvedLeaveShifts  ?? 0;
      s.totalLateMinutes     += p.totalLateMinutes     ?? 0;
      s.totalGross           += p.grossEarnings        ?? 0;
      s.totalBonuses         += p.totalBonuses         ?? 0;
      s.totalDeductions      += p.totalDeductions      ?? 0;
      s.totalNetPay          += p.netPay               ?? 0;
      if (p.perfectAttendance) s.perfectMonths++;
      if ((p.longestStreak ?? 0) > s.longestStreak) s.longestStreak = p.longestStreak;
    }

    const list = Object.values(empStats).map(s => ({
      ...s,
      attendanceRate: s.totalShifts > 0
        ? r2((s.presentShifts + s.approvedLeaveShifts) / s.totalShifts * 100) : 0,
      totalGross:      r2(s.totalGross),
      totalBonuses:    r2(s.totalBonuses),
      totalDeductions: r2(s.totalDeductions),
      totalNetPay:     r2(s.totalNetPay),
    }));

    list.sort((a, b) => b.attendanceRate - a.attendanceRate);
    list.forEach((item, i) => { item.rank = i + 1; });

    const totalPayout = r2(list.reduce((s, e) => s + e.totalNetPay, 0));
    const avgAttRate  = list.length
      ? r2(list.reduce((s, e) => s + e.attendanceRate, 0) / list.length) : 0;

    res.json({
      success: true, year, month: month ?? 'all',
      summary: { totalEmployees: list.length, totalPayout, avgAttendanceRate: avgAttRate },
      data:    list,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/attendance', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { employeeId, year, month } = req.query;
    if (!employeeId || !year || !month)
      return res.status(400).json({ success: false, message: 'employeeId, year and month are required' });

    const start = new Date(+year, +month - 1, 1);
    const end   = new Date(+year, +month,     0, 23, 59, 59, 999);

    const records = await Attendance.find({
      employee: employeeId,
      date: { $gte: start, $lte: end },
    }).sort({ date: 1, shift: 1 }).lean();

    const s = await PayrollSettings.findOne({}).lean() ?? {};
    const graceMinutes = s.overtimeGraceMinutes ?? 120;

    const days = records.map((r) => {
      const rawOt       = r.overtimeMinutes ?? 0;
      const billableOt  = Math.max(0, rawOt - graceMinutes);
      return {
        date:             new Date(r.date).toISOString().slice(0, 10),
        shift:            r.shift,
        status:           r.status,
        approvedLeave:    r.isApprovedLeave ?? false,
        lateMinutes:      r.lateMinutes   ?? 0,
        overtimeMinutes:  rawOt,
        billableOtMinutes: billableOt,
        hasOvertime:      rawOt > 0,
        overtimePaid:     billableOt > 0,
      };
    });

    const summary = {
      present:       days.filter(d => ['present','late'].includes(d.status) && !d.approvedLeave).length,
      absent:        days.filter(d => ['absent','on_leave'].includes(d.status) && !d.approvedLeave).length,
      halfDay:       days.filter(d => d.status === 'half_day').length,
      approvedLeave: days.filter(d => d.approvedLeave).length,
      overtime:      days.filter(d => d.hasOvertime).length,
      overtimePaid:  days.filter(d => d.overtimePaid).length,
      totalOtMinutes: days.reduce((s, d) => s + d.overtimeMinutes, 0),
    };

    res.json({ success: true, days, summary });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


// ══════════════════════════════════════════════════════════════
//  AUTO-GENERATE  (idempotent)
//  POST /auto-generate?period=YYYY-MM
//
//  Designed for unattended calls — from a future cron, from the
//  Flutter AIAdvisor on the 1st of the month, or from a manual
//  retry. Safe to call repeatedly.
//
//  Decision tree:
//    1. period defaults to LAST completed month (so calling on
//       Jun 1 generates May's payroll, which is what the user
//       actually wants).
//    2. If every active operator already has a Payroll row for
//       the period → reason: ALREADY_GENERATED, triggered: false.
//    3. Else compute attendance completeness for the period:
//         coveredDays / (employees × workingDays).
//       If < 0.9 → reason: ATTENDANCE_INCOMPLETE.
//    4. Else run the same per-employee computePayroll loop the
//       existing /generate uses. Re-runs only employees who don't
//       yet have a payroll row (so a partial prior run can finish
//       cleanly on retry).
// ══════════════════════════════════════════════════════════════
router.post('/auto-generate', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    // Default to the last completed month so the typical "1st of
    // the month" trigger does the right thing without the client
    // having to subtract.
    let year, month;
    const period = (req.query.period || req.body?.period || '').trim();
    if (period) {
      const m = period.match(/^(\d{4})-(\d{2})$/);
      if (!m) return res.status(400).json({
        success: false, message: 'period must be YYYY-MM',
      });
      year = +m[1]; month = +m[2];
    } else {
      const now  = new Date();
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      year  = prev.getFullYear();
      month = prev.getMonth() + 1;
    }

    const empIds = (await Employee
      .find({ hourlyRate: { $gt: 0 } }, '_id')
      .lean()).map((e) => e._id.toString());

    if (empIds.length === 0) {
      return res.json({
        success: false,
        triggered: false,
        reason: 'NO_ACTIVE_EMPLOYEES',
        period: `${year}-${String(month).padStart(2, '0')}`,
      });
    }

    // Already-generated check: count existing payroll rows in scope.
    const existing = await Payroll.find(
      { year, month, employee: { $in: empIds } },
      '_id employee'
    ).lean();

    if (existing.length >= empIds.length) {
      return res.json({
        success: true,
        triggered: false,
        reason: 'ALREADY_GENERATED',
        period: `${year}-${String(month).padStart(2, '0')}`,
        existingCount: existing.length,
      });
    }

    // Completeness gate. Working days = distinct dates in the period
    // that have at least one attendance record (same heuristic as
    // /repeatedly-unmarked, keeps us off a hardcoded holiday model).
    const periodStart = new Date(year, month - 1, 1);
    const periodEnd   = new Date(year, month, 1);
    const att = await Attendance.find({
      date: { $gte: periodStart, $lt: periodEnd },
      employee: { $in: empIds },
    }).select('employee date').lean();

    const dayKey      = (d) => new Date(d).toISOString().slice(0, 10);
    const workingDays = new Set(att.map((r) => dayKey(r.date)));
    const denom       = empIds.length * workingDays.size;
    const completenessPct = denom > 0
      ? Math.round((att.length / denom) * 100)
      : 0;

    if (workingDays.size === 0 || completenessPct < 90) {
      return res.json({
        success: true,
        triggered: false,
        reason: 'ATTENDANCE_INCOMPLETE',
        period: `${year}-${String(month).padStart(2, '0')}`,
        completenessPct,
      });
    }

    // Run only employees that don't yet have a row — supports
    // resuming a partial prior run.
    const haveRow = new Set(existing.map((p) => String(p.employee)));
    const todo    = empIds.filter((id) => !haveRow.has(id));

    const results = [], errors = [];
    for (const id of todo) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const data   = await computePayroll(id, year, month);
          const advIds = data._advanceIds || [];
          delete data._advanceIds;

          await Payroll.findOneAndUpdate(
            { employee: id, year, month },
            { $set: data },
            { upsert: true, new: true, session }
          );

          if (advIds.length) {
            await AdvanceRequest.updateMany(
              { _id: { $in: advIds }, deductedInPayroll: { $ne: true } },
              { $set: { deductedInPayroll: true } },
              { session }
            );
          }

          results.push({ employeeId: id, netPay: data.netPay });
        });
      } catch (err) {
        errors.push({ employeeId: id, error: err.message });
      } finally {
        await session.endSession();
      }
    }

    return res.json({
      success: true,
      triggered: true,
      period: `${year}-${String(month).padStart(2, '0')}`,
      completenessPct,
      result: {
        generated:       results.length,
        skippedExisting: existing.length,
        errors:          errors.length ? errors : undefined,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /outstanding-advances
//  Approved advances whose deduct month/year has already passed
//  but `deductedInPayroll` is still false — payroll either didn't
//  run for that period or skipped them. Powers the AIAdvisor
//  card pointing back at the payroll module so the admin can
//  re-run / investigate.
// ══════════════════════════════════════════════════════════════
router.get('/outstanding-advances', isAdmin('admin', 'accounts'), async (_req, res) => {
  try {
    const now = new Date();
    const curYear  = now.getFullYear();
    const curMonth = now.getMonth() + 1;

    const advances = await AdvanceRequest.find({
      status: 'approved',
      deductedInPayroll: false,
      // deductYear/deductMonth strictly earlier than current period.
      // Note: an advance approved for current month is not "overdue"
      // until next month — current-period skips might be a payroll
      // not yet run, not a missed deduction.
      $or: [
        { deductYear: { $lt: curYear } },
        { deductYear: curYear, deductMonth: { $lt: curMonth } },
      ],
    })
      .populate('employee', 'name department')
      .sort({ deductYear: 1, deductMonth: 1 })
      .lean();

    const out = advances
      .filter((a) => a.deductYear && a.deductMonth)
      .map((a) => {
        const monthsOverdue =
          (curYear - a.deductYear) * 12 + (curMonth - a.deductMonth);
        return {
          advanceId:    a._id,
          employeeId:   a.employee?._id ?? a.employee,
          name:         a.employee?.name ?? '—',
          department:   a.employee?.department ?? '',
          amount:       a.amount,
          deductMonth:  a.deductMonth,
          deductYear:   a.deductYear,
          monthsOverdue,
        };
      });

    const totalAmount = out.reduce((s, a) => s + (a.amount || 0), 0);

    return res.json({
      success:     true,
      advances:    out,
      count:       out.length,
      totalAmount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Exported for characterization/unit tests (Phase B0.4) — the pure
// read-only pay computation the /generate routes build on.
// ── EMPLOYEE PAYROLL OVERVIEW ─────────────────────────────────
// GET /employee-overview/:empId?year=&month=
// One call backing the employee detail page's pay section: shift
// rates, the month's computed payroll (attendance counts, earnings,
// bonuses, deductions, net), the employee's production output, and
// their wastage entries for the month. Read-only — nothing is saved.
router.get('/employee-overview/:empId', isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const empId = req.params.empId;
    const now   = new Date();
    const year  = +(req.query.year  || now.getFullYear());
    const month = +(req.query.month || now.getMonth() + 1);
    if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 2100))
      return res.status(400).json({ success: false, message: 'Invalid year/month' });

    const emp = await Employee.findById(empId, 'name department role skill hourlyRate').lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const rate = emp.hourlyRate ?? 0;

    const start = new Date(year, month - 1, 1);
    const end   = new Date(year, month, 0, 23, 59, 59, 999);

    const [payroll, prodAgg, wastage] = await Promise.all([
      computePayroll(empId, year, month),
      ShiftDetail.aggregate([
        {
          $match: {
            employee: new mongoose.Types.ObjectId(String(empId)),
            date: { $gte: start, $lte: end },
          },
        },
        {
          $group: {
            _id: null,
            totalMeters: { $sum: { $ifNull: ['$productionMeters', 0] } },
            shifts:      { $sum: 1 },
          },
        },
      ]),
      Wastage.find({ employee: empId, createdAt: { $gte: start, $lte: end } })
        .select('reason penalty meters weight type createdAt')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
    ]);

    // internal handle for /generate — not for clients.
    delete payroll._advanceRecoveries;

    res.json({
      success: true,
      data: {
        employee: {
          id: emp._id, name: emp.name, department: emp.department,
          role: emp.role ?? '', hourlyRate: rate,
        },
        // DAY and NIGHT are both 12h shifts (see services/payrollService.js).
        shiftRates: { DAY: r2(rate * 12), NIGHT: r2(rate * 12) },
        period: { year, month },
        payroll,
        production: {
          totalMeters: r2(prodAgg[0]?.totalMeters ?? 0),
          shifts:      prodAgg[0]?.shifts ?? 0,
        },
        wastage: {
          entries: wastage,
          totalPenalty: r2(wastage.reduce((s, w) => s + (w.penalty || 0), 0)),
        },
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.computePayroll = computePayroll;

module.exports = router;
