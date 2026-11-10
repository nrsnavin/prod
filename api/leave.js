// ══════════════════════════════════════════════════════════════
//  LEAVE REQUEST ROUTES
//  File: routes/leave.js
//  Mount: app.use('/api/v2/leave', require('./routes/leave'));
//
//  POST   /request          — employee submits leave request (AUTH)
//  POST   /admin-request    — the office raises one for anybody (ADMIN)
//  GET    /pending          — all pending requests (ADMIN)
//  GET    /all              — requests by status and month (ADMIN)
//  GET    /employee/:empId  — leave history for one employee (AUTH)
//  PUT    /:id/approve      — admin approves (ADMIN)
//  PUT    /:id/reject       — admin rejects (ADMIN)
//  PUT    /:id/withdraw     — an approval taken back (ADMIN)
//  DELETE /:id              — employee cancels pending request (AUTH)
// ══════════════════════════════════════════════════════════════
'use strict';
const factoryDay = require('../utils/factoryDay');
const express      = require('express');
const { sendError } = require('../utils/routeError');
const ErrorHandler = require('../utils/ErrorHandler');
const mongoose     = require('mongoose');
const router       = express.Router();
const LeaveRequest = require('../models/LeaveRequest');
const ShiftDetail  = require('../models/ShiftDetail');
const { markLeaveApproved, unmarkLeaveWithdrawn, payslipClosed } = require('../services/attendanceMarks');
const { monthOf, monthRange } = require('../utils/periods');
const Employee     = require('../models/Employee');
const { isAuthenticated, isAdmin, selfOrAdmin } = require('../middleware/auth');
const { resolveEmployeeId } = require('../utils/resolveEmployee');
const { ownRecordsOr } = require('../middleware/ownRecords');
const { validate, fields: { text, objectId }, z } = require('../middleware/validate');

// A worker's own request (middleware/validate.js). The shift is matched
// whatever its case, as the handler always has; anything that isn't text
// used to crash .toUpperCase() with a 500.
const LEAVE_REQUEST = z.object({
  date: text(40).optional(),
  // A first and a last day, as the admin app's form sends them (daysAsked).
  startDate: text(40).optional(),
  endDate: text(40).optional(),
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
//
// Whose history it is matters (middleware/ownRecords.js): one's own
// passes on identity; someone else's needs Leave — or Employees, whose
// page shows a person's leave beside their record.
router.use(ownRecordsOr({
  features: ['/leave'],
  ownPrefixes: ['/employee/'],
  alsoRead: ['/employees'],
  open: (req) => (req.method === 'POST' && req.path === '/request') || req.method === 'DELETE',
}));

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

const DAY_MS = 86_400_000;
/** The longest span one request may ask for. */
const MAX_DAYS_PER_REQUEST = 31;
const REQUEST_EXISTS = 'A leave request already exists for this date and shift.';

/**
 * The days a request asks for, as calendar dates.
 *
 * Leave is kept one day and one shift to a request. `date` names the
 * day. The admin app's form sends a first and a last day instead
 * (`startDate`, `endDate`), which this route never read: every request
 * raised there was refused for want of a `date`. A span is a request
 * for each of its days.
 *
 * @returns {{days: Date[]}|{error: string}}
 */
function daysAsked(body) {
  const blank = (v) => v === undefined || v === null || v === '';
  const single = !blank(body.date);
  const firstRaw = single ? body.date : body.startDate;
  if (blank(firstRaw)) return { error: 'date, leaveType, reason are required.' };
  const first = factoryDay.calendarDay(firstRaw);
  if (!first) return { error: `${single ? 'date' : 'startDate'} is not a valid date.` };
  if (single || blank(body.endDate)) return { days: [first] };

  const last = factoryDay.calendarDay(body.endDate);
  if (!last) return { error: 'endDate is not a valid date.' };
  if (last < first) return { error: 'endDate is before startDate.' };
  const count = Math.round((last - first) / DAY_MS) + 1;
  if (count > MAX_DAYS_PER_REQUEST)
    return { error: `One request can cover at most ${MAX_DAYS_PER_REQUEST} days.` };
  return { days: Array.from({ length: count }, (_, i) => new Date(first.getTime() + i * DAY_MS)) };
}

/** The shifts a request for `shift` would collide with: its own, and the whole day. */
const overlapping = (shift) => (shift === 'BOTH' ? ['DAY', 'NIGHT', 'BOTH'] : [shift, 'BOTH']);

/**
 * Write the requests for somebody's days, all of them or none.
 *
 * A day and shift takes one request, so one that was refused stood in
 * the way for good: the worker could not ask again with a better reason,
 * and the office could not raise it for them. A refused request for the
 * same day and shift makes way for the new one. One still waiting, or
 * approved, does not — nor does one for the whole day beside one for a
 * shift of it, which the index alone let through.
 *
 * @param {object} doc    the fields every day shares (employee, shift, leaveType, …)
 * @param {Date[]} days
 * @param {Function} [afterEach]  (leave, session) — the approval's attendance, when created approved
 * @returns {Promise<object[]>} the requests written
 */
async function writeRequests(doc, days, afterEach = null) {
  let written = [];
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      written = [];
      const taken = await LeaveRequest.findOne({
        employee: doc.employee,
        date: { $in: days },
        shift: { $in: overlapping(doc.shift) },
        status: { $in: ['pending', 'approved'] },
      }).select('_id').session(session).lean();
      if (taken) throw new ErrorHandler(REQUEST_EXISTS, 409);

      await LeaveRequest.deleteMany(
        { employee: doc.employee, date: { $in: days }, shift: doc.shift, status: 'rejected' },
        { session }
      );
      for (const date of days) {
        const [leave] = await LeaveRequest.create([{ ...doc, date }], { session });
        if (afterEach) await afterEach(leave, session);
        written.push(leave);
      }
    });
  } finally {
    await session.endSession();
  }
  return written;
}

