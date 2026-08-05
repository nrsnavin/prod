// ══════════════════════════════════════════════════════════════
//  PRODUCTION ANALYTICS API  v2
//  File: routes/production.js  (replace existing file)
//
//  New endpoint: GET /analytics
//  Adds: gamification (XP, levels, streaks, achievements),
//        consistency scores, efficiency-per-head, weekly patterns,
//        improvement trends, best/worst shift tracking.
//
//  Schema reference:
//   ShiftDetail → date, shift, status, productionMeters,
//                 timer, machine(→Machine), employee(→Employee)
//   Machine     → ID, manufacturer, NoOfHead, NoOfHooks, status
//   Employee    → name, department, skill, role, performance
// ══════════════════════════════════════════════════════════════

'use strict';

const express    = require('express');
const mongoose   = require('mongoose');
const router     = express.Router();
const ShiftPlan  = require('../models/ShiftPlan');
const ShiftDetail= require('../models/ShiftDetail');
const Wastage    = require('../models/Wastage');
const Machine    = require('../models/Machine');
const Employee   = require('../models/Employee');
const Customer   = require('../models/Customer');
const Order      = require('../models/Order');
const Elastic    = require('../models/Elastic');
const ElasticGroup = require('../models/ElasticGroup');
const { isAuthenticated } = require('../middleware/auth');
// Pure stat + gamification helpers live in their own module now
// (Phase 4 god-file split) — see utils/productionStats.test.js.
const {
  timerToSeconds, toISODate, toDateLabel, toDayOfWeek, getDayIndex,
  parseDateParam, consistencyScore, trendSlope, trailingStreak,
  calcLevel, calcXP, calcAchievements,
} = require('../utils/productionStats.js');

// Every production-analytics route requires login. Was previously
// reachable anonymously; admin Flutter callers already route through
// ApiClient so no client change needed.
router.use(isAuthenticated);

