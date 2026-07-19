// ══════════════════════════════════════════════════════════════
//  LEAVE REQUEST ROUTES
//  File: routes/leave.js
//  Mount: app.use('/api/v2/leave', require('./routes/leave'));
//
//  POST   /request          — employee submits leave request (AUTH)
//  GET    /pending          — all pending requests (ADMIN)
//  GET    /employee/:empId  — leave history for one employee (AUTH)
//  PUT    /:id/approve      — admin approves (ADMIN)
//  PUT    /:id/reject       — admin rejects (ADMIN)
//  DELETE /:id              — employee cancels pending request (AUTH)
// ══════════════════════════════════════════════════════════════
'use strict';
const express      = require('express');
const router       = express.Router();
const LeaveRequest = require('../models/LeaveRequest');
const Attendance   = require('../models/Attendence.js');
const ShiftDetail  = require('../models/ShiftDetail');
const Employee     = require('../models/Employee');
const { isAuthenticated, isAdmin, selfOrAdmin } = require('../middleware/auth');
const { resolveEmployeeId } = require('../utils/resolveEmployee');

function toISODate(d)   { return new Date(d).toISOString().split('T')[0]; }
function toDateLabel(d) {
  return new Date(d).toLocaleDateString('en-IN',
    { day:'2-digit', month:'short', year:'numeric' });
}

function fmtLeave(l) {
  return {
    id:               l._id,
    employeeId:       l.employee?._id ?? l.employee,
    employeeName:     l.employee?.name       ?? '–',
    employeeDept:     l.employee?.department ?? '–',
    date:             toISODate(l.date),
    dateLabel:        toDateLabel(l.date),
    shift:            l.shift,
    leaveType:        l.leaveType,
    reason:           l.reason,
    documentUrl:      l.documentUrl,
    status:           l.status,
    reviewedBy:       l.reviewedBy,
    reviewedAt:       l.reviewedAt,
    reviewNotes:      l.reviewNotes,
    payrollProcessed: l.payrollProcessed,
    createdAt:        l.createdAt,
  };
}