/** What the reviewer wrote, under whichever name the screen sends it. */
const reviewNoteOf = (body) =>
  String(body?.reviewNotes ?? body?.note ?? body?.adminRemarks ?? '').trim().slice(0, 500);

// ─────────────────────────────────────────────────────────────
// POST /request
// ─────────────────────────────────────────────────────────────
router.post('/request', isAuthenticated, validate({ body: LEAVE_REQUEST }), async (req, res) => {
  try {
    const { shift='DAY', leaveType, reason, documentUrl='' } = req.body;
    // Workers submit leave for themselves; admins may submit for anyone.
    const employeeId = resolveEmployeeId(req);
    if (!employeeId)
      return res.status(403).json({ success:false,
        message:'Cannot determine employee — your account has no linked employee' });
    const asked = daysAsked(req.body);
    if (!asked.error && (!leaveType || !reason)) asked.error = 'date, leaveType, reason are required.';
    if (asked.error) return res.status(400).json({ success:false, message: asked.error });

    const emp = await Employee.findById(employeeId, 'name department').lean();
    if (!emp) return res.status(404).json({ success:false, message:'Employee not found.' });

    const leaves = await writeRequests({
      employee: employeeId,
      shift: shift.toUpperCase(),
      leaveType, reason, documentUrl,
    }, asked.days);

    return res.status(201).json({
      success: true,
      message: leaves.length > 1
        ? `${leaves.length} leave requests submitted, one for each day. Pending admin approval.`
        : 'Leave request submitted. Pending admin approval.',
      count: leaves.length,
      data: fmtLeave({ ...leaves[0].toObject(), employee: emp }),
    });
  } catch(err) {
    if (err.code === 11000)
      return res.status(409).json({ success:false, message: REQUEST_EXISTS });
    if (!(err instanceof ErrorHandler)) console.error('[POST /request]', err);
    return sendError(req, res, err);
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
    if (!mongoose.Types.ObjectId.isValid(String(employeeId)))
      return res.status(404).json({ success:false, message:'Employee not found.' });

    const emp = await Employee.findById(employeeId, 'name department').lean();
    if (!emp) return res.status(404).json({ success:false, message:'Employee not found.' });

    const dateObj = factoryDay.calendarDay(date);
    if (!dateObj)
      return res.status(400).json({ success:false, message:'date is not a valid date.' });

    const doc = {
      employee: employeeId,
      shift: String(shift).toUpperCase(),
      leaveType, reason, documentUrl,
    };
    if (autoApprove) {
      doc.status      = 'approved';
      doc.reviewedBy  = req.user?._id || null;
      doc.reviewedAt  = new Date();
      doc.reviewNotes = 'Created & approved by admin';
    }

    // Approved on the spot: the request and the attendance it marks are
    // written together, or neither is (as PUT /:id/approve does).
    const [leave] = await writeRequests(
      doc, [dateObj],
      autoApprove ? (made, session) => markLeaveApproved(made, { session }) : null
    );

    return res.status(201).json({
      success: true,
      message: autoApprove
        ? 'Leave created and approved.'
        : 'Leave request created. Pending approval.',
      data: fmtLeave({ ...leave.toObject(), employee: emp }),
    });
  } catch(err) {
    if (err.code === 11000)
      return res.status(409).json({ success:false, message: REQUEST_EXISTS });
    if (!(err instanceof ErrorHandler)) console.error('[POST /admin-request]', err);
    return sendError(req, res, err);
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
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /all?status=&year=&month=   (or ?from=&to=)
//
// Requests by what became of them. The admin app's leave tab has always
// asked for this address, which did not exist: the tab could only say it
// had failed to load. The web's list of approved leave reads it too.
// ─────────────────────────────────────────────────────────────
const LEAVE_STATUSES = ['pending', 'approved', 'rejected'];
const MOST_LISTED = 1000;

router.get('/all', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    const blank = (v) => v === undefined || v === null || v === '';
    const status = one(req.query.status);
    const [year, month, from, to] = ['year', 'month', 'from', 'to'].map((k) => one(req.query[k]));
    const filter = {};

    if (!blank(status) && status !== 'all') {
      if (!LEAVE_STATUSES.includes(status))
        return res.status(400).json({ success:false, message:'status must be pending, approved, rejected or all.' });
      filter.status = status;
    }
    if (!blank(year) || !blank(month)) {
      const asked = monthOf({ year, month });
      if (!asked) return res.status(400).json({ success:false, message:'year and month are not a valid month.' });
      const { start, end } = monthRange(asked);
      filter.date = { $gte: start, $lte: end };
    } else if (!blank(from) || !blank(to)) {
      const range = {};
      if (!blank(from)) {
        range.$gte = factoryDay.calendarDay(from);
        if (!range.$gte) return res.status(400).json({ success:false, message:'from is not a valid date.' });
      }
      if (!blank(to)) {
        range.$lte = factoryDay.calendarDayEnd(to);
        if (!range.$lte) return res.status(400).json({ success:false, message:'to is not a valid date.' });
      }
      filter.date = range;
    }

    const leaves = await LeaveRequest.find(filter)
      .populate('employee', 'name department skill role')
      .sort({ date: -1, createdAt: -1 })
      .limit(MOST_LISTED)
      .lean();
    return res.json({ success:true, count:leaves.length, data:leaves.map(fmtLeave) });
  } catch(err) {
    console.error('[GET /all]', err);
    return sendError(req, res, err);
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
      // A month that is one: 13 used to roll over into next January and
      // answer for the wrong month without a word (utils/periods.js).
      const asked = monthOf({ year, month });
      if (!asked) return res.status(400).json({ success:false, message:'year and month are not a valid month.' });
      const { start, end } = monthRange(asked);
      filter.date = { $gte: start, $lte: end };
    }
    const leaves = await LeaveRequest.find(filter)
      .populate('employee','name department')
      .sort({ date:-1 }).lean();
    return res.json({ success:true, count:leaves.length, data:leaves.map(fmtLeave) });
  } catch(err) {
    console.error('[GET /employee]', err);
    return sendError(req, res, err);
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
    // The HR page sends this as `note` and the admin app as
    // `adminRemarks`; any of them, so the reviewer's note is recorded
    // instead of silently dropped.
    const reviewNotes = reviewNoteOf(req.body);
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

        // The shifts it covers are marked as this leave — whether or not
        // the day has been marked yet (services/attendanceMarks.js).
        await markLeaveApproved(leave, { session });
      });
    } finally {
      await session.endSession();
    }
    if (!leave) return notPending(req.params.id, res);

    return res.json({ success:true, message:'Leave approved.', data:fmtLeave(leave) });
  } catch(err) {
    console.error('[PUT /approve]', err);
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /:id/reject
// ─────────────────────────────────────────────────────────────
router.put('/:id/reject', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    // Under any of the names the screens use for it (see /approve).
    const reviewNotes = reviewNoteOf(req.body);
    const leave = await decidePending(req.params.id, 'rejected', req.user?._id, reviewNotes);
    if (!leave) return notPending(req.params.id, res);

    return res.json({ success:true, message:'Leave rejected.', data:fmtLeave(leave) });
  } catch(err) {
    console.error('[PUT /reject]', err);
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// PUT /:id/withdraw  { note? }
//
// An approval taken back: the worker is coming in after all, or it was
// approved for the wrong day. Until now nothing could undo one — the
// request stayed approved and the shift stayed leave on the sheet.
//
// The request ends as "rejected" with a note saying it was withdrawn.
// That is one of the three states both phone apps know how to show; a
// fourth would have vanished from the worker's own list. Its attendance
// is undone with it, in the one transaction (services/attendanceMarks.js).
// ─────────────────────────────────────────────────────────────
router.put('/:id/withdraw', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(404).json({ success:false, message:'Leave request not found.' });
    const note = reviewNoteOf(req.body);

    let leave, attendance;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Only while it is still approved, in the one operation: two
        // people withdrawing it together must not both undo the sheet.
        leave = await LeaveRequest.findOneAndUpdate(
          { _id: id, status: 'approved' },
          { $set: {
              status: 'rejected',
              reviewedBy: req.user?._id || null,
              reviewedAt: new Date(),
              reviewNotes: note ? `Approval withdrawn — ${note}` : 'Approval withdrawn',
            } },
          { new: true, session }
        ).populate('employee', 'name department');
        attendance = leave ? await unmarkLeaveWithdrawn(leave, { session }) : null;
      });
    } finally {
      await session.endSession();
    }
    if (!leave) {
      const existing = await LeaveRequest.findById(id).select('status').lean();
      if (!existing) return res.status(404).json({ success:false, message:'Leave request not found.' });
      return res.status(400).json({ success:false,
        message:`Only an approved leave can be withdrawn — this one is ${existing.status}.` });
    }

    return res.json({
      success: true,
      message: 'Leave approval withdrawn.',
      attendance,
      // The month's payslip was finalised with this leave on it; it does not change.
      payslipFinal: await payslipClosed(leave.employee, leave.date),
      data: fmtLeave(leave),
    });
  } catch(err) {
    console.error('[PUT /withdraw]', err);
    return sendError(req, res, err);
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
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
// GET /conflicts
// Approved leaves whose [startDate, endDate] overlaps a
// non-closed shift for the same employee. Powers the AIAdvisor
// "schedule conflict" card on the admin dashboard.
// ─────────────────────────────────────────────────────────────
router.get('/conflicts', isAuthenticated, isAdmin('admin', 'accounts'), async (req, res) => {
  try {
    // We only care about leaves that haven't yet finished — historical
    // overlaps are noise.
    const today = factoryDay.calendarDay();

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
      status:   { $in: ['open', 'running', 'pending_verification', 'loading'] },
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
    return sendError(req, res, err);
  }
});

module.exports = router;
