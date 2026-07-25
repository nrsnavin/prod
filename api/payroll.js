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
const { isAuthenticated, isAdmin, selfOrAdmin, requireFeature } = require('../middleware/auth');
const { EMPLOYEE_CARD_FIELDS } = require('../utils/populateFields');
const { resolveEmployeeId } = require('../utils/resolveEmployee');
// The ~200-line pure pay computation lives in services/payrollService.js.
// Re-exported below (router.computePayroll) so existing callers/tests
// that reach it via the payroll router keep working.
const { computePayroll } = require('../services/payrollService');

router.use(isAuthenticated);
// Per-user feature gate (writes only). The worker self-service advance
// request (POST /advance) is exempt — an employee requests their own
// advance without holding the /payroll management feature.
router.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/advance') return next();
  return requireFeature('/payroll')(req, res, next);
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
        { employee: id, year: +year, month: +month }, 'status'
      ).lean();
      if (existing && ['finalized', 'paid'].includes(existing.status)) {
        errors.push({ employeeId: id, error: `Payroll already ${existing.status} — not regenerated` });
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
        perfectAttendance: p.perfectAttendance,
        status:          p.status,
      })).sort((a,b) => b.netPay - a.netPay),
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Worker-facing — employees view their own payslip.
// selfOrAdmin blocks one worker from reading another's slip by id swap.
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

    // ── Minimal, margin-respecting payslip ─────────────────────
    const M = 56;                              // uniform page margin
    const doc = new PDFDocument({ size: 'A4', margin: M });
    doc.pipe(res);

    const W        = doc.page.width;
    const H        = doc.page.height;
    const RIGHT    = W - M;                     // right content edge
    const CW       = W - 2 * M;                 // content width
    const AMT_W    = 130;                       // amount column width
    const AMT_X    = RIGHT - AMT_W;             // amount column left edge

    // Restrained, mostly-monochrome palette.
    const INK   = '#1F2430';
    const MUTE  = '#8A909C';
    const FAINT = '#B4B9C4';
    const LINE  = '#E4E6EC';
    const NEG   = '#B42318';                    // deduction amounts only

    // pdfkit's built-in Helvetica is WinAnsi-only: strip emoji / non-Latin1
    // glyphs and spell ₹ as "Rs." so nothing renders as a blank box.
    const clean = (s) => String(s ?? '')
      .replace(/₹\s?/g, 'Rs. ')
      .replace(/[^\x20-\xFF]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const rule = (yy, color = LINE, lw = 0.75) => {
      doc.moveTo(M, yy).lineTo(RIGHT, yy).lineWidth(lw).strokeColor(color).stroke();
    };
    const label = (text, x, y, w) =>
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTE)
         .text(String(text).toUpperCase(), x, y, { width: w, characterSpacing: 0.8 });

    // ── Header ─────────────────────────────────────────────────
    let y = M;
    doc.font('Helvetica-Bold').fontSize(19).fillColor(INK)
       .text('Payslip', M, y, { characterSpacing: 0.3 });
    doc.font('Helvetica').fontSize(10.5).fillColor(MUTE)
       .text(`${MONTHS_PDF[month - 1]} ${year}`, M, y + 26);
    // Status, top-right, quiet.
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(FAINT)
       .text((p.status || 'draft').toUpperCase(), AMT_X, y + 6, { width: AMT_W, align: 'right', characterSpacing: 1 });
    y += 52;
    rule(y);
    y += 22;

    // ── Employee meta (two columns) ────────────────────────────
    const shiftsLine = `${p.presentShifts ?? 0} present · ${p.absentShifts ?? 0} absent · ${p.approvedLeaveShifts ?? 0} leave`;
    const colW = CW / 2 - 8;
    const colX2 = M + CW / 2 + 8;
    const metaCell = (x, w, lab, val) => {
      label(lab, x, y, w);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
         .text(String(val), x, y + 11, { width: w });
    };
    metaCell(M, colW, 'Employee', p.employee?.name || '—');
    metaCell(colX2, colW, 'Department', p.employee?.department || '—');
    y += 38;
    metaCell(M, colW, 'Hourly rate', rupee(p.hourlyRate));
    metaCell(colX2, colW, 'Shifts', shiftsLine);
    y += 44;

    // ── Earnings & deductions ──────────────────────────────────
    label('Earnings & deductions', M, y);
    y += 16;
    rule(y);
    y += 12;
    doc.fontSize(10);
    for (const li of p.lineItems || []) {
      if (y > H - 150) { doc.addPage(); y = M; }
      const neg = li.amount < 0;
      doc.font('Helvetica').fontSize(10).fillColor(INK)
         .text(clean(li.label), M, y, { width: AMT_X - M - 12 });
      doc.font('Helvetica').fontSize(10).fillColor(neg ? NEG : INK)
         .text(`${neg ? '- ' : ''}${rupee(Math.abs(li.amount))}`, AMT_X, y, { width: AMT_W, align: 'right' });
      y += 17;
    }

    // ── Summary ────────────────────────────────────────────────
    y += 6;
    rule(y);
    y += 14;
    const sumRow = (lab, val) => {
      doc.font('Helvetica').fontSize(10).fillColor(MUTE).text(lab, M, y, { width: AMT_X - M - 12 });
      doc.font('Helvetica').fontSize(10).fillColor(INK).text(rupee(val), AMT_X, y, { width: AMT_W, align: 'right' });
      y += 17;
    };
    sumRow('Gross earnings', p.grossEarnings);
    sumRow('Total bonuses', p.totalBonuses);
    sumRow('Total deductions', p.totalDeductions);
    if (p.totalAdvanceDeduction)
      sumRow('   incl. advance recovery', p.totalAdvanceDeduction);

    // ── Net pay box ────────────────────────────────────────────
    y += 10;
    const boxH = 58;
    if (y > H - boxH - 70) { doc.addPage(); y = M; }
    doc.lineWidth(0.75);
    doc.roundedRect(M, y, CW, boxH, 6).fillAndStroke('#FAFBFC', LINE);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTE)
       .text('NET PAY', M + 18, y + 22, { characterSpacing: 1.2 });
    doc.font('Helvetica-Bold').fontSize(21).fillColor(INK)
       .text(rupee(p.netPay), AMT_X - 18, y + 17, { width: AMT_W, align: 'right' });

    // ── Footer ─────────────────────────────────────────────────
    const footY = H - 54;
    rule(footY, LINE, 0.5);
    doc.font('Helvetica').fontSize(8).fillColor(FAINT)
       .text('System-generated payslip · Contact your supervisor for any queries.', M, footY + 10, { width: CW });
    doc.font('Helvetica').fontSize(8).fillColor(FAINT)
       .text(`Generated ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`,
             AMT_X, footY + 10, { width: AMT_W, align: 'right' });
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

    // Unpaid salary left = net pay on every non-'paid' payslip.
    const agg = await Payroll.aggregate([
      { $match: { employee: new mongoose.Types.ObjectId(empId), status: { $ne: 'paid' } } },
      { $group: { _id: null, total: { $sum: '$netPay' }, count: { $sum: 1 } } },
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
    if (adv.remainingBalance <= 0) adv.deductedInPayroll = true;
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
      if (p.status === 'draft') await finalizeDraft(p, session);

      const alreadyPaid = r2(p.amountPaid || 0);
      const remaining   = r2(Math.max(0, (p.netPay || 0) - alreadyPaid));
      // Default to clearing the balance; otherwise pay the requested amount,
      // capped at what's still owed (never overpay the slip).
      const requested = req.body.amount != null ? Number(req.body.amount) : remaining;
      if (!Number.isFinite(requested) || requested <= 0) {
        out = { code: 400, body: { success: false, message: 'Payment amount must be greater than 0' } };
        return;
      }
      const pay = r2(Math.min(requested, remaining));
      if (pay <= 0) { out = { code: 400, body: { success: false, message: 'Nothing left to pay' } }; return; }

      p.amountPaid  = r2(alreadyPaid + pay);
      p.status      = p.amountPaid >= (p.netPay || 0) ? 'paid' : 'partially_paid';
      p.paidAt      = new Date();
      p.paidBy      = req.user?.name || 'admin';
      if (paymentNote) p.paymentNote = paymentNote;
      await p.save({ session });
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

    const adv = await AdvanceRequest.create({
      employee, amount: +amount, reason,
      status: 'approved',
      deductMonth: +deductMonth, deductYear: +deductYear,
      approvedBy: req.user?.name || 'admin',
      approvedAt: new Date(),
    });
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
