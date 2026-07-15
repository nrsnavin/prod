"use strict";
// ═════════════════════════════════════════════════════════════════
//  Production analytics — pure stat + gamification helpers.
//
//  Extracted verbatim from api/production.js (Phase 4 god-file split).
//  Every function here is pure (no DB, no req/res): date formatting,
//  dispersion stats (stdDev / consistency / trend / streak), and the
//  operator XP-level-achievement engine the /analytics route renders.
//  Pulling them out shrinks the route file and — because they were
//  previously untested — lets utils/productionStats.test.js lock the
//  scoring math against accidental drift.
// ═════════════════════════════════════════════════════════════════

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

module.exports = {
  timerToSeconds,
  toISODate,
  toDateLabel,
  toDayOfWeek,
  getDayIndex,
  parseDateParam,
  stdDev,
  consistencyScore,
  trendSlope,
  trailingStreak,
  LEVELS,
  calcLevel,
  calcXP,
  calcAchievements,
};