// ─────────────────────────────────────────────────────────────
// POST /request
// ─────────────────────────────────────────────────────────────
router.post('/request', isAuthenticated, async (req, res) => {
  try {
    const { date, shift='DAY', leaveType, reason, documentUrl='' } = req.body;
    // Workers submit leave for themselves; admins may submit for anyone.
    const employeeId = resolveEmployeeId(req);
    if (!employeeId)
      return res.status(403).json({ success:false,
        message:'Cannot determine employee — your account has no linked employee' });
    if (!date || !leaveType || !reason)
      return res.status(400).json({ success:false,
        message:'date, leaveType, reason are required.' });

    const emp = await Employee.findById(employeeId, 'name department').lean();
    if (!emp) return res.status(404).json({ success:false, message:'Employee not found.' });

    const dateObj = new Date(date);
    if (Number.isNaN(dateObj.getTime())) {
      return res.status(400).json({ success:false,
        message:'date is not a valid date.' });
    }
    dateObj.setHours(0,0,0,0);

    const leave = await LeaveRequest.create({
      employee: employeeId,
      date: dateObj,
      shift: shift.toUpperCase(),
      leaveType, reason, documentUrl,
    });

    return res.status(201).json({
      success: true,
      message: 'Leave request submitted. Pending admin approval.',
      data: fmtLeave({ ...leave.toObject(), employee: emp }),
    });
  } catch(err) {
    if (err.code === 11000)
      return res.status(409).json({ success:false,
        message:'A leave request already exists for this date and shift.' });
    console.error('[POST /request]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /pending
// ─────────────────────────────────────────────────────────────
router.get('/pending', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const leaves = await LeaveRequest.find({ status:'pending' })
      .populate('employee','name department skill role')
      .sort({ date:1 }).lean();
    return res.json({ success:true, count:leaves.length, data:leaves.map(fmtLeave) });
  } catch(err) {
    console.error('[GET /pending]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /employee/:empId
// ─────────────────────────────────────────────────────────────
// selfOrAdmin: a worker could otherwise read another worker's
// leave history by swapping :empId.
router.get('/employee/:empId', isAuthenticated, selfOrAdmin, async (req, res) => {
  try {
    const { empId } = req.params;
    const { year, month } = req.query;
    const filter = { employee: empId };
    if (year && month) {
      const start = new Date(Number(year), Number(month)-1, 1);
      const end   = new Date(Number(year), Number(month),   0, 23,59,59,999);
      filter.date = { $gte: start, $lte: end };
    }
    const leaves = await LeaveRequest.find(filter)
      .populate('employee','name department')
      .sort({ date:-1 }).lean();
    return res.json({ success:true, count:leaves.length, data:leaves.map(fmtLeave) });
  } catch(err) {
    console.error('[GET /employee]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /:id/approve
// ─────────────────────────────────────────────────────────────
router.put('/:id/approve', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { reviewNotes='' } = req.body;
    const leave = await LeaveRequest.findById(req.params.id)
      .populate('employee','name department');
    if (!leave) return res.status(404).json({ success:false, message:'Leave request not found.' });
    if (leave.status !== 'pending')
      return res.status(400).json({ success:false, message:`Request already ${leave.status}.` });

    leave.status     = 'approved';
    // Server-trusted reviewer — drop the body-supplied default to prevent spoofing.
    leave.reviewedBy = req.user?._id || null;
    leave.reviewedAt = new Date();
    leave.reviewNotes= reviewNotes;
    await leave.save();

    // Auto-update linked Attendance record if it exists
    const dateObj = new Date(leave.date); dateObj.setHours(0,0,0,0);
    const shiftsToUpdate = leave.shift === 'BOTH' ? ['DAY','NIGHT'] : [leave.shift];
    for (const s of shiftsToUpdate) {
      await Attendance.findOneAndUpdate(
        { employee: leave.employee._id, date: dateObj, shift: s },
        { $set: {
          status:          'on_leave',
          leaveType:       leave.leaveType,
          leaveRequestId:  leave._id,
          isApprovedLeave: true,
        }},
        { upsert: false }
      );
    }

    return res.json({ success:true, message:'Leave approved.', data:fmtLeave(leave) });
  } catch(err) {
    console.error('[PUT /approve]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /:id/reject
// ─────────────────────────────────────────────────────────────
router.put('/:id/reject', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { reviewNotes='' } = req.body;
    const leave = await LeaveRequest.findById(req.params.id)
      .populate('employee','name department');
    if (!leave) return res.status(404).json({ success:false, message:'Leave request not found.' });
    if (leave.status !== 'pending')
      return res.status(400).json({ success:false, message:`Request already ${leave.status}.` });

    leave.status     = 'rejected';
    leave.reviewedBy = req.user?._id || null;
    leave.reviewedAt = new Date();
    leave.reviewNotes= reviewNotes;
    await leave.save();

    return res.json({ success:true, message:'Leave rejected.', data:fmtLeave(leave) });
  } catch(err) {
    console.error('[PUT /reject]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// DELETE /:id  — employee cancels pending request
// ─────────────────────────────────────────────────────────────
router.delete('/:id', isAuthenticated, async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return res.status(404).json({ success:false, message:'Not found.' });
    if (leave.status !== 'pending')
      return res.status(400).json({ success:false, message:'Only pending requests can be cancelled.' });
    await leave.deleteOne();
    return res.json({ success:true, message:'Leave request cancelled.' });
  } catch(err) {
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /conflicts
// Approved leaves whose [startDate, endDate] overlaps a
// non-closed shift for the same employee. Powers the AIAdvisor
// "schedule conflict" card on the admin dashboard.
// ─────────────────────────────────────────────────────────────
router.get('/conflicts', isAuthenticated, isAdmin('admin', 'accounts'), async (_req, res) => {
  try {
    // We only care about leaves that haven't yet finished — historical
    // overlaps are noise.
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const leaves = await LeaveRequest.find({
      status:  'approved',
      endDate: { $gte: today },
    })
      .populate('employee', 'name')
      .lean();

    const conflicts = [];
    for (const lv of leaves) {
      if (!lv.employee) continue;
      const shift = await ShiftDetail.findOne({
        employee: lv.employee._id,
        date:     { $gte: lv.startDate, $lte: lv.endDate },
        status:   { $in: ['open', 'running', 'pending_verification'] },
      }).select('_id date shift status').lean();

      if (shift) {
        conflicts.push({
          leaveId:      lv._id,
          employeeId:   lv.employee._id,
          employeeName: lv.employee.name,
          leaveStart:   lv.startDate,
          leaveEnd:     lv.endDate,
          shiftId:      shift._id,
          shiftDate:    shift.date,
          shiftType:    shift.shift,
          shiftStatus:  shift.status,
        });
      }
    }

    return res.json({
      success: true,
      conflicts,
      count: conflicts.length,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
