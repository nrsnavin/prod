// ══════════════════════════════════════════════════════════════
//  PRODUCTION DATE-RANGE API
//  File: routes/production_range.js
//
//  Mount in app.js:
//    app.use('/api/v2/production', require('./routes/production_range'));
//
//  Schema reference (exact fields):
//
//  ShiftPlan   → date, shift("DAY"|"NIGHT"), description,
//                totalProduction, plan[ObjectId→ShiftDetail]
//
//  ShiftDetail → date, shift("DAY"|"NIGHT"),
//                status("open"|"running"|"closed"),
//                description, feedback,
//                job(→JobOrder), timer("HH:mm:ss"),
//                productionMeters, elastics[{head, elastic→Elastic}],
//                employee(→Employee), shiftPlan(→ShiftPlan),
//                machine(→Machine)
//
//  Machine     → ID, manufacturer, DateOfPurchase,
//                NoOfHead, NoOfHooks,
//                elastics[{elastic(→Elastic), head}],
//                orderRunning(→JobOrder),
//                status("free"|"running"|"maintenance"),
//                shifts[→ShiftDetail]
//
//  Elastic     → name, weaveType, spandexEnds, pick,
//                noOfHook, weight, testingParameters,
//                quantityProduced, stock
//
//  Employee    → name, phoneNumber, skill, role,
//                department, performance, shifts[→ShiftDetail]
//
//  Production  → date, machine(→Machine),
//                employee(→Employee), production, shift
// ══════════════════════════════════════════════════════════════

'use strict';

const express    = require('express');
const router     = express.Router();
const ShiftPlan  = require('../models/ShiftPlan');
const ShiftDetail= require('../models/ShiftDetail');
const Production = require('../models/Production');

// ─────────────────────────────────────────────────────────────
//  PURE UTILITY FUNCTIONS  (no side-effects, no DB calls)
// ─────────────────────────────────────────────────────────────

/**
 * Parse "HH:mm:ss" string → integer total seconds.
 * Returns 0 for any malformed input.
 */
function timerToSeconds(timerStr) {
  if (typeof timerStr !== 'string') return 0;
  const parts = timerStr.trim().split(':');
  if (parts.length !== 3) return 0;
  const [h, m, s] = parts.map(Number);
  if ([h, m, s].some(isNaN)) return 0;
  return h * 3600 + m * 60 + s;
}

/**
 * Integer total seconds → "Xh Ym" human label.
 */
function secondsToLabel(totalSec) {
  if (!totalSec || totalSec <= 0) return '0m';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Date → "DD Mon YYYY"  e.g. "23 Jan 2026"
 */
function toDateLabel(d) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

/**
 * Date → short weekday  e.g. "Mon"
 */
function toDayOfWeek(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'short' });
}

/**
 * Date → "YYYY-MM-DD" ISO string (date part only, UTC-safe).
 */
function toISODate(d) {
  return new Date(d).toISOString().split('T')[0];
}

/**
 * Build a Date with specific hours from a YYYY-MM-DD string.
 * Throws if the string is not a valid date.
 */
