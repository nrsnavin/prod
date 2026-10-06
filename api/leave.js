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
const mongoose     = require('mongoose');
const router       = express.Router();
const LeaveRequest = require('../models/LeaveRequest');
const Attendance   = require('../models/Attendence.js');
const ShiftDetail  = require('../models/ShiftDetail');
const Employee     = require('../models/Employee');
const { isAuthenticated, isAdmin, selfOrAdmin, requireFeature, requireFeatureRead } = require('../middleware/auth');
const { resolveEmployeeId } = require('../utils/resolveEmployee');
const { validate, fields: { text, objectId }, z } = require('../middleware/validate');

// A worker's own request (middleware/validate.js). The shift is matched
// whatever its case, as the handler always has; anything that isn't text
// used to crash .toUpperCase() with a 500.
const LEAVE_REQUEST = z.object({
  date: text(40).optional(),
  shift: z.string().max(10).transform((v) => v.toUpperCase())
    .pipe(z.enum(['DAY', 'NIGHT', 'BOTH'], { errorMap: () => ({ message: 'must be DAY, NIGHT or BOTH' }) }))
    .optional(),
  leaveType: z.enum(['casual', 'sick', 'unpaid'], { errorMap: () => ({ message: 'must be casual, sick or unpaid' }) }).optional(),
  reason: text(500).optional(),
  documentUrl: text(500).optional(),
  employeeId: objectId.optional(), // admins only; resolveEmployeeId ignores it for anyone else
});

