// ══════════════════════════════════════════════════════════════
//  PRODUCTION DATE-RANGE API  —  routes/production_range.js
//  Mount in app.js:
//    app.use('/api/v2/production', require('./routes/production_range'));
// ══════════════════════════════════════════════════════════════
const express    = require('express');
const router     = express.Router();
const ShiftPlan  = require('../models/ShiftPlan');
const Machine    = require('../models/Machine');
const Employee   = require('../models/Employee');

// ── Helper: build start/end of a calendar day in local time ──
function dayBounds(dateStr) {
  const start = new Date(dateStr);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

// ══════════════════════════════════════════════════════════════
//  GET /date-range
//  Query: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
//  Returns: array of daily production summaries
//
//  Response shape:
//  [
//    {
//      date: "2026-01-23",
//      dateLabel: "23 Jan 2026",
//      totalProduction: 1240,        // metres across all shifts
//      dayShift:  { exists, shiftPlanId, machines, operators, production },
//      nightShift:{ exists, shiftPlanId, machines, operators, production },
//      runningMachines: 8,
//      totalOperators: 14,
//      efficiency: 87.5              // % of target
//    }
//  ]
// ══════════════════════════════════════════════════════════════
router.get('/date-range', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    const start = new Date(startDate); start.setHours(0, 0, 0, 0);
    const end   = new Date(endDate);   end.setHours(23, 59, 59, 999);

    // Fetch all shift plans in range
    const plans = await ShiftPlan.find({
      date: { $gte: start, $lte: end }
    })
      .populate('machines.machine', 'machineNo type department')
      .populate('machines.operator', 'name department')
      .populate('supervisor', 'name')
      .lean();

    // Group by date string → { day: plan, night: plan }
    const byDate = {};
    for (const plan of plans) {
      const key = new Date(plan.date).toISOString().split('T')[0];
      if (!byDate[key]) byDate[key] = {};
      const shiftKey = plan.shiftType === 'day' ? 'day' : 'night';
      byDate[key][shiftKey] = plan;
    }

    // Build response array — one entry per calendar day in range
    const result = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = cursor.toISOString().split('T')[0];
      const dayPlan   = byDate[key]?.day   || null;
      const nightPlan = byDate[key]?.night || null;

      const summarise = (plan) => {
        if (!plan) return { exists: false, shiftPlanId: null, machines: 0, operators: 0, production: 0, target: 0, efficiency: 0, status: 'none' };
        const machines   = plan.machines?.length || 0;
        const operators  = new Set(plan.machines?.map(m => m.operator?._id?.toString()).filter(Boolean)).size;
        const production = (plan.machines || []).reduce((s, m) => s + (m.production || 0), 0);
        const target     = (plan.machines || []).reduce((s, m) => s + (m.target     || 0), 0);
        return {
          exists:      true,
          shiftPlanId: plan._id,
          machines,
          operators,
          production,
          target,
          efficiency:  target > 0 ? Math.round((production / target) * 1000) / 10 : 0,
          status:      plan.status || 'open',
          startTime:   plan.startTime || null,
          endTime:     plan.endTime   || null,
          supervisor:  plan.supervisor?.name || null,
        };
      };

      const daySummary   = summarise(dayPlan);
      const nightSummary = summarise(nightPlan);
      const totalProd    = daySummary.production + nightSummary.production;
      const totalTarget  = daySummary.target     + nightSummary.target;

      result.push({
        date:           key,
        dateLabel:      cursor.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }),
        dayOfWeek:      cursor.toLocaleDateString('en-IN', { weekday: 'short' }),
        totalProduction: totalProd,
        totalTarget:    totalTarget,
        efficiency:     totalTarget > 0 ? Math.round((totalProd / totalTarget) * 1000) / 10 : 0,
        runningMachines: Math.max(daySummary.machines, nightSummary.machines),
        totalOperators:  daySummary.operators + nightSummary.operators,
        dayShift:        daySummary,
        nightShift:      nightSummary,
        hasData:         daySummary.exists || nightSummary.exists,
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    res.json({ success: true, count: result.length, data: result });
  } catch (err) {
    console.error('date-range error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /shift-detail/:shiftPlanId
//  Returns full detail of one shift plan including:
//  - plan meta (date, type, supervisor, status, start/end time)
//  - per-machine records (machineNo, operator, heads, target,
//    production, efficiency, timer start/end, downtime, remarks)
//  - summary totals
// ══════════════════════════════════════════════════════════════
router.get('/shift-detail/:shiftPlanId', async (req, res) => {
  try {
    const plan = await ShiftPlan.findById(req.params.shiftPlanId)
      .populate('machines.machine',  'machineNo type department speed')
      .populate('machines.operator', 'name department skill performance')
      .populate('supervisor',        'name department')
      .populate('job',               'jobOrderNo status customer')
      .lean();

    if (!plan) return res.status(404).json({ message: 'Shift plan not found' });

    // Build per-machine detail rows
    const machineDetails = (plan.machines || []).map((m, idx) => {
      const prod   = m.production || 0;
      const target = m.target     || 0;
      const eff    = target > 0 ? Math.round((prod / target) * 1000) / 10 : 0;

      // Timer info
      const timerStart   = m.timerStart  || null;
      const timerEnd     = m.timerEnd    || null;
      const runMinutes   = (timerStart && timerEnd)
        ? Math.round((new Date(timerEnd) - new Date(timerStart)) / 60000)
        : m.runMinutes || 0;
      const downtimeMin  = m.downtimeMinutes || 0;
      const activeMin    = Math.max(0, runMinutes - downtimeMin);

      return {
        rowIndex:       idx + 1,
        machineId:      m.machine?._id   || m.machine,
        machineNo:      m.machine?.machineNo || m.machineNo || '-',
        machineType:    m.machine?.type      || '-',
        department:     m.machine?.department || plan.department || '-',
        operatorId:     m.operator?._id  || m.operator,
        operatorName:   m.operator?.name     || '-',
        operatorDept:   m.operator?.department || '-',
        operatorSkill:  m.operator?.skill    || '-',
        noOfHeads:      m.noOfHeads   || m.heads || 0,
        speed:          m.machine?.speed     || m.speed || 0,
        target,
        production:     prod,
        efficiency:     eff,
        timerStart,
        timerEnd,
        runMinutes,
        downtimeMinutes: downtimeMin,
        activeMinutes:   activeMin,
        downtimeReasons: m.downtimeReasons || [],
        remarks:         m.remarks || '',
        status:          m.status  || (prod >= target ? 'completed' : 'in_progress'),
      };
    });

    // Totals
    const totalProd       = machineDetails.reduce((s, m) => s + m.production, 0);
    const totalTarget     = machineDetails.reduce((s, m) => s + m.target, 0);
    const totalDowntime   = machineDetails.reduce((s, m) => s + m.downtimeMinutes, 0);
    const totalRunMinutes = machineDetails.reduce((s, m) => s + m.runMinutes, 0);
    const avgEfficiency   = machineDetails.length > 0
      ? Math.round(machineDetails.reduce((s,m)=>s+m.efficiency,0) / machineDetails.length * 10) / 10
      : 0;

    const response = {
      shiftPlanId:  plan._id,
      date:         new Date(plan.date).toISOString().split('T')[0],
      dateLabel:    new Date(plan.date).toLocaleDateString('en-IN', {
        day:'2-digit', month:'short', year:'numeric' }),
      shiftType:    plan.shiftType || 'day',
      status:       plan.status   || 'open',
      startTime:    plan.startTime || null,
      endTime:      plan.endTime   || null,
      supervisor:   plan.supervisor ? {
        id: plan.supervisor._id, name: plan.supervisor.name } : null,
      job:          plan.job ? {
        id: plan.job._id, jobNo: plan.job.jobOrderNo, status: plan.job.status } : null,
      department:   plan.department || '-',
      remarks:      plan.remarks    || '',

      summary: {
        totalMachines:    machineDetails.length,
        totalOperators:   new Set(machineDetails.map(m=>m.operatorId?.toString()).filter(Boolean)).size,
        totalProduction:  totalProd,
        totalTarget,
        avgEfficiency,
        totalRunMinutes,
        totalDowntime,
        highestProducer:  machineDetails.sort((a,b)=>b.production-a.production)[0]?.machineNo || '-',
      },

      machines: machineDetails.sort((a,b) => a.rowIndex - b.rowIndex),
    };

    res.json({ success: true, data: response });
  } catch (err) {
    console.error('shift-detail error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /summary-stats
//  Query: startDate, endDate
//  Returns aggregate KPIs for the period (for dashboard widgets)
// ══════════════════════════════════════════════════════════════
router.get('/summary-stats', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = new Date(startDate); start.setHours(0,0,0,0);
    const end   = new Date(endDate);   end.setHours(23,59,59,999);

    const plans = await ShiftPlan.find({ date: { $gte: start, $lte: end } }).lean();

    let totalProd=0, totalTarget=0, totalShifts=0, totalDowntime=0;
    for (const p of plans) {
      totalShifts++;
      for (const m of (p.machines||[])) {
        totalProd    += m.production || 0;
        totalTarget  += m.target     || 0;
        totalDowntime+= m.downtimeMinutes || 0;
      }
    }

    res.json({
      success: true,
      data: {
        totalProduction: totalProd,
        totalTarget,
        overallEfficiency: totalTarget>0
          ? Math.round((totalProd/totalTarget)*1000)/10 : 0,
        totalShifts,
        avgProductionPerShift: totalShifts>0
          ? Math.round(totalProd/totalShifts) : 0,
        totalDowntimeHours: Math.round(totalDowntime/60*10)/10,
      }
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;