function parseDateParam(dateStr, h, m, s, ms) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date param: "${dateStr}". Expected YYYY-MM-DD.`);
  }
  d.setHours(h, m, s, ms);
  return d;
}


// ═════════════════════════════════════════════════════════════
//  ENDPOINT 1 — GET /date-range
//
//  Required query params:
//    startDate  YYYY-MM-DD
//    endDate    YYYY-MM-DD
//
//  Response envelope:
//  {
//    success: true,
//    count:   N,
//    data: [
//      {
//        date:            "2026-01-23",
//        dateLabel:       "23 Jan 2026",
//        dayOfWeek:       "Mon",
//        hasData:         true,
//        totalProduction: 1240,
//        dayShift:  {
//          exists:           true,
//          shiftPlanId:      "...",
//          machineCount:     4,
//          operatorCount:    4,
//          shiftDetailCount: 4,
//          production:       620,
//          description:      "...",
//          statusSummary:    "running"
//        },
//        nightShift: { ...same shape... }
//      }
//    ]
//  }
// ═════════════════════════════════════════════════════════════
router.get('/date-range', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate query params are required (YYYY-MM-DD).',
      });
    }

    let rangeStart, rangeEnd;
    try {
      rangeStart = parseDateParam(startDate, 0, 0, 0, 0);
      rangeEnd   = parseDateParam(endDate,  23, 59, 59, 999);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    // ── Fetch ShiftPlans in range ─────────────────────────────
    // Populate ShiftDetail.plan[] with only the fields we need for
    // the summary (machine id, employee id, status, productionMeters).
    const shiftPlans = await ShiftPlan.find({
      date: { $gte: rangeStart, $lte: rangeEnd },
    })
      .select('date shift description totalProduction plan')
      .populate({
        path: 'plan',
        model: 'ShiftDetail',
        select: 'machine employee status productionMeters',
        // We only need the _id from machine/employee to count uniques
        populate: [
          { path: 'machine',  model: 'Machine',  select: '_id' },
          { path: 'employee', model: 'Employee', select: '_id' },
        ],
      })
      .lean();

    // ── Group by ISO date key + shift type ────────────────────
    // byDate[dateKey] = { DAY: ShiftPlan | null, NIGHT: ShiftPlan | null }
    const byDate = {};
    for (const sp of shiftPlans) {
      const key = toISODate(sp.date);
      if (!byDate[key]) byDate[key] = { DAY: null, NIGHT: null };
      byDate[key][sp.shift] = sp;
    }

    // ── Summarise one ShiftPlan into a slot object ────────────
    const summarise = (sp) => {
      if (!sp) {
        return {
          exists: false, shiftPlanId: null,
          machineCount: 0, operatorCount: 0, shiftDetailCount: 0,
          production: 0, description: '', statusSummary: 'none',
        };
      }

      const details = sp.plan || [];

      // Count unique machines and operators
      const machineIds  = new Set();
      const employeeIds = new Set();
      const statuses    = new Set();

      for (const d of details) {
        const mid = d.machine?._id?.toString()  || d.machine?.toString();
        const eid = d.employee?._id?.toString() || d.employee?.toString();
        if (mid) machineIds.add(mid);
        if (eid) employeeIds.add(eid);
        if (d.status) statuses.add(d.status);
      }

      // Collapse multiple statuses into one label
      let statusSummary;
      if (statuses.size === 0)             statusSummary = 'open';
      else if (statuses.size === 1)        statusSummary = [...statuses][0];
      else if (statuses.has('running'))    statusSummary = 'running';
      else if (statuses.has('open'))       statusSummary = 'open';
      else                                 statusSummary = 'closed';

      return {
        exists:           true,
        shiftPlanId:      sp._id,
        machineCount:     machineIds.size,
        operatorCount:    employeeIds.size,
        shiftDetailCount: details.length,
        // ShiftPlan.totalProduction is the canonical production figure
        production:       sp.totalProduction || 0,
        description:      sp.description    || '',
        statusSummary,
      };
    };

    // ── Iterate every calendar day in the range ───────────────
    const result = [];
    const cursor = new Date(rangeStart);
    cursor.setHours(0, 0, 0, 0);

    while (cursor <= rangeEnd) {
      const key      = toISODate(cursor);
      const daySlot  = summarise(byDate[key]?.DAY   || null);
      const nightSlot= summarise(byDate[key]?.NIGHT || null);

      result.push({
        date:            key,
        dateLabel:       toDateLabel(cursor),
        dayOfWeek:       toDayOfWeek(cursor),
        hasData:         daySlot.exists || nightSlot.exists,
        totalProduction: daySlot.production + nightSlot.production,
        dayShift:        daySlot,
        nightShift:      nightSlot,
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    return res.json({ success: true, count: result.length, data: result });

  } catch (err) {
    console.error('[GET /date-range]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ═════════════════════════════════════════════════════════════
//  ENDPOINT 2 — GET /shift-detail/:shiftPlanId
//
//  Returns full detail for one ShiftPlan.
//  Each item in details[] corresponds to one ShiftDetail doc
//  (i.e. one machine running in the shift).
//
//  Response envelope:
//  {
//    success: true,
//    data: {
//      shiftPlanId, date, dateLabel, shift,
//      description, totalProduction,
//      summary: {
//        totalMachines, totalOperators, totalProduction,
//        totalTimerSeconds, timerLabel,
//        avgProductionPerMachine,
//        statusCounts: { open, running, closed }
//      },
//      details: [
//        {
//          shiftDetailId,
//          date, shift, status, description, feedback,
//          timer,            "HH:mm:ss"
//          timerSeconds,     parsed integer
//          timerLabel,       "2h 30m"
//          productionMeters,
//          machine: {
//            id, machineID,      ← Machine.ID field
//            manufacturer,
//            noOfHead,           ← Machine.NoOfHead
//            noOfHooks,          ← Machine.NoOfHooks
//            status              ← "free"|"running"|"maintenance"
//          } | null,
//          employee: {
//            id, name, department,
//            skill, role, performance
//          } | null,
//          job: { id, jobNo, status } | null,
//          elastics: [
//            {
//              head,
//              elastic: {
//                id, name, weaveType, spandexEnds,
//                pick, noOfHook, weight
//              } | null
//            }
//          ]
//        }
//      ]
//    }
//  }
// ═════════════════════════════════════════════════════════════
router.get('/shift-detail/:shiftPlanId', async (req, res) => {
  try {
    const { shiftPlanId } = req.params;

    // Validate ObjectId-like format before hitting the DB
    if (!shiftPlanId || !/^[a-f\d]{24}$/i.test(shiftPlanId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid shiftPlanId.',
      });
    }

    const sp = await ShiftPlan.findById(shiftPlanId)
      .select('date shift description totalProduction plan')
      .populate({
        path: 'plan',
        model: 'ShiftDetail',
        // Fetch all ShiftDetail fields
        populate: [
          {
            path: 'machine',
            model: 'Machine',
            select: 'ID manufacturer NoOfHead NoOfHooks status',
          },
          {
            path: 'employee',
            model: 'Employee',
            select: 'name department skill role performance',
          },
          {
            path: 'job',
            model: 'JobOrder',
            select: 'jobOrderNo status',
          },
          {
            // Populate the elastic ref inside each element of
            // ShiftDetail.elastics[]
            path: 'elastics.elastic',
            model: 'Elastic',
            select: 'name weaveType spandexEnds pick noOfHook weight',
          },
        ],
      })
      .lean();

    if (!sp) {
      return res.status(404).json({
        success: false,
        message: `ShiftPlan not found for id: ${shiftPlanId}`,
      });
    }

    const rawDetails = sp.plan || [];

    // ── Build detail rows ─────────────────────────────────────
    const detailRows = rawDetails.map((d) => {
      const timerSec = timerToSeconds(d.timer);

      // Map ShiftDetail.elastics[{head, elastic}]
      const elasticsOut = (d.elastics || []).map((he) => ({
        head: he.head,
        elastic: he.elastic
          ? {
              id:          he.elastic._id,
              name:        he.elastic.name,
              weaveType:   he.elastic.weaveType,
              spandexEnds: he.elastic.spandexEnds,
              pick:        he.elastic.pick,
              noOfHook:    he.elastic.noOfHook,
              weight:      he.elastic.weight,
            }
          : null,
      }));

      // Map Machine fields: ID, NoOfHead, NoOfHooks, status
      const machineOut = d.machine
        ? {
            id:           d.machine._id,
            machineID:    d.machine.ID,            // Machine.ID
            manufacturer: d.machine.manufacturer,
            noOfHead:     d.machine.NoOfHead,      // Machine.NoOfHead
            noOfHooks:    d.machine.NoOfHooks,     // Machine.NoOfHooks
            status:       d.machine.status,        // free|running|maintenance
          }
        : null;

      // Map Employee fields
      const employeeOut = d.employee
        ? {
            id:          d.employee._id,
            name:        d.employee.name,
            department:  d.employee.department,
            skill:       d.employee.skill,
            role:        d.employee.role,
            performance: d.employee.performance,
          }
        : null;

      // Map JobOrder ref
      const jobOut = d.job
        ? {
            id:    d.job._id,
            jobNo: d.job.jobOrderNo,
            status:d.job.status,
          }
        : null;

      return {
        shiftDetailId:    d._id,
        date:             d.date ? toISODate(d.date) : null,
        shift:            d.shift,                // "DAY" | "NIGHT"
        status:           d.status,               // "open"|"running"|"closed"
        description:      d.description || '',
        feedback:         d.feedback    || '',
        timer:            d.timer || '00:00:00',  // "HH:mm:ss" as stored
        timerSeconds:     timerSec,
        timerLabel:       secondsToLabel(timerSec),
        productionMeters: d.productionMeters || 0,
        machine:          machineOut,
        employee:         employeeOut,
        job:              jobOut,
        elastics:         elasticsOut,
      };
    });

    // ── Compute summary totals ────────────────────────────────
    const uniqueMachines  = new Set(
      detailRows
        .map((r) => r.machine?.id?.toString())
        .filter(Boolean)
    );
    const uniqueOperators = new Set(
      detailRows
        .map((r) => r.employee?.id?.toString())
        .filter(Boolean)
    );

    // ShiftPlan.totalProduction is authoritative;
    // fall back to summing detail rows only if it is 0 / missing
    const totalProduction = sp.totalProduction
      || detailRows.reduce((sum, r) => sum + r.productionMeters, 0);

    const totalTimerSec = detailRows.reduce(
      (sum, r) => sum + r.timerSeconds, 0
    );

    // Count detail rows by status
    const statusCounts = { open: 0, running: 0, closed: 0 };
    for (const r of detailRows) {
      if (r.status in statusCounts) statusCounts[r.status]++;
    }

    const summary = {
      totalMachines:           uniqueMachines.size,
      totalOperators:          uniqueOperators.size,
      totalProduction,
      totalTimerSeconds:       totalTimerSec,
      timerLabel:              secondsToLabel(totalTimerSec),
      avgProductionPerMachine:
        uniqueMachines.size > 0
          ? Math.round((totalProduction / uniqueMachines.size) * 10) / 10
          : 0,
      statusCounts,
    };

    return res.json({
      success: true,
      data: {
        shiftPlanId:     sp._id,
        date:            toISODate(sp.date),
        dateLabel:       toDateLabel(sp.date),
        shift:           sp.shift,           // "DAY" | "NIGHT"
        description:     sp.description || '',
        totalProduction,
        summary,
        details:         detailRows,
      },
    });

  } catch (err) {
    console.error('[GET /shift-detail/:id]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ═════════════════════════════════════════════════════════════
//  ENDPOINT 3 — GET /summary-stats
//
//  Required query params:
//    startDate  YYYY-MM-DD
//    endDate    YYYY-MM-DD
//
//  Aggregates from both ShiftPlan and Production collections.
//
//  Response envelope:
//  {
//    success: true,
//    data: {
//      dateRange: { startDate, endDate },
//      shiftPlans: {
//        totalProduction, total, dayCount, nightCount,
//        avgProductionPerShift
//      },
//      productionRecords: {
//        totalProduction, total,
//        uniqueMachines, uniqueOperators
//      }
//    }
//  }
// ═════════════════════════════════════════════════════════════
router.get('/summary-stats', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate query params are required (YYYY-MM-DD).',
      });
    }

    let rangeStart, rangeEnd;
    try {
      rangeStart = parseDateParam(startDate, 0, 0, 0, 0);
      rangeEnd   = parseDateParam(endDate,  23, 59, 59, 999);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    const dateFilter = { $gte: rangeStart, $lte: rangeEnd };

    // ── Aggregate ShiftPlan.totalProduction ───────────────────
    const [spAgg, prAgg] = await Promise.all([

      ShiftPlan.aggregate([
        { $match: { date: dateFilter } },
        {
          $group: {
            _id:             null,
            totalProduction: { $sum: '$totalProduction' },
            total:           { $sum: 1 },
            dayCount:  { $sum: { $cond: [{ $eq: ['$shift', 'DAY']   }, 1, 0] } },
            nightCount:{ $sum: { $cond: [{ $eq: ['$shift', 'NIGHT'] }, 1, 0] } },
          },
        },
      ]),

      // ── Aggregate Production records ──────────────────────
      Production.aggregate([
        { $match: { date: dateFilter } },
        {
          $group: {
            _id:             null,
            totalProduction: { $sum: '$production' },
            total:           { $sum: 1 },
            // $addToSet deduplicates ObjectIds
            uniqueMachines:  { $addToSet: '$machine' },
            uniqueOperators: { $addToSet: '$employee' },
          },
        },
      ]),

    ]);

    const sp = spAgg[0] || {
      totalProduction: 0, total: 0, dayCount: 0, nightCount: 0,
    };
    const pr = prAgg[0] || {
      totalProduction: 0, total: 0, uniqueMachines: [], uniqueOperators: [],
    };

    return res.json({
      success: true,
      data: {
        dateRange: { startDate, endDate },
        shiftPlans: {
          totalProduction:      sp.totalProduction,
          total:                sp.total,
          dayCount:             sp.dayCount,
          nightCount:           sp.nightCount,
          avgProductionPerShift: sp.total > 0
            ? Math.round((sp.totalProduction / sp.total) * 10) / 10
            : 0,
        },
        productionRecords: {
          totalProduction: pr.totalProduction,
          total:           pr.total,
          uniqueMachines:  pr.uniqueMachines.length,
          uniqueOperators: pr.uniqueOperators.length,
        },
      },
    });

  } catch (err) {
    console.error('[GET /summary-stats]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;