// ─────────────────────────────────────────────────────────────
//  UTILITY FUNCTIONS + XP/LEVEL ENGINE moved to
//  utils/productionStats.js (Phase 4 god-file split). Imported above.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  EXISTING ENDPOINTS (date-range, shift-detail) — UNCHANGED
// ─────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════
//  ENDPOINT 1 — GET /date-range
// ═════════════════════════════════════════════════════════════
router.get('/date-range', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate)
      return res.status(400).json({ success:false, message:'startDate and endDate required.' });

    let rangeStart, rangeEnd;
    try {
      rangeStart = parseDateParam(startDate, 0,0,0,0);
      rangeEnd   = parseDateParam(endDate, 23,59,59,999);
    } catch(e) { return res.status(400).json({ success:false, message:e.message }); }

    const shiftPlans = await ShiftPlan.find({ date:{ $gte:rangeStart, $lte:rangeEnd } })
      .select('date shift description totalProduction plan finalized finalizedAt finalizedBy')
      .populate({
        path: 'plan', model:'ShiftDetail',
        select:'machine employee status productionMeters',
        populate:[
          { path:'machine',  model:'Machine',  select:'_id' },
          { path:'employee', model:'Employee', select:'_id' },
        ],
      }).lean();

    const byDate = {};
    for (const sp of shiftPlans) {
      const key = toISODate(sp.date);
      if (!byDate[key]) byDate[key] = { DAY:null, NIGHT:null };
      byDate[key][sp.shift] = sp;
    }

    const summarise = sp => {
      if (!sp) return { exists:false, shiftPlanId:null, machines:0, operators:0,
        shiftDetailCount:0, production:0, target:0, efficiency:0, status:'none' };

      const details = sp.plan||[];
      const machineIds=new Set(), employeeIds=new Set(), statuses=new Set();
      for (const d of details) {
        const mid = d.machine?._id?.toString() || d.machine?.toString();
        const eid = d.employee?._id?.toString()|| d.employee?.toString();
        if (mid) machineIds.add(mid);
        if (eid) employeeIds.add(eid);
        if (d.status) statuses.add(d.status);
      }
      let status;
      if (statuses.size===0)            status='open';
      else if (statuses.size===1)       status=[...statuses][0];
      else if (statuses.has('running')) status='running';
      else if (statuses.has('open'))    status='open';
      else                              status='closed';
      const production = sp.totalProduction||0;
      return { exists:true, shiftPlanId:sp._id, machines:machineIds.size,
        operators:employeeIds.size, shiftDetailCount:details.length,
        production, target:0, efficiency:0, status };
    };

    const result = [];
    const cursor = new Date(rangeStart); cursor.setHours(0,0,0,0);
    while (cursor <= rangeEnd) {
      const key   = toISODate(cursor);
      const daySlot   = summarise(byDate[key]?.DAY  ||null);
      const nightSlot = summarise(byDate[key]?.NIGHT||null);
      result.push({
        date: key, dateLabel:toDateLabel(cursor), dayOfWeek:toDayOfWeek(cursor),
        hasData: daySlot.exists||nightSlot.exists,
        totalProduction: daySlot.production+nightSlot.production,
        totalTarget:0, efficiency:0,
        runningMachines:(daySlot.machines||0)+(nightSlot.machines||0),
        totalOperators:(daySlot.operators||0)+(nightSlot.operators||0),
        dayShift:daySlot, nightShift:nightSlot,
      });
      cursor.setDate(cursor.getDate()+1);
    }
    return res.json({ success:true, count:result.length, data:result });
  } catch(err) {
    console.error('[GET /date-range]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});


// ═════════════════════════════════════════════════════════════
//  ENDPOINT 2 — GET /shift-detail/:shiftPlanId
// ═════════════════════════════════════════════════════════════
router.get('/shift-detail/:shiftPlanId', async (req, res) => {
  try {
    const { shiftPlanId } = req.params;
    if (!shiftPlanId || !/^[a-f\d]{24}$/i.test(shiftPlanId))
      return res.status(400).json({ success:false, message:'Invalid shiftPlanId.' });

    const sp = await ShiftPlan.findById(shiftPlanId)
      .select('date shift description totalProduction plan finalized finalizedAt finalizedBy')
      .populate({
        path:'plan', model:'ShiftDetail',
        populate:[
          { path:'machine',  model:'Machine',  select:'ID manufacturer NoOfHead NoOfHooks status' },
          { path:'employee', model:'Employee', select:'name department skill role performance' },
          // productionMode/outsourceVendor feed the "Outsourced" marker on
          // the production view — without them in the select they arrive
          // undefined and the flag silently never shows.
          { path:'job',      model:'JobOrder', select:'jobOrderNo status productionMode outsourceVendor' },
          { path:'elastics.elastic', model:'Elastic', select:'name weaveType spandexEnds pick noOfHook weight' },
        ],
      }).lean();

    if (!sp) return res.status(404).json({ success:false, message:'ShiftPlan not found.' });

    const details = sp.plan||[];
    const totalTimerSec = details.reduce((s,d)=>s+timerToSeconds(d.timer),0);
    const machineIds=new Set(); const employeeIds=new Set();
    const statCounts = { open:0, running:0, closed:0 };
    for (const d of details) {
      const mid=d.machine?._id?.toString()||d.machine?.toString();
      const eid=d.employee?._id?.toString()||d.employee?.toString();
      if (mid) machineIds.add(mid);
      if (eid) employeeIds.add(eid);
      if (d.status) statCounts[d.status] = (statCounts[d.status]||0)+1;
    }

    const fmt = d => {
      const ts = timerToSeconds(d.timer);
      return {
        shiftDetailId: d._id,
        date:d.date, shift:d.shift, status:d.status,
        description:d.description, feedback:d.feedback,
        timer:d.timer, timerSeconds:ts,
        runMinutes: Math.round(ts/60),
        productionMeters:d.productionMeters||0,
        machine: d.machine ? {
          id:d.machine._id, machineID:d.machine.ID,
          manufacturer:d.machine.manufacturer, noOfHead:d.machine.NoOfHead,
          noOfHooks:d.machine.NoOfHooks, status:d.machine.status,
        } : null,
        employee: d.employee ? {
          id:d.employee._id, name:d.employee.name,
          department:d.employee.department, skill:d.employee.skill,
          role:d.employee.role, performance:d.employee.performance,
        } : null,
        // productionMode rides along so the production view can flag a
        // shift whose job is outsourced rather than made in-house.
        job: d.job ? {
          id: d.job._id, jobNo: d.job.jobOrderNo, status: d.job.status,
          productionMode: d.job.productionMode || 'in_house',
          outsourceVendor: d.job.outsourceVendor || '',
        } : null,
        elastics: (d.elastics||[]).map(e=>({
          head:e.head,
          elastic: e.elastic ? {
            id:e.elastic._id, name:e.elastic.name, weaveType:e.elastic.weaveType,
            spandexEnds:e.elastic.spandexEnds, pick:e.elastic.pick,
            noOfHook:e.elastic.noOfHook, weight:e.elastic.weight,
          } : null,
        })),
      };
    };

    const avgProd = details.length > 0
      ? Math.round(details.reduce((s,d)=>s+(d.productionMeters||0),0)/details.length) : 0;

    return res.json({
      success:true,
      data:{
        shiftPlanId: sp._id,
        date:toISODate(sp.date), dateLabel:toDateLabel(sp.date),
        shiftType:sp.shift, description:sp.description,
        totalProduction:sp.totalProduction||0,
        finalized: !!sp.finalized, finalizedAt: sp.finalizedAt || null, finalizedBy: sp.finalizedBy || null,
        summary:{
          totalMachines:machineIds.size, totalOperators:employeeIds.size,
          totalProduction:sp.totalProduction||0, totalRunMinutes:Math.round(totalTimerSec/60),
          avgEfficiency:avgProd,
          status: statCounts,
        },
        machines: details.map(fmt),
      },
    });
  } catch(err) {
    console.error('[GET /shift-detail]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});


// ═════════════════════════════════════════════════════════════
//  ENDPOINT 3 — GET /analytics  (full gamified analytics)
//
//  Query params:
//    startDate   YYYY-MM-DD  (required)
//    endDate     YYYY-MM-DD  (required)
//    shift       all|DAY|NIGHT  (default: all)
//    machineId   (optional, filter)
//    employeeId  (optional, filter)
//
//  Response data:
//  {
//    summary: { totalProduction, activeShifts, activeMachines,
//               activeEmployees, avgPerShift, overallAvg,
//               anomalyCount, totalRunMinutes, avgEfficiencyScore,
//               factoryConsistency, dayVsNight: { day, night } },
//    trend: [{ date, dateLabel, dayOfWeek, production,
//              machines, operators }],
//    weeklyPattern: [{ dayIndex, dayName, avgProduction, shiftCount }],
//    byMachine: [{ machineId, machineNo, manufacturer, noOfHeads,
//                  shiftCount, totalProduction, avgPerShift,
//                  efficiencyPerHead, consistencyScore, improvement,
//                  streak, bestShift, worstShift, totalRunMinutes,
//                  utilizationPct, anomalyCount, isActive,
//                  trend, trendDirection }],
//    byEmployee: [{ employeeId, name, department, skill, rank,
//                   shiftCount, totalProduction, avgPerShift,
//                   consistencyScore, improvement, streak,
//                   bestShift, worstShift, totalRunMinutes,
//                   anomalyCount, badge, badgeLabel, isTopPerformer,
//                   xp, level, levelLabel, levelIcon, levelColor,
//                   levelProgress, nextLevelXp, xpBreakdown,
//                   achievements, percentile }],
//    anomalies: [{ ...same as before... }]
//  }
// ═════════════════════════════════════════════════════════════
router.get('/analytics', async (req, res) => {
  try {
    const { startDate, endDate, shift='all', machineId, employeeId } = req.query;
    if (!startDate||!endDate)
      return res.status(400).json({ success:false, message:'startDate and endDate required.' });

    let rangeStart, rangeEnd;
    try {
      rangeStart = parseDateParam(startDate,0,0,0,0);
      rangeEnd   = parseDateParam(endDate,23,59,59,999);
    } catch(e) { return res.status(400).json({ success:false, message:e.message }); }

    // ── DB filter ──────────────────────────────────────────────
    const dbFilter = { date:{ $gte:rangeStart, $lte:rangeEnd } };
    if (shift !== 'all') dbFilter.shift = shift.toUpperCase();
    if (machineId)  dbFilter.machine  = machineId;
    if (employeeId) dbFilter.employee = employeeId;

    const details = await ShiftDetail.find(dbFilter)
      .populate({ path:'machine',  select:'ID manufacturer NoOfHead NoOfHooks status' })
      .populate({ path:'employee', select:'name department skill role performance' })
      .lean();

    // ── Empty result ───────────────────────────────────────────
    if (details.length === 0) {
      return res.json({
        success:true,
        filters:{ startDate, endDate, shift, machineId:machineId||null, employeeId:employeeId||null },
        data:{
          summary:{ totalProduction:0, activeShifts:0, activeMachines:0, activeEmployees:0,
            avgPerShift:0, overallAvg:0, anomalyCount:0, totalRunMinutes:0,
            avgEfficiencyScore:0, factoryConsistency:0, dayVsNight:{ day:0, night:0 } },
          trend:[], weeklyPattern:[], byMachine:[], byEmployee:[], anomalies:[],
        },
      });
    }

    // ── Aggregate maps ─────────────────────────────────────────
    const machineMap  = new Map();
    const employeeMap = new Map();
    const dateMap     = new Map();
    const weekMap     = new Map(); // dayIndex(0-6) → { total, count }
    let dayTotal = 0, nightTotal = 0;
    let totalTimerSec = 0;

    for (const d of details) {
      const mid      = d.machine?._id?.toString()  || d.machine?.toString()  || null;
      const eid      = d.employee?._id?.toString() || d.employee?.toString() || null;
      const prod     = d.productionMeters || 0;
      const dateKey  = toISODate(d.date);
      const dayIdx   = getDayIndex(d.date);
      const timerSec = timerToSeconds(d.timer);

      totalTimerSec += timerSec;
      if (d.shift==='DAY')   dayTotal   += prod;
      if (d.shift==='NIGHT') nightTotal += prod;

      // ── Date trend ───────────────────────────────────────────
      if (!dateMap.has(dateKey)) {
        dateMap.set(dateKey, { date:dateKey, dateLabel:toDateLabel(d.date),
          dayOfWeek:toDayOfWeek(d.date), production:0,
          machineIds:new Set(), employeeIds:new Set() });
      }
      const dt = dateMap.get(dateKey);
      dt.production += prod;
      if (mid) dt.machineIds.add(mid);
      if (eid) dt.employeeIds.add(eid);

      // ── Weekly pattern ───────────────────────────────────────
      if (!weekMap.has(dayIdx)) weekMap.set(dayIdx, { total:0, count:0 });
      const wk = weekMap.get(dayIdx);
      wk.total += prod; wk.count++;

      // ── Machine aggregate ────────────────────────────────────
      if (mid) {
        if (!machineMap.has(mid)) {
          machineMap.set(mid, {
            machineId:mid,
            machineNo:d.machine?.ID??'-',
            manufacturer:d.machine?.manufacturer??'-',
            noOfHeads:d.machine?.NoOfHead??0,
            isActive:d.machine?.status==='running',
            totalProduction:0, shiftCount:0,
            totalTimerSec:0,
            entries:[], // {date, production}
          });
        }
        const m = machineMap.get(mid);
        m.totalProduction += prod;
        m.shiftCount++;
        m.totalTimerSec += timerSec;
        m.entries.push({ date:dateKey, production:prod });
      }

      // ── Employee aggregate ───────────────────────────────────
      if (eid) {
        if (!employeeMap.has(eid)) {
          employeeMap.set(eid, {
            employeeId:eid,
            name:d.employee?.name??'-',
            department:d.employee?.department??'-',
            skill:d.employee?.skill??'-',
            role:d.employee?.role??'-',
            totalProduction:0, shiftCount:0,
            totalTimerSec:0,
            entries:[], // {date, production, shift}
          });
        }
        const emp = employeeMap.get(eid);
        emp.totalProduction += prod;
        emp.shiftCount++;
        emp.totalTimerSec += timerSec;
        emp.entries.push({ date:dateKey, production:prod, shift:d.shift });
      }
    }

    // ── Overall average ────────────────────────────────────────
    const overallAvgPerShift = details.length > 0
      ? details.reduce((s,d)=>s+(d.productionMeters||0),0) / details.length : 0;

    // ── Process machines ───────────────────────────────────────
    const machineList = [...machineMap.values()].map(m => {
      const avg       = m.shiftCount > 0 ? Math.round(m.totalProduction/m.shiftCount) : 0;
      const prods     = m.entries.map(e=>e.production);
      const cscore    = consistencyScore(prods);
      const slope     = trendSlope(prods);
      const streak    = trailingStreak(m.entries, avg);
      const effHead   = m.noOfHeads > 0 ? Math.round(avg/m.noOfHeads) : avg;

      // Improvement: compare first half vs second half of entries
      const sorted    = [...m.entries].sort((a,b)=>a.date.localeCompare(b.date));
      const half      = Math.floor(sorted.length/2);
      const firstAvg  = half>0 ? sorted.slice(0,half).reduce((s,e)=>s+e.production,0)/half : avg;
      const secAvg    = half>0 ? sorted.slice(half).reduce((s,e)=>s+e.production,0)/(sorted.length-half) : avg;
      const improvement = firstAvg>0 ? Math.round((secAvg-firstAvg)/firstAvg*100) : 0;
      const bestShift = prods.length ? Math.max(...prods) : 0;
      const worstShift= prods.length ? Math.min(...prods) : 0;
      const trendDir  = slope > 5 ? 'up' : slope < -5 ? 'down' : 'stable';
      // 12 hours per shift = 720 minutes; utilization = actual / (shifts * 720)
      const utilPct   = m.shiftCount>0 ? Math.min(100, Math.round(m.totalTimerSec/(m.shiftCount*720*60)*100)) : 0;

      return {
        ...m,
        avgPerShift:      avg,
        efficiencyPerHead:effHead,
        consistencyScore: cscore,
        improvement,
        streak,
        bestShift,
        worstShift,
        trendDirection:   trendDir,
        totalRunMinutes:  Math.round(m.totalTimerSec/60),
        utilizationPct:   utilPct,
        trend: m.entries,
      };
    }).sort((a,b)=>b.totalProduction-a.totalProduction);

    // ── Process employees ──────────────────────────────────────
    const empListRaw = [...employeeMap.values()].map(emp => {
      const avg      = emp.shiftCount>0 ? Math.round(emp.totalProduction/emp.shiftCount) : 0;
      const prods    = emp.entries.map(e=>e.production);
      const cscore   = consistencyScore(prods);
      const slope    = trendSlope(prods);
      const streak   = trailingStreak(emp.entries, avg);

      const sorted   = [...emp.entries].sort((a,b)=>a.date.localeCompare(b.date));
      const half     = Math.floor(sorted.length/2);
      const firstAvg = half>0 ? sorted.slice(0,half).reduce((s,e)=>s+e.production,0)/half : avg;
      const secAvg   = half>0 ? sorted.slice(half).reduce((s,e)=>s+e.production,0)/(sorted.length-half) : avg;
      const improvement = firstAvg>0 ? Math.round((secAvg-firstAvg)/firstAvg*100) : 0;
      const bestShift  = prods.length ? Math.max(...prods) : 0;
      const worstShift = prods.length ? Math.min(...prods) : 0;
      const trendDir   = slope > 5 ? 'up' : slope < -5 ? 'down' : 'stable';
      const anomalyCount = 0; // filled after anomaly pass

      return {
        ...emp,
        avgPerShift:      avg,
        consistencyScore: cscore,
        improvement,
        streak,
        bestShift,
        worstShift,
        trendDirection:   trendDir,
        totalRunMinutes:  Math.round(emp.totalTimerSec/60),
        anomalyCount,
      };
    }).sort((a,b)=>b.totalProduction-a.totalProduction);

    // ── Anomaly detection ──────────────────────────────────────
    const anomalies = [];

    const detectAnomalies = (entries, avg, entityType, entityId, entityName) => {
      if (avg === 0 || entries.length < 2) return;
      for (const e of entries) {
        const pct = e.production / avg;
        if (e.production === 0) {
          anomalies.push({
            type:'ZERO_PRODUCTION', severity:'high',
            date:e.date, dateLabel:toDateLabel(new Date(e.date)),
            entityType, entityId, entityName,
            value:0, threshold:avg,
            message:`${entityName} recorded 0m production on ${toDateLabel(new Date(e.date))}`,
          });
        } else if (pct < 0.40) {
          anomalies.push({
            type:'LOW_PRODUCTION', severity:'high',
            date:e.date, dateLabel:toDateLabel(new Date(e.date)),
            entityType, entityId, entityName,
            value:e.production, threshold:Math.round(avg*0.40),
            message:`${entityName} produced only ${e.production}m (avg ${Math.round(avg)}m) — ${Math.round(pct*100)}% of normal`,
          });
        } else if (pct < 0.70) {
          anomalies.push({
            type:'UNDERPERFORMANCE', severity:'medium',
            date:e.date, dateLabel:toDateLabel(new Date(e.date)),
            entityType, entityId, entityName,
            value:e.production, threshold:Math.round(avg*0.70),
            message:`${entityName} underperformed on ${toDateLabel(new Date(e.date))}: ${e.production}m vs avg ${Math.round(avg)}m`,
          });
        } else if (pct > 1.50) {
          anomalies.push({
            type:'PRODUCTION_SPIKE', severity:'low',
            date:e.date, dateLabel:toDateLabel(new Date(e.date)),
            entityType, entityId, entityName,
            value:e.production, threshold:Math.round(avg*1.50),
            message:`${entityName} exceptional output on ${toDateLabel(new Date(e.date))}: ${e.production}m (${Math.round(pct*100)}% of avg)`,
          });
        }
      }
    };

    for (const m of machineList) {
      detectAnomalies(m.entries, m.avgPerShift, 'machine', m.machineId, m.machineNo);
    }
    for (const emp of empListRaw) {
      detectAnomalies(emp.entries, emp.avgPerShift, 'employee', emp.employeeId, emp.name);
    }

    anomalies.sort((a,b)=> {
      const ord={high:0,medium:1,low:2};
      const sd = ord[a.severity]-ord[b.severity];
      return sd!==0?sd:b.date.localeCompare(a.date);
    });

    // Fill anomaly counts back onto employees
    const empAnomalyCount = new Map();
    for (const a of anomalies) {
      if (a.entityType==='employee') {
        empAnomalyCount.set(a.entityId, (empAnomalyCount.get(a.entityId)||0)+1);
      }
    }

    // ── Assign ranks, badges, XP, levels, achievements ─────────
    const employeeList = empListRaw.map((emp, idx) => {
      const rank = idx+1;
      emp.anomalyCount = empAnomalyCount.get(emp.employeeId)||0;

      // Badge
      let badge='none', badgeLabel='';
      if      (rank===1) { badge='gold';   badgeLabel='🥇 Top Producer'; }
      else if (rank===2) { badge='silver'; badgeLabel='🥈 2nd Place'; }
      else if (rank===3) { badge='bronze'; badgeLabel='🥉 3rd Place'; }
      else if (emp.shiftCount>=3 && emp.avgPerShift>overallAvgPerShift*1.2) {
        badge='star'; badgeLabel='⭐ High Performer';
      }

      // XP & Level
      const { xp, xpBreakdown } = calcXP(emp, overallAvgPerShift, rank);
      const levelData = calcLevel(xp);

      // Achievements
      const achievements = calcAchievements(
        { ...emp, xp },
        overallAvgPerShift,
        empListRaw
      );

      // Percentile (0=bottom 100=top)
      const percentile = empListRaw.length > 1
        ? Math.round((empListRaw.length-rank)/(empListRaw.length-1)*100) : 100;

      return {
        employeeId:       emp.employeeId,
        name:             emp.name,
        department:       emp.department,
        skill:            emp.skill,
        role:             emp.role,
        rank,
        shiftCount:       emp.shiftCount,
        totalProduction:  emp.totalProduction,
        avgPerShift:      emp.avgPerShift,
        consistencyScore: emp.consistencyScore,
        improvement:      emp.improvement,
        streak:           emp.streak,
        bestShift:        emp.bestShift,
        worstShift:       emp.worstShift,
        trendDirection:   emp.trendDirection,
        totalRunMinutes:  emp.totalRunMinutes,
        anomalyCount:     emp.anomalyCount,
        badge,
        badgeLabel,
        isTopPerformer:   rank<=3,
        percentile,
        xp,
        level:            levelData.level,
        levelLabel:       levelData.label,
        levelIcon:        levelData.icon,
        levelColor:       levelData.color,
        levelProgress:    levelData.progress,
        nextLevelXp:      levelData.nextXp,
        xpBreakdown,
        achievements,
      };
    });

    // ── Machine anomaly counts ─────────────────────────────────
    const machAnomalyCount = new Map();
    for (const a of anomalies) {
      if (a.entityType==='machine')
        machAnomalyCount.set(a.entityId, (machAnomalyCount.get(a.entityId)||0)+1);
    }

    // ── Trend array ────────────────────────────────────────────
    const trend = [...dateMap.values()].map(dt=>({
      date:dt.date, dateLabel:dt.dateLabel, dayOfWeek:dt.dayOfWeek,
      production:dt.production, machines:dt.machineIds.size, operators:dt.employeeIds.size,
    })).sort((a,b)=>a.date.localeCompare(b.date));

    // ── Weekly pattern ─────────────────────────────────────────
    const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const weeklyPattern = [0,1,2,3,4,5,6].map(i=>{
      const w = weekMap.get(i)||{ total:0, count:0 };
      return { dayIndex:i, dayName:dayNames[i],
        avgProduction: w.count>0 ? Math.round(w.total/w.count) : 0,
        shiftCount:w.count };
    });

    // ── Summary ────────────────────────────────────────────────
    const totalProduction  = details.reduce((s,d)=>s+(d.productionMeters||0),0);
    const activeMachines   = new Set(details.map(d=>d.machine?._id?.toString()||d.machine?.toString()).filter(Boolean));
    const activeEmployees  = new Set(details.map(d=>d.employee?._id?.toString()||d.employee?.toString()).filter(Boolean));
    const machScores       = machineList.map(m=>m.consistencyScore);
    const factoryConsist   = machScores.length ? Math.round(machScores.reduce((a,b)=>a+b,0)/machScores.length) : 0;
    const avgEffScore      = machineList.length
      ? Math.round(machineList.reduce((s,m)=>s+m.efficiencyPerHead,0)/machineList.length) : 0;

    const summary = {
      totalProduction,
      activeShifts:        details.length,
      activeMachines:      activeMachines.size,
      activeEmployees:     activeEmployees.size,
      avgPerShift:         details.length>0 ? Math.round(totalProduction/details.length) : 0,
      overallAvg:          Math.round(overallAvgPerShift),
      anomalyCount:        anomalies.filter(a=>a.severity==='high').length,
      totalRunMinutes:     Math.round(totalTimerSec/60),
      avgEfficiencyScore:  avgEffScore,
      factoryConsistency:  factoryConsist,
      dayVsNight:          { day:dayTotal, night:nightTotal },
    };

    // ── Strip internal 'entries' from machine output ───────────
    const machineOut = machineList.map(({ entries, totalTimerSec:_ts, ...rest })=>({
      ...rest,
      anomalyCount: machAnomalyCount.get(rest.machineId)||0,
    }));

    return res.json({
      success:true,
      filters:{ startDate, endDate, shift, machineId:machineId||null, employeeId:employeeId||null },
      data:{ summary, trend, weeklyPattern, byMachine:machineOut, byEmployee:employeeList, anomalies },
    });

  } catch(err) {
    console.error('[GET /analytics]', err);
    return res.status(500).json({ success:false, message:err.message });
  }
});

// ═════════════════════════════════════════════════════════════
//  ENDPOINT 4 — GET /breakdown
//
//  Unified production + wastage analytics, grouped by any one of
//  four dimensions and narrowable by every other one. This is the
//  cross-tab the admin actually asks for: "how much did we make and
//  waste, per machine / per operator / per customer / per order?"
//
//  Query params:
//    start, end   YYYY-MM-DD  (required)
//    groupBy      machine | operator | customer | order   (default: machine)
//    shift        all | DAY | NIGHT   (default: all, production only)
//    machineId    (optional filter)
//    employeeId   (optional filter)
//    customerId   (optional filter)
//    orderId      (optional filter)
//
//  Production comes from closed ShiftDetail docs; wastage from the
//  Wastage ledger. Both are keyed onto the same dimension so a row
//  carries produced metres AND wasted metres side by side. Customer,
//  order and (for wastage) machine dimensions are resolved through
//  the parent JobOrder.
//
//  Response:
//  {
//    success, groupBy, range:{ start, end },
//    totals:{ production, shiftCount, wastageQty, wastageEvents,
//             wastagePenalty, wastageRate },
//    rows:[{ key, label, sublabel, production, shiftCount,
//            avgPerShift, wastageQty, wastageEvents, wastagePenalty,
//            wastageRate, share }],
//    insights:[{ severity, title, detail }]
//  }
// ═════════════════════════════════════════════════════════════
const GROUP_DIMS = ['machine', 'operator', 'customer', 'order', 'elastic', 'group'];

function toObjectId(v) {
  try { return new mongoose.Types.ObjectId(v); } catch (_) { return null; }
}

router.get('/breakdown', async (req, res) => {
  try {
    const {
      start, end, groupBy = 'machine', shift = 'all',
      machineId, employeeId, customerId, orderId,
    } = req.query;

    if (!start || !end)
      return res.status(400).json({ success: false, message: 'start and end are required.' });
    if (!GROUP_DIMS.includes(groupBy))
      return res.status(400).json({ success: false, message: `groupBy must be one of ${GROUP_DIMS.join(', ')}.` });

    let rangeStart, rangeEnd;
    try {
      rangeStart = parseDateParam(start, 0, 0, 0, 0);
      rangeEnd   = parseDateParam(end, 23, 59, 59, 999);
    } catch (e) { return res.status(400).json({ success: false, message: e.message }); }

    // ── Shared filters ───────────────────────────────────────
    const mId = machineId  ? toObjectId(machineId)  : null;
    const eId = employeeId ? toObjectId(employeeId) : null;
    const cId = customerId ? toObjectId(customerId) : null;
    const oId = orderId    ? toObjectId(orderId)    : null;

    // ── Production pipeline (ShiftDetail) ─────────────────────
    const prodMatch = { date: { $gte: rangeStart, $lte: rangeEnd }, status: 'closed' };
    if (shift !== 'all') prodMatch.shift = shift.toUpperCase();
    if (mId) prodMatch.machine  = mId;
    if (eId) prodMatch.employee = eId;

    const prodPipe = [{ $match: prodMatch }];
    // Only pay for the join when a customer/order dimension or filter needs it.
    const needsJobJoin = groupBy === 'customer' || groupBy === 'order' || cId || oId;
    if (needsJobJoin) {
      prodPipe.push(
        { $lookup: { from: 'joborders', localField: 'job', foreignField: '_id', as: 'jobDoc' } },
        { $unwind: { path: '$jobDoc', preserveNullAndEmptyArrays: true } },
      );
      const post = {};
      if (cId) post['jobDoc.customer'] = cId;
      if (oId) post['jobDoc.order'] = oId;
      if (Object.keys(post).length) prodPipe.push({ $match: post });
    }
    if (groupBy === 'elastic' || groupBy === 'group') {
      // Production is booked per shift, not per elastic. Attribute a
      // shift's metres across the elastics it ran, weighted by how many
      // heads each elastic occupied in that shift's head→elastic map.
      // A shift can therefore contribute to several elastics; shiftCount
      // counts distinct shifts that touched each elastic. The 'group'
      // dimension aggregates per elastic here, then rolls up into groups
      // below.
      prodPipe.push(
        { $addFields: { totalHeads: { $size: { $ifNull: ['$elastics', []] } } } },
        { $match: { totalHeads: { $gt: 0 } } },
        { $unwind: '$elastics' },
        { $group: {
            _id: '$elastics.elastic',
            production: {
              $sum: { $divide: ['$productionMeters', '$totalHeads'] },
            },
            shiftIds: { $addToSet: '$_id' },
        } },
        { $project: { production: 1, shiftCount: { $size: '$shiftIds' } } },
      );
    } else {
      const prodKey = {
        machine:  '$machine',
        operator: '$employee',
        customer: '$jobDoc.customer',
        order:    '$jobDoc.order',
      }[groupBy];
      prodPipe.push({
        $group: {
          _id: prodKey,
          production: { $sum: '$productionMeters' },
          shiftCount: { $sum: 1 },
        },
      });
    }

    // ── Wastage pipeline (Wastage ledger) ────────────────────
    // Wastage carries employee directly; machine/customer/order are
    // resolved through the parent job. Dated by createdAt to match
    // the existing /wastage/analytics convention.
    const wastePipe = [{ $match: { createdAt: { $gte: rangeStart, $lte: rangeEnd } } }];
    const wasteNeedsJob =
      groupBy === 'machine' || groupBy === 'customer' || groupBy === 'order' || mId || cId || oId;
    if (wasteNeedsJob) {
      wastePipe.push(
        { $lookup: { from: 'joborders', localField: 'job', foreignField: '_id', as: 'jobDoc' } },
        { $unwind: { path: '$jobDoc', preserveNullAndEmptyArrays: true } },
      );
    }
    const wPost = {};
    if (mId) wPost['jobDoc.machine']  = mId;
    if (eId) wPost.employee           = eId;
    if (cId) wPost['jobDoc.customer'] = cId;
    if (oId) wPost['jobDoc.order']    = oId;
    if (Object.keys(wPost).length) wastePipe.push({ $match: wPost });

    const wasteKey = {
      machine:  '$jobDoc.machine',
      operator: '$employee',
      customer: '$jobDoc.customer',
      order:    '$jobDoc.order',
      elastic:  '$elastic',
      group:    '$elastic', // rolled up into groups after aggregation
    }[groupBy];
    wastePipe.push({
      $group: {
        _id: wasteKey,
        wastageQty:     { $sum: '$quantity' },
        wastageEvents:  { $sum: 1 },
        wastagePenalty: { $sum: '$penalty' },
      },
    });

    const [prodRows, wasteRows] = await Promise.all([
      ShiftDetail.aggregate(prodPipe),
      Wastage.aggregate(wastePipe),
    ]);

    // ── Merge on the dimension key ───────────────────────────
    const rowMap = new Map();
    const blank = () => ({
      production: 0, shiftCount: 0,
      wastageQty: 0, wastageEvents: 0, wastagePenalty: 0,
    });
    for (const p of prodRows) {
      if (!p._id) continue;
      const k = p._id.toString();
      const r = rowMap.get(k) || blank();
      r.production += p.production || 0;
      r.shiftCount += p.shiftCount || 0;
      rowMap.set(k, r);
    }
    for (const w of wasteRows) {
      if (!w._id) continue;
      const k = w._id.toString();
      const r = rowMap.get(k) || blank();
      r.wastageQty     += w.wastageQty || 0;
      r.wastageEvents  += w.wastageEvents || 0;
      r.wastagePenalty += w.wastagePenalty || 0;
      rowMap.set(k, r);
    }

    // ── Group dimension: roll the per-elastic numbers up into each
    //    group that contains the elastic. Groups can share elastics, so
    //    an elastic's output may count toward several groups — this is a
    //    per-group rollup (across all customers), not a partition, so
    //    rows can overlap and need not sum to the plant total.
    let presetLabels = null;
    if (groupBy === 'group') {
      const perElastic = new Map(rowMap); // keyed by elastic id
      const groups = await ElasticGroup.find({ isActive: true })
        .populate('customer', 'name').lean();
      rowMap.clear();
      presetLabels = new Map();
      for (const g of groups) {
        const acc = blank();
        let any = false;
        for (const it of g.items || []) {
          const eid = it.elastic?.toString();
          const r = eid && perElastic.get(eid);
          if (!r) continue;
          any = true;
          acc.production     += r.production;
          acc.shiftCount     += r.shiftCount;
          acc.wastageQty     += r.wastageQty;
          acc.wastageEvents  += r.wastageEvents;
          acc.wastagePenalty += r.wastagePenalty;
        }
        if (!any) continue; // no activity for this group's elastics in range
        const gid = g._id.toString();
        rowMap.set(gid, acc);
        presetLabels.set(gid, {
          label: g.name,
          sublabel: g.customer?.name || 'Global',
        });
      }
    }

    // ── Resolve human labels for the dimension ───────────────
    const keys = [...rowMap.keys()].map(toObjectId).filter(Boolean);
    const labels = presetLabels || new Map(); // key → { label, sublabel }
    if (!presetLabels && keys.length) {
      if (groupBy === 'machine') {
        const docs = await Machine.find({ _id: { $in: keys } })
          .select('ID manufacturer NoOfHead status').lean();
        for (const d of docs)
          labels.set(d._id.toString(), {
            label: `Machine ${d.ID ?? '—'}`,
            sublabel: [d.manufacturer, d.NoOfHead ? `${d.NoOfHead} heads` : null]
              .filter(Boolean).join(' · '),
          });
      } else if (groupBy === 'operator') {
        const docs = await Employee.find({ _id: { $in: keys } })
          .select('name department role').lean();
        for (const d of docs)
          labels.set(d._id.toString(), {
            label: d.name || 'Unknown operator',
            sublabel: [d.department, d.role].filter(Boolean).join(' · '),
          });
      } else if (groupBy === 'customer') {
        const docs = await Customer.find({ _id: { $in: keys } }).select('name').lean();
        for (const d of docs)
          labels.set(d._id.toString(), { label: d.name || 'Unknown customer', sublabel: '' });
      } else if (groupBy === 'order') {
        const docs = await Order.find({ _id: { $in: keys } })
          .select('orderNo status supplyDate').lean();
        for (const d of docs)
          labels.set(d._id.toString(), {
            label: `Order #${d.orderNo ?? '—'}`,
            sublabel: d.status || '',
          });
      } else if (groupBy === 'elastic') {
        const docs = await Elastic.find({ _id: { $in: keys } })
          .select('name weaveType').lean();
        for (const d of docs)
          labels.set(d._id.toString(), {
            label: d.name || 'Unknown elastic',
            sublabel: d.weaveType || '',
          });
      }
    }

    // ── Assemble + derive rates ──────────────────────────────
    const round = (n) => Math.round(n * 100) / 100;
    let totalProd = 0, totalShifts = 0, totalWaste = 0, totalEvents = 0, totalPenalty = 0;
    let rows = [...rowMap.entries()].map(([key, r]) => {
      totalProd    += r.production;
      totalShifts  += r.shiftCount;
      totalWaste   += r.wastageQty;
      totalEvents  += r.wastageEvents;
      totalPenalty += r.wastagePenalty;
      const meta = labels.get(key) || { label: 'Unknown', sublabel: '' };
      const denom = r.production + r.wastageQty;
      return {
        key,
        label: meta.label,
        sublabel: meta.sublabel,
        production: round(r.production),
        shiftCount: r.shiftCount,
        avgPerShift: r.shiftCount ? round(r.production / r.shiftCount) : 0,
        wastageQty: round(r.wastageQty),
        wastageEvents: r.wastageEvents,
        wastagePenalty: round(r.wastagePenalty),
        wastageRate: denom > 0 ? round((r.wastageQty / denom) * 100) : 0,
      };
    });
    rows.sort((a, b) => b.production - a.production);
    // Share of total production, computed after totals are known.
    rows = rows.map((r) => ({
      ...r,
      share: totalProd > 0 ? round((r.production / totalProd) * 100) : 0,
    }));

    const plantRate = (totalProd + totalWaste) > 0
      ? round((totalWaste / (totalProd + totalWaste)) * 100)
      : 0;

    // ── Rule-based insights ("AI analytical") ────────────────
    const dimLabel = { machine: 'machine', operator: 'operator', customer: 'customer', order: 'order', elastic: 'elastic', group: 'group' }[groupBy] || groupBy;
    const insights = [];
    if (rows.length) {
      const top = rows[0];
      if (top.production > 0) {
        insights.push({
          severity: 'good',
          title: `Top ${dimLabel}: ${top.label}`,
          detail: `Produced ${top.production.toLocaleString('en-IN')} m — ${top.share}% of the ${totalProd.toLocaleString('en-IN')} m total in this range.`,
        });
      }
      // Output concentration risk.
      if (top.share >= 40 && rows.length > 2) {
        insights.push({
          severity: 'warn',
          title: 'Output is concentrated',
          detail: `${top.label} alone accounts for ${top.share}% of production. A stoppage here would hit throughput hard — consider load-balancing.`,
        });
      }
      // Worst wastage offenders vs plant rate.
      const wasters = rows
        .filter((r) => r.wastageQty > 0 && r.wastageRate > 0)
        .sort((a, b) => b.wastageRate - a.wastageRate);
      if (wasters.length) {
        const w = wasters[0];
        insights.push({
          severity: w.wastageRate >= plantRate * 1.5 && plantRate > 0 ? 'warn' : 'info',
          title: `Highest wastage: ${w.label}`,
          detail: `Wasting ${w.wastageRate}% of its output (${w.wastageQty.toLocaleString('en-IN')} m), against a plant average of ${plantRate}%.`,
        });
        // Additional offenders running well above plant rate.
        for (const x of wasters.slice(1, 3)) {
          if (plantRate > 0 && x.wastageRate >= plantRate * 2) {
            insights.push({
              severity: 'warn',
              title: `${x.label} wastage is 2×+ the plant rate`,
              detail: `${x.wastageRate}% wasted vs ${plantRate}% plant average — worth a root-cause check.`,
            });
          }
        }
      }
      // Under-utilised: lowest avg/shift among those with enough shifts.
      const active = rows.filter((r) => r.shiftCount >= 3);
      if (active.length >= 3) {
        const avgOfAvgs = round(active.reduce((s, r) => s + r.avgPerShift, 0) / active.length);
        const laggard = [...active].sort((a, b) => a.avgPerShift - b.avgPerShift)[0];
        if (avgOfAvgs > 0 && laggard.avgPerShift < avgOfAvgs * 0.6) {
          insights.push({
            severity: 'info',
            title: `${laggard.label} is running below average`,
            detail: `${laggard.avgPerShift.toLocaleString('en-IN')} m/shift vs a ${dimLabel} average of ${avgOfAvgs.toLocaleString('en-IN')} m/shift across ${laggard.shiftCount} shifts.`,
          });
        }
      }
    } else {
      insights.push({
        severity: 'info',
        title: 'No production in this range',
        detail: 'Widen the date range or clear filters to see data.',
      });
    }

    return res.json({
      success: true,
      groupBy,
      range: { start, end },
      totals: {
        production: round(totalProd),
        shiftCount: totalShifts,
        wastageQty: round(totalWaste),
        wastageEvents: totalEvents,
        wastagePenalty: round(totalPenalty),
        wastageRate: plantRate,
      },
      rows,
      insights,
    });
  } catch (err) {
    console.error('[GET /breakdown]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;