// Per-user feature gate. Worker self-service is exempt from writes:
// submitting your own request (POST /request) and cancelling your own
// pending request (DELETE /:id) don't need the /leave management feature.
// GET /employee/:empId is selfOrAdmin and exempt from the read gate for
// the same reason — a worker's own leave history is answerable to their
// identity, not to whether the admin ticked their Leave checkbox.
// (req.user is set by the mount-level isAuthenticated in app.js.)
router.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/request') return next();
  if (req.method === 'DELETE') return next();
  if ((req.method === 'GET' || req.method === 'HEAD') && req.path.startsWith('/employee/')) return next();
  requireFeature('/leave')(req, res, (err) => {
    if (err) return next(err);
    requireFeatureRead('/leave')(req, res, next);
  });
});

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
router.post('/request', isAuthenticated, validate({ body: LEAVE_REQUEST }), async (req, res) => {
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
// POST /admin-request — admin creates a leave request FOR any
// employee (unlike /request, which is self-only). Pass
// autoApprove:true to create it already approved (and sync the
// employee's attendance, mirroring the /:id/approve route).
// ─────────────────────────────────────────────────────────────
router.post('/admin-request', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const {
      employeeId, date, shift='BOTH', leaveType, reason,
      documentUrl='', autoApprove=false,
    } = req.body;

    if (!employeeId || !date || !leaveType || !reason)
      return res.status(400).json({ success:false,
        message:'employeeId, date, leaveType, reason are required.' });

    const emp = await Employee.findById(employeeId, 'name department').lean();
    if (!emp) return res.status(404).json({ success:false, message:'Employee not found.' });

    const dateObj = new Date(date);
    if (Number.isNaN(dateObj.getTime()))
      return res.status(400).json({ success:false, message:'date is not a valid date.' });
    dateObj.setHours(0,0,0,0);

    const doc = {
      employee: employeeId,
      date: dateObj,
      shift: String(shift).toUpperCase(),
      leaveType, reason, documentUrl,
    };
    if (autoApprove) {
      doc.status      = 'approved';
      doc.reviewedBy  = req.user?._id || null;
      doc.reviewedAt  = new Date();
      doc.reviewNotes = 'Created & approved by admin';
    }

    const leave = await LeaveRequest.create(doc);

    // On auto-approve, update any existing Attendance rows to on_leave —
    // same semantics as PUT /:id/approve (upsert:false).
    if (autoApprove) {
      const shiftsToUpdate = leave.shift === 'BOTH' ? ['DAY','NIGHT'] : [leave.shift];
      for (const s of shiftsToUpdate) {
        await Attendance.findOneAndUpdate(
          { employee: leave.employee, date: dateObj, shift: s },
          { $set: {
            status:          'on_leave',
            leaveType:       leave.leaveType,
            leaveRequestId:  leave._id,
            isApprovedLeave: true,
          }},
          { upsert: false }
        );
      }
    }

    return res.status(201).json({
      success: true,
      message: autoApprove
        ? 'Leave created and approved.'
        : 'Leave request created. Pending approval.',
      data: fmtLeave({ ...leave.toObject(), employee: emp }),
    });
  } catch(err) {
    if (err.code === 11000)
      return res.status(409).json({ success:false,
        message:'A leave request already exists for this date and shift.' });
    console.error('[POST /admin-request]', err);
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
/**
 * Approve or reject a request, only while it is still pending: the
 * check and the write in one operation. Read-then-save let two admins
 * act on one request at once; both passed the "pending" check and the
 * later one overwrote the first, so a leave could end up rejected with
 * its attendance already marked as approved leave. Returns the decided
 * request, or null when it was not pending (or does not exist).
 */
function decidePending(id, status, reviewer, reviewNotes, session = null) {
  return LeaveRequest.findOneAndUpdate(
    { _id: id, status: 'pending' },
    { $set: { status, reviewedBy: reviewer || null, reviewedAt: new Date(), reviewNotes } },
    { new: true, session }
  ).populate('employee', 'name department');
}

/** Why a decision did not apply: gone, or already decided. */
async function notPending(id, res) {
  const existing = await LeaveRequest.findById(id).select('status').lean();
  if (!existing) return res.status(404).json({ success:false, message:'Leave request not found.' });
  return res.status(400).json({ success:false, message:`Request already ${existing.status}.` });
}

router.put('/:id/approve', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    // The HR page sends this as `note`; accept either so the
    // reviewer's note is actually recorded instead of silently dropped.
    const reviewNotes = req.body?.reviewNotes ?? req.body?.note ?? '';
    // The decision and the attendance it marks, together: a leave
    // approved with its attendance left unmarked (or the reverse) is the
    // kind of half-state a payroll run trips over.
    let leave;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Server-trusted reviewer — drop the body-supplied default to prevent spoofing.
        leave = await decidePending(req.params.id, 'approved', req.user?._id, reviewNotes, session);
        if (!leave) return;

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
            { upsert: false, session }
          );
        }
      });
    } finally {
      await session.endSession();
    }
    if (!leave) return notPending(req.params.id, res);

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
    // The HR page sends this as `note`; accept either so the
    // reviewer's note is actually recorded instead of silently dropped.
    const reviewNotes = req.body?.reviewNotes ?? req.body?.note ?? '';
    const leave = await decidePending(req.params.id, 'rejected', req.user?._id, reviewNotes);
    if (!leave) return notPending(req.params.id, res);

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

    // Cancel YOUR OWN request only. This route is deliberately exempt
    // from the feature gate (cancelling is self-service), so without an
    // ownership test any logged-in worker could delete any colleague's
    // pending leave just by guessing the id — silently, and with no
    // audit trail. admin/accounts administer leave for everyone.
    const isAdminRole = req.user?.role === 'admin' || req.user?.role === 'accounts';
    const isOwner = req.user?.employee &&
      String(req.user.employee) === String(leave.employee);
    if (!isAdminRole && !isOwner) {
      return res.status(403).json({
        success:false, message:'Forbidden — you can only cancel your own leave requests.',
      });
    }

    // Deleted only while still pending, in the one operation: an approval
    // landing between the check and the delete must not be erased.
    const gone = await LeaveRequest.deleteOne({ _id: leave._id, status: 'pending' });
    if (gone.deletedCount !== 1)
      return res.status(400).json({ success:false, message:'Only pending requests can be cancelled.' });
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

    // Leave is a single date + shift, so an upcoming leave is one whose
    // date is today or later. This used to filter and match on
    // startDate/endDate, which no leave has ever carried — the endpoint
    // could only ever return an empty list.
    const leaves = await LeaveRequest.find({
      status: 'approved',
      date:   { $gte: today },
    })
      .populate('employee', 'name')
      .lean();

    // One indexed lookup for every employee/date pair at once, rather
    // than a findOne per leave inside the loop.
    const openShifts = leaves.length === 0 ? [] : await ShiftDetail.find({
      employee: { $in: leaves.map((lv) => lv.employee?._id).filter(Boolean) },
      date:     { $in: leaves.map((lv) => lv.date) },
      status:   { $in: ['open', 'running', 'pending_verification'] },
    }).select('_id employee date shift status').lean();

    const shiftKey = (emp, date) => `${String(emp)}|${new Date(date).toISOString().slice(0, 10)}`;
    const shiftsByKey = new Map();
    for (const s of openShifts) {
      const k = shiftKey(s.employee, s.date);
      if (!shiftsByKey.has(k)) shiftsByKey.set(k, s);
    }

    const conflicts = [];
    for (const lv of leaves) {
      if (!lv.employee) continue;
      const shift = shiftsByKey.get(shiftKey(lv.employee._id, lv.date));
      if (shift) {
        conflicts.push({
          leaveId:      lv._id,
          employeeId:   lv.employee._id,
          employeeName: lv.employee.name,
          leaveDate:    lv.date,
          leaveShift:   lv.shift,
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
