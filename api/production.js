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
    //
    //  FIX: field names now match ShiftSummary.fromJson exactly:
    //    machineCount  → machines      (was being read as 0)
    //    operatorCount → operators     (was being read as 0)
    //    statusSummary → status        (was being read as 'none')
    //  ADDED: efficiency, target       (Flutter expects these fields)
    const summarise = (sp) => {
      if (!sp) {
        return {
          exists: false, shiftPlanId: null,
          // FIX: use keys Flutter model reads
          machines: 0, operators: 0, shiftDetailCount: 0,
          production: 0, target: 0, efficiency: 0,
          status: 'none',
        };
      }

      const details = sp.plan || [];

      // Count unique machines and operators
      const machineIds  = new Set();
      const employeeIds = new Set();
      const statuses    = new Set();

      for (const d of details) {
        // d.machine is populated as { _id: ObjectId } (select: '_id')
        // Fall back to raw ObjectId string if populate didn't resolve
        const mid = d.machine?._id?.toString()  || d.machine?.toString();
        const eid = d.employee?._id?.toString() || d.employee?.toString();
        if (mid) machineIds.add(mid);
        if (eid) employeeIds.add(eid);
        if (d.status) statuses.add(d.status);
      }

      // Collapse multiple statuses into one label
      // FIX: key renamed from statusSummary → status
      let status;
      if (statuses.size === 0)           status = 'open';
      else if (statuses.size === 1)      status = [...statuses][0];
      else if (statuses.has('running'))  status = 'running';
      else if (statuses.has('open'))     status = 'open';
      else                               status = 'closed';

      const production = sp.totalProduction || 0;

      return {
        exists:           true,
        shiftPlanId:      sp._id,
        // FIX: 'machines' and 'operators' — these were the keys
        //       being read by Flutter that always returned 0
        machines:         machineIds.size,
        operators:        employeeIds.size,
        shiftDetailCount: details.length,
        production,
        target:           0,       // No target field in ShiftPlan schema
        efficiency:       0,       // Cannot compute without target
        status,                    // FIX: was 'statusSummary'
      };
    };

    // ── Iterate every calendar day in the range ───────────────
    //
    //  FIX: daily row now includes fields Flutter reads on DailyProduction:
    //    runningMachines  (was absent → always 0 in UI)
    //    totalOperators   (was absent → always 0 in UI)
    //    efficiency       (was absent → always 0 in UI)
    //    totalTarget      (was absent → always 0 in UI)
    const result = [];
    const cursor = new Date(rangeStart);
    cursor.setHours(0, 0, 0, 0);

    while (cursor <= rangeEnd) {
      const key      = toISODate(cursor);
      const daySlot  = summarise(byDate[key]?.DAY   || null);
      const nightSlot= summarise(byDate[key]?.NIGHT || null);

      // Aggregate machine + operator counts across both shifts for the day row
      // Flutter's DailyProduction reads runningMachines and totalOperators
      // directly on the day object (not inside dayShift/nightShift)
      const runningMachines = (daySlot.machines || 0) + (nightSlot.machines || 0);
      const totalOperators  = (daySlot.operators || 0) + (nightSlot.operators || 0);
      const totalProduction = daySlot.production + nightSlot.production;

      result.push({
        date:            key,
        dateLabel:       toDateLabel(cursor),
        dayOfWeek:       toDayOfWeek(cursor),
        hasData:         daySlot.exists || nightSlot.exists,
        totalProduction,
        totalTarget:     0,    // No target in schema; Flutter defaults to 0
        efficiency:      0,    // Cannot compute without target
        // FIX: these two were absent — Flutter showed 0 machines / 0 operators
        runningMachines,
        totalOperators,
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
    //
    //  FIX: previously returned nested { machine: {...}, employee: {...} }
    //  objects. Flutter's MachineShiftDetail.fromJson reads FLAT fields:
    //    machineId, machineNo, noOfHeads, operatorId, operatorName, etc.
    //  Also:
    //    productionMeters → production
    //    timerSeconds     → runMinutes  (÷60)
    //    rowIndex         added (1-based position)
    const detailRows = rawDetails.map((d, idx) => {
      const timerSec  = timerToSeconds(d.timer);
      const runMinutes = Math.round(timerSec / 60);

      return {
        // ── Identity ───────────────────────────────────────────
        shiftDetailId: d._id,
        rowIndex:      idx + 1,    // 1-based row number

        // ── Machine (flattened) ────────────────────────────────
        // FIX: was nested d.machine object; Flutter reads flat keys
        machineId:   d.machine?._id?.toString()  ?? null,
        machineNo:   d.machine?.ID               ?? '-',    // Machine.ID
        machineType: d.machine?.manufacturer     ?? '-',
        department:  d.employee?.department      ?? '-',
        noOfHeads:   d.machine?.NoOfHead         ?? 0,
        speed:       0,   // Not in ShiftDetail schema

        // ── Operator (flattened) ───────────────────────────────
        // FIX: was nested d.employee object; Flutter reads flat keys
        operatorId:   d.employee?._id?.toString() ?? null,
        operatorName: d.employee?.name            ?? '-',
        operatorDept: d.employee?.department      ?? '-',
        operatorSkill:d.employee?.skill           ?? '-',

        // ── Production ─────────────────────────────────────────
        // FIX: was 'productionMeters'; Flutter reads 'production'
        production:      d.productionMeters || 0,
        target:          0,    // Not in ShiftDetail schema
        efficiency:      0,    // Cannot compute without target

        // ── Timer ──────────────────────────────────────────────
        // FIX: was 'timerSeconds'; Flutter reads 'runMinutes'
        runMinutes,
        downtimeMinutes: 0,          // Not in ShiftDetail schema
        activeMinutes:   runMinutes, // No downtime data → all time is active
        downtimeReasons: [],

        // ── Misc ───────────────────────────────────────────────
        // FIX: 'remarks' from description (Flutter reads 'remarks')
        remarks:  d.description || d.feedback || '',
        status:   d.status,   // "open" | "running" | "closed"
        shift:    d.shift,

        // ── Job link ───────────────────────────────────────────
        job: d.job
          ? { id: d.job._id, jobNo: d.job.jobOrderNo, status: d.job.status }
          : null,

        // ── Elastics (per-head assignments) ───────────────────
        elastics: (d.elastics || []).map((he) => ({
          head: he.head,
          elastic: he.elastic ? {
            id:          he.elastic._id,
            name:        he.elastic.name,
            weaveType:   he.elastic.weaveType,
            spandexEnds: he.elastic.spandexEnds,
            pick:        he.elastic.pick,
            noOfHook:    he.elastic.noOfHook,
            weight:      he.elastic.weight,
          } : null,
        })),
      };
    });

    // ── Compute summary totals ────────────────────────────────
    const uniqueMachines  = new Set(
      detailRows
        .map((r) => r.machineId?.toString())
        .filter(Boolean)
    );
    const uniqueOperators = new Set(
      detailRows
        .map((r) => r.operatorId?.toString())
        .filter(Boolean)
    );

    // ShiftPlan.totalProduction is authoritative;
    // fall back to summing detail rows only if it is 0 / missing
    const totalProduction = sp.totalProduction
      || detailRows.reduce((sum, r) => sum + r.production, 0);

    // FIX: Flutter reads 'totalRunMinutes' not 'totalTimerSeconds'
    //      Convert seconds → minutes
    const totalTimerSec = detailRows.reduce(
      (sum, r) => sum + (r.runMinutes * 60), 0
    );
    const totalRunMinutes = Math.round(totalTimerSec / 60);

    // Count detail rows by status
    const statusCounts = { open: 0, running: 0, closed: 0 };
    for (const r of detailRows) {
      if (r.status in statusCounts) statusCounts[r.status]++;
    }

    // Highest producer by productionMeters
    const topDetail = detailRows.reduce(
      (best, r) => r.production > (best?.production ?? -1) ? r : best,
      null
    );

    const summary = {
      totalMachines:    uniqueMachines.size,
      totalOperators:   uniqueOperators.size,
      totalProduction,
      totalTarget:      0,     // No target field in ShiftPlan schema
      // FIX: was 'avgProductionPerMachine' — Flutter reads 'avgEfficiency'
      avgEfficiency:
        uniqueMachines.size > 0
          ? Math.round((totalProduction / uniqueMachines.size) * 10) / 10
          : 0,
      // FIX: was 'totalTimerSeconds' — Flutter reads 'totalRunMinutes'
      totalRunMinutes,
      totalDowntime:    0,     // No downtime field in ShiftDetail schema
      // FIX: was absent — Flutter reads 'highestProducer'
      highestProducer:  topDetail?.machineNo ?? '-',
      statusCounts,
    };

    return res.json({
      success: true,
      data: {
        shiftPlanId:     sp._id,
        date:            toISODate(sp.date),
        dateLabel:       toDateLabel(sp.date),
        // FIX: was 'shift' — Flutter reads 'shiftType'
        shiftType:       (sp.shift || 'DAY').toLowerCase(), // 'day' | 'night'
        // FIX: add status derived from detail statuses (Flutter reads this)
        status:          summary.statusCounts.running > 0 ? 'running'
                       : summary.statusCounts.open    > 0 ? 'open'
                       : 'closed',
        description:     sp.description || '',
        remarks:         sp.description || '',
        department:      '-',
        totalProduction,
        summary,
        // FIX: was 'details' — Flutter reads 'machines'
        machines:        detailRows,
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