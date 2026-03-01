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
const router     = express.Router();
const ShiftPlan  = require('../models/ShiftPlan');
const ShiftDetail= require('../models/ShiftDetail');

// ─────────────────────────────────────────────────────────────
//  UTILITY FUNCTIONS
// ─────────────────────────────────────────────────────────────

function timerToSeconds(t) {
  if (typeof t !== 'string') return 0;
  const p = t.trim().split(':');
  if (p.length !== 3) return 0;
  const [h, m, s] = p.map(Number);
  if ([h,m,s].some(isNaN)) return 0;
  return h*3600 + m*60 + s;
}

function toISODate(d)    { return new Date(d).toISOString().split('T')[0]; }
function toDateLabel(d)  {
  return new Date(d).toLocaleDateString('en-IN',
    { day:'2-digit', month:'short', year:'numeric' });
}
function toDayOfWeek(d)  {
  return new Date(d).toLocaleDateString('en-IN', { weekday:'short' });
}
function getDayIndex(d)  { return new Date(d).getDay(); } // 0=Sun

function parseDateParam(s, h, m, sec, ms) {
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: "${s}"`);
  d.setHours(h, m, sec, ms);
  return d;
}

/** Sample std-deviation of an array */
function stdDev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a,b)=>a+b,0) / arr.length;
  const variance = arr.reduce((s,v)=>s+Math.pow(v-mean,2),0)/(arr.length-1);
  return Math.sqrt(variance);
}

/** Coefficient of Variation → 0-100 consistency score (100=perfectly consistent) */
function consistencyScore(arr) {
  if (arr.length < 2) return 100;
  const mean = arr.reduce((a,b)=>a+b,0)/arr.length;
  if (mean === 0) return 0;
  const cv = (stdDev(arr) / mean) * 100;
  return Math.max(0, Math.round(100 - cv));
}

/** Linear trend slope: positive → improving, negative → declining */
function trendSlope(arr) {
  if (arr.length < 3) return 0;
  const n = arr.length;
  const xs = Array.from({length:n},(_,i)=>i);
  const mx = xs.reduce((a,b)=>a+b,0)/n;
  const my = arr.reduce((a,b)=>a+b,0)/n;
  const num = xs.reduce((s,x,i)=>s+(x-mx)*(arr[i]-my),0);
  const den = xs.reduce((s,x)=>s+Math.pow(x-mx,2),0);
  return den===0 ? 0 : num/den;
}

/** Count consecutive trailing elements that are above threshold */
function trailingStreak(entries, avg) {
  if (!entries.length || avg === 0) return 0;
  const sorted = [...entries].sort((a,b)=>a.date.localeCompare(b.date));
  let streak = 0;
  for (let i = sorted.length-1; i >= 0; i--) {
    if (sorted[i].production >= avg) streak++;
    else break;
  }
  return streak;
}

// ─────────────────────────────────────────────────────────────
//  XP / LEVEL ENGINE
// ─────────────────────────────────────────────────────────────

const LEVELS = [
  { min:0,    label:'Rookie',    icon:'🌱', color:'#94A3B8' },
  { min:50,   label:'Operator',  icon:'⚙️', color:'#22D3EE' },
  { min:150,  label:'Craftsman', icon:'🔧', color:'#34D399' },
  { min:300,  label:'Expert',    icon:'⚡', color:'#818CF8' },
  { min:600,  label:'Master',    icon:'🔥', color:'#F59E0B' },
  { min:1000, label:'Legend',    icon:'👑', color:'#FFD700' },
];

function calcLevel(xp) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.min) lvl = l; else break; }
  const idx   = LEVELS.indexOf(lvl);
  const next  = LEVELS[idx+1];
  const xpInLevel  = xp - lvl.min;
  const xpToNext   = next ? next.min - lvl.min : 0;
  const progress   = next ? Math.min(100, Math.round(xpInLevel / xpToNext * 100)) : 100;
  return {
    level:     idx+1,
    label:     lvl.label,
    icon:      lvl.icon,
    color:     lvl.color,
    xp,
    nextXp:    next ? next.min : null,
    progress,
  };
}

function calcXP(emp, overallAvg, rank) {
  let xp = 0;
  const notes = [];

  // Base: 10 XP per shift
  xp += emp.shiftCount * 10;
  notes.push(`${emp.shiftCount} shifts × 10 = ${emp.shiftCount*10} XP`);

  // Above-average shifts: +5 each
  const aboveAvgCount = emp.entries.filter(e => e.production >= emp.avgPerShift).length;
  xp += aboveAvgCount * 5;
  if (aboveAvgCount) notes.push(`${aboveAvgCount} above-avg shifts × 5 = ${aboveAvgCount*5} XP`);

  // Streak bonus: +3 per streak day
  xp += emp.streak * 3;
  if (emp.streak > 1) notes.push(`${emp.streak}-day streak × 3 = ${emp.streak*3} XP`);

  // Consistency bonus: 0-30 XP based on score
  const conBonus = Math.round(emp.consistencyScore * 0.30);
  xp += conBonus;
  if (conBonus) notes.push(`Consistency score ${emp.consistencyScore} → ${conBonus} XP`);

  // Improvement bonus: up to 20 XP if significantly improving
  if (emp.improvement > 10) {
    const impBonus = Math.min(20, Math.round(emp.improvement / 5));
    xp += impBonus;
    notes.push(`+${emp.improvement}% improving trend → ${impBonus} XP`);
  }

  // No anomalies bonus: +15 XP
  if (emp.anomalyCount === 0 && emp.shiftCount >= 3) {
    xp += 15;
    notes.push('Zero anomalies × 15 XP');
  }

  // Above overall factory avg: +10
  if (emp.avgPerShift > overallAvg * 1.1) {
    xp += 10;
    notes.push('Above factory avg × 10 XP');
  }

  // Rank bonuses
  if (rank === 1)      { xp += 100; notes.push('🥇 #1 Rank × 100 XP'); }
  else if (rank === 2) { xp += 50;  notes.push('🥈 #2 Rank × 50 XP');  }
  else if (rank === 3) { xp += 25;  notes.push('🥉 #3 Rank × 25 XP');  }

  return { xp, xpBreakdown: notes };
}

function calcAchievements(emp, overallAvg, allEmployees) {
  const earned = [];

  if (emp.shiftCount >= 1)   earned.push({ id:'first_shift',  label:'First Shift',     icon:'🎯', desc:'Completed your first shift' });
  if (emp.shiftCount >= 10)  earned.push({ id:'veteran',       label:'Veteran',          icon:'🏅', desc:'10 shifts logged' });
  if (emp.shiftCount >= 30)  earned.push({ id:'iron_worker',   label:'Iron Worker',      icon:'🔩', desc:'30 shifts of dedication' });
  if (emp.shiftCount >= 50)  earned.push({ id:'centurion',     label:'Centurion',        icon:'⚔️', desc:'50 shifts milestone' });

  if (emp.streak >= 3)       earned.push({ id:'on_a_roll',     label:'On a Roll',        icon:'🔥', desc:'3+ consecutive above-avg shifts' });
  if (emp.streak >= 7)       earned.push({ id:'unstoppable',   label:'Unstoppable',      icon:'💥', desc:'7+ shift winning streak' });
  if (emp.streak >= 14)      earned.push({ id:'machine_mode',  label:'Machine Mode',     icon:'🤖', desc:'14-shift legendary streak' });

  if (emp.consistencyScore >= 70) earned.push({ id:'steady_hands', label:'Steady Hands',  icon:'🎯', desc:'Consistent output (score 70+)' });
  if (emp.consistencyScore >= 90) earned.push({ id:'clockwork',    label:'Clockwork',     icon:'⏱️', desc:'Near-perfect consistency (90+)' });

  if (emp.improvement >= 20) earned.push({ id:'rising_star',   label:'Rising Star',      icon:'📈', desc:'20%+ output improvement' });
  if (emp.improvement >= 50) earned.push({ id:'rocket',        label:'Rocket',           icon:'🚀', desc:'50%+ output improvement' });

  if (emp.avgPerShift > overallAvg * 1.5) earned.push({ id:'high_flyer',  label:'High Flyer', icon:'🦅', desc:'50% above factory average' });
  if (emp.avgPerShift > overallAvg * 2.0) earned.push({ id:'elite',        label:'Elite',       icon:'💎', desc:'Double the factory average' });

  if (emp.anomalyCount === 0 && emp.shiftCount >= 5)
    earned.push({ id:'no_bad_days',  label:'No Bad Days',    icon:'✨', desc:'Zero anomalies over 5+ shifts' });

  const rank = allEmployees.findIndex(e=>e.employeeId===emp.employeeId)+1;
  if (rank === 1)      earned.push({ id:'top_gun',  label:'Top Gun',   icon:'🥇', desc:'#1 producer in period' });

  return earned;
}

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
      .select('date shift description totalProduction plan')
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
      .select('date shift description totalProduction plan')
      .populate({
        path:'plan', model:'ShiftDetail',
        populate:[
          { path:'machine',  model:'Machine',  select:'ID manufacturer NoOfHead NoOfHooks status' },
          { path:'employee', model:'Employee', select:'name department skill role performance' },
          { path:'job',      model:'JobOrder', select:'jobOrderNo status' },
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
        job: d.job ? { id:d.job._id, jobNo:d.job.jobOrderNo, status:d.job.status } : null,
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

module.exports = router;