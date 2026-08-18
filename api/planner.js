'use strict';
// ═══════════════════════════════════════════════════════════════════
//  Autonomous production planning (v1)
//
//  Proposes the day's job plan — which elastic runs on which machine,
//  how many heads, and in what order — optimised to hit supply dates
//  while minimising elastic changeovers and balancing machine load.
//
//  Deterministic core:
//    • rates come from the Bayesian per-(elastic, machine) posterior
//      (utils/etaPosterior), falling back to the plant average and then
//      a cold-start constant — the same blend the ETA engine uses.
//    • a greedy assignment (earliest due date first, finish-/changeover-
//      aware machine choice) seeds a bounded local search that only
//      accepts strictly-improving moves.
//  Claude only writes a plain-English rationale (narrative), never the
//  numbers. Accepting a plan freezes it as the plan of record; it does
//  NOT mutate machines or jobs — execution still goes through the normal
//  job flow (automate the proposal, keep the approval).
// ═══════════════════════════════════════════════════════════════════

const express          = require("express");
const router           = express.Router();
const mongoose         = require("mongoose");

const Order            = require("../models/Order");
const Machine          = require("../models/Machine");
const Elastic          = require("../models/Elastic");
const ProductionPlan   = require("../models/ProductionPlan");

const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const { getPairRate, toMetersPerMachineDay } = require("../utils/etaPosterior");
const { anthropic, TEXT_MODEL } = require("../utils/anthropicClient");
const { promptVersion, systemPrompt } = require("../utils/aiPrompts");
const ledger = require("../services/aiLedger");
const C = require("../utils/etaConfig");

// Tunables for the objective. Lateness dominates; changeovers and load
// imbalance are secondary shapers.
const CHANGEOVER_DAYS = 0.5;
const W_LATE          = 10;
const W_CHANGE        = 1;
const W_BAL           = 0.1;
const W_BAL_SMALL     = 0.05;
const MAX_ITER        = 6;
const EPS             = 1e-6;

const _fmt = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null);

/**
 * Midnight on the day of `d`.
 *
 * Everything in this planner is counted in WORKING DAYS, and the clock
 * has to start on a day boundary for that to mean anything. It did not:
 * `planDate` was `new Date()`, so a plan generated at half past two
 * produced finish dates at half past two, while `supplyDate` is stored
 * at midnight. A line that finished exactly ON its due date therefore
 * compared as `finish > dueDate` and was booked one working day late.
 *
 * That is not merely a misreport. W_LATE is 10 against a changeover's 1,
 * so lateness dominates the objective — a phantom day on every line
 * that lands on its date pushes the optimiser into genuinely different,
 * worse assignments while it chases the phantom.
 */
const _startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

// ── Gather pending order lines, due within the horizon ─────────────
//
// `horizonDays` was accepted by the route, echoed back in the response
// and stored on the accepted plan — and never used. This function took
// a `now` it also ignored, under a comment claiming it gathered lines
// "within the horizon". Every horizon produced an identical plan, so
// the selector on the screen was a control wired to nothing.
//
// Overdue lines are always in: they are the most urgent work there is,
// and a horizon that dropped them would plan around the problem. Lines
// with no due date are also in — undated work is real work and can fill
// any gap; the horizon is a statement about deadlines, not about which
// work exists.
async function _gatherLines(now, horizonDays) {
  const orders = await Order.find({ status: { $in: ["Approved", "InProgress"] } })
    .populate("customer", "name")
    .lean();

  const horizonEnd = C.addWorkingDays(_startOfDay(now), horizonDays);

  const lines = [];
  let beyondHorizon = 0;
  for (const o of orders) {
    for (const pe of o.pendingElastic || []) {
      const qty = Number(pe.quantity) || 0;
      if (qty <= 0 || !pe.elastic) continue;

      const dueDate = o.supplyDate ? _startOfDay(new Date(o.supplyDate)) : null;
      if (dueDate && dueDate > horizonEnd) { beyondHorizon += 1; continue; }

      lines.push({
        id:        `${o._id}:${pe.elastic}`,
        orderId:   o._id.toString(),
        orderNo:   o.orderNo,
        customer:  o.customer?.name || "—",
        elasticId: pe.elastic.toString(),
        qtyMeters: qty,
        dueDate,
      });
    }
  }
  return { lines, beyondHorizon, horizonEnd };
}

// ── What each machine is already busy with ─────────────────────────
//
// Every machine's cursor started at zero, i.e. the plan assumed a plant
// standing completely idle. It never is: jobs are on the looms when the
// plan is drawn, and their remaining metres have to come off before
// anything proposed here can start. Ignoring them made every projected
// finish optimistic by however long the current run has left, and since
// lateness drives the objective, the plan was confidently scheduling
// into time that was already spoken for.
async function _machineBacklog(machineIds, rateFor) {
  const JobOrder = require("../models/JobOrder");
  const jobs = await JobOrder.find({
    machine: { $in: machineIds },
    status: { $in: ["weaving", "finishing", "checking", "packing"] },
  }).select("machine elastics producedElastic").lean();

  const backlog = new Map();       // machineId → committed working days
  for (const j of jobs) {
    const machineId = String(j.machine);
    const producedBy = new Map(
      (j.producedElastic || [])
        .filter((p) => p?.elastic)
        .map((p) => [String(p.elastic), Number(p.quantity) || 0])
    );

    let days = 0;
    for (const e of j.elastics || []) {
      if (!e?.elastic) continue;
      const elasticId = String(e.elastic);
      const remaining =
        (Number(e.quantity) || 0) - (producedBy.get(elasticId) || 0);
      if (remaining <= 0) continue;
      const mpd = rateFor(elasticId, machineId);
      if (!(mpd > 0)) continue;
      days += Math.ceil(remaining / mpd);
    }
    backlog.set(machineId, (backlog.get(machineId) || 0) + days);
  }
  return backlog;
}

// ── Candidate machines (anything not down for maintenance) ─────────
function _gatherMachines(machines) {
  return machines
    .filter((m) => m.status !== "maintenance")
    .map((m) => {
      // The elastic currently mounted (most common across heads) seeds the
      // changeover baseline so keeping it loaded counts as "no changeover".
      const counts = {};
      for (const h of m.elastics || []) {
        if (h.elastic) counts[h.elastic.toString()] = (counts[h.elastic.toString()] || 0) + 1;
      }
      const currentElasticId =
        Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
      return {
        id:     m._id.toString(),
        ID:     m.ID || "",
        heads:  Number(m.NoOfHead)  > 0 ? Number(m.NoOfHead)  : 1,
        hooks:  Number(m.NoOfHooks) > 0 ? Number(m.NoOfHooks) : 0,
        currentElasticId,
      };
    });
}

function _compatible(machine, elasticHooks) {
  if (machine.hooks > 0 && elasticHooks > 0) return machine.hooks >= elasticHooks;
  return true; // unknown hook data → don't exclude
}

/** A machine's cold-start rate: heads × per-head-day × loom efficiency. */
const _coldStart = (heads) =>
  C.COLDSTART_METERS_PER_HEAD_DAY * (heads > 0 ? heads : 1) * C.LOOM_EFFICIENCY;

// ── Rate (meters/machine-day) for an (elastic, machine) pair ───────
//
// `avgHeads` is the mean head count across the candidate machines, and
// it is what makes the plant fallback usable. The plant rate is metres
// per MACHINE-day averaged over the whole plant, so handing it back
// unscaled gave a 12-head loom and a 4-head loom exactly the same
// throughput — while the posterior branch directly above correctly gave
// them 2400 and 800. The fallback is reached precisely when a pair has
// no history, i.e. when a new product is being planned, so the planner
// was at its most wrong about the biggest machines exactly when it had
// least evidence, and would under-load them.
async function _rateForPair(elasticId, machine, plantRate, avgHeads) {
  const post = await getPairRate(elasticId, machine.id);
  if (post && post.metersPerHeadPerShift > 0) {
    return {
      mpd: toMetersPerMachineDay(post.metersPerHeadPerShift, machine.heads, C.SHIFTS_PER_DAY),
      source: "posterior",
    };
  }
  if (plantRate && plantRate > 0 && avgHeads > 0) {
    return { mpd: plantRate * (machine.heads / avgHeads), source: "plant" };
  }
  return { mpd: _coldStart(machine.heads), source: "coldstart" };
}

// Memoized (60s): same 30-day scan as the ETA engine's plant rate —
// read-side caching keeps regenerate-happy planner usage off the
// transactional path. TTL 0 under jest so tests stay isolated.
const { memoizeAsync } = require("../utils/memo.js");
const _loadPlantRate = memoizeAsync(async function (now) {
  // Plant-wide meters per machine-day over the lookback window.
  const ShiftDetail = require("../models/ShiftDetail");
  const since = new Date(now.getTime() - C.RATE_LOOKBACK_DAYS * 86_400_000);
  const agg = await ShiftDetail.aggregate([
    { $match: { status: "closed", date: { $gte: since } } },
    { $group: {
        _id: { machine: "$machine", date: { $dateToString: { format: "%Y-%m-%d", date: "$date" } } },
        meters: { $sum: "$productionMeters" } } },
    { $group: { _id: null, totalMeters: { $sum: "$meters" }, machineDays: { $sum: 1 } } },
  ]);
  const row = agg[0] || {};
  return (row.machineDays || 0) > 0 ? row.totalMeters / row.machineDays : null;
}, process.env.NODE_ENV === "test" ? 0 : 60_000);

// ── Pure: evaluate a full assignment (lineId → machineId) ──────────
// Returns per-assignment detail plus the scalar objective. Each machine
// runs its lines in due-date order; changeovers and finish dates are
// walked along that order.
function _evaluate(assignmentMap, ctx) {
  const { linesById, machinesById, rate, backlog } = ctx;
  // Floored here, not only at the caller. This is the pure core and the
  // place the finish-vs-due comparison actually happens, so it is where
  // the day granularity has to be guaranteed — a caller that forgets
  // reintroduces a phantom late day on every line that lands on its
  // date, and the objective is dominated by lateness.
  const planDate = _startOfDay(ctx.planDate);
  const perMachine = new Map();
  for (const [lineId, machineId] of assignmentMap) {
    if (!perMachine.has(machineId)) perMachine.set(machineId, []);
    perMachine.get(machineId).push(linesById.get(lineId));
  }

  const results = [];
  let changeovers = 0;
  let totalLate = 0;
  const cursors = [];

  for (const [machineId, list] of perMachine) {
    const machine = machinesById.get(machineId);
    list.sort((a, b) => {
      const da = a.dueDate ? a.dueDate.getTime() : Infinity;
      const db = b.dueDate ? b.dueDate.getTime() : Infinity;
      return da - db || b.qtyMeters - a.qtyMeters;
    });
    // Starts where the machine actually becomes free, not at zero.
    let cursor = backlog?.get(machineId) || 0;
    let last = machine.currentElasticId;
    let seq = 0;
    for (const line of list) {
      // A missing rate used to fall back to `{ mpd: 1 }` — one metre per
      // machine-day, which turns a 5,000 m line into 5,000 working days
      // — and labelled it "coldstart", which is a real source with a
      // real formula. The number was absurd and the label said it was
      // fine. Use the actual cold-start rate and say so.
      const r = rate.get(`${line.elasticId}|${machineId}`)
        || { mpd: _coldStart(machine.heads), source: "coldstart" };
      const isChangeover = !!last && last !== line.elasticId;
      if (isChangeover) { changeovers += 1; cursor += CHANGEOVER_DAYS; }
      const weavingDays = Math.max(1, Math.ceil(line.qtyMeters / r.mpd));
      const startWorkingDay = cursor;
      cursor += weavingDays;
      const finish = C.addWorkingDays(planDate, cursor);
      // Both ends at day granularity. A due date is a DAY, not an
      // instant: delivering on it is on time.
      const due = line.dueDate ? _startOfDay(line.dueDate) : null;
      const late = due ? finish > due : false;
      const lateWorkingDays = late ? C.workingDaysBetween(due, finish) : 0;
      totalLate += lateWorkingDays;
      results.push({
        lineId: line.id, machineId, sequence: seq,
        heads: machine.heads,
        startWorkingDay, weavingDays,
        projectedFinish: finish, dueDate: line.dueDate,
        late, lateWorkingDays,
        changeover: isChangeover, rateSource: r.source,
      });
      last = line.elasticId;
      seq += 1;
    }
    cursors.push(cursor);
  }

  const maxC = cursors.length ? Math.max(...cursors) : 0;
  const avgC = cursors.length ? cursors.reduce((s, x) => s + x, 0) / cursors.length : 0;
  const imbalance = maxC - avgC;
  const score = totalLate * W_LATE + changeovers * W_CHANGE + imbalance * W_BAL;
  return { results, changeovers, totalLate, score };
}

// ── Greedy seed: earliest due date first, finish-/changeover-aware ─
function _greedy(lines, machines, ctx) {
  // Seeded from the work already on each loom, exactly as _evaluate is,
  // or the seed would propose starts the evaluator then disagrees with.
  const state = new Map(machines.map((m) => [
    m.id,
    { cursor: ctx.backlog?.get(m.id) || 0, last: m.currentElasticId },
  ]));
  const assignmentMap = new Map();
  const unplaceable = [];

  const sorted = [...lines].sort((a, b) => {
    const da = a.dueDate ? a.dueDate.getTime() : Infinity;
    const db = b.dueDate ? b.dueDate.getTime() : Infinity;
    return da - db || b.qtyMeters - a.qtyMeters;
  });

  const planDate = _startOfDay(ctx.planDate);

  for (const line of sorted) {
    let best = null, bestCost = Infinity;
    const due = line.dueDate ? _startOfDay(line.dueDate) : null;
    for (const m of machines) {
      if (!_compatible(m, line.hooks)) continue;
      const r = ctx.rate.get(`${line.elasticId}|${m.id}`);
      if (!r) continue;
      const st = state.get(m.id);
      const co = !!st.last && st.last !== line.elasticId;
      const wd = Math.max(1, Math.ceil(line.qtyMeters / r.mpd));
      const cursorAfter = st.cursor + (co ? CHANGEOVER_DAYS : 0) + wd;
      const finish = C.addWorkingDays(planDate, cursorAfter);
      const lateDays = due && finish > due
        ? C.workingDaysBetween(due, finish) : 0;
      const cost = lateDays * W_LATE + (co ? W_CHANGE : 0) + cursorAfter * W_BAL_SMALL;
      if (cost < bestCost) { bestCost = cost; best = m; }
    }
    if (!best) { unplaceable.push(line); continue; }
    assignmentMap.set(line.id, best.id);
    const st = state.get(best.id);
    const r = ctx.rate.get(`${line.elasticId}|${best.id}`);
    const co = !!st.last && st.last !== line.elasticId;
    st.cursor += (co ? CHANGEOVER_DAYS : 0) + Math.max(1, Math.ceil(line.qtyMeters / r.mpd));
    st.last = line.elasticId;
  }
  return { assignmentMap, unplaceable };
}

// ── Bounded local search: move a line to a better machine ──────────
function _localSearch(assignmentMap, lines, machines, ctx) {
  const compatByLine = new Map(
    lines.map((l) => [l.id, machines.filter((m) => _compatible(m, l.hooks) && ctx.rate.get(`${l.elasticId}|${m.id}`))])
  );
  let base = _evaluate(assignmentMap, ctx);
  for (let iter = 0; iter < MAX_ITER; iter++) {
    let improved = false;
    for (const [lineId, curMachine] of assignmentMap) {
      for (const m of compatByLine.get(lineId) || []) {
        if (m.id === curMachine) continue;
        const trial = new Map(assignmentMap);
        trial.set(lineId, m.id);
        const d = _evaluate(trial, ctx);
        if (d.score < base.score - EPS) {
          assignmentMap.set(lineId, m.id);
          base = d;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }
  return base;
}

// ═══════════════════════════════════════════════════════════════════
//  GET /planner/suggest-plan?horizonDays=7
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/suggest-plan",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    // Day granularity throughout: the model counts working days, and a
    // clock reading half past two turns "finishes on the due date" into
    // "one day late" on every line. See _startOfDay.
    const now = _startOfDay(new Date());
    const horizonDays = Math.min(Math.max(Number(req.query.horizonDays) || 7, 1), 60);

    const [gathered, machineDocs, plantRate] = await Promise.all([
      _gatherLines(now, horizonDays),
      Machine.find().lean(),
      _loadPlantRate(now),
    ]);
    const { lines: rawLines, beyondHorizon, horizonEnd } = gathered;
    const machines = _gatherMachines(machineDocs);
    const avgHeads = machines.length
      ? machines.reduce((s, m) => s + m.heads, 0) / machines.length
      : 0;

    // Hydrate elastic names + hook counts for the lines we have.
    const elasticIds = [...new Set(rawLines.map((l) => l.elasticId))];
    const elastics = await Elastic.find({ _id: { $in: elasticIds } })
      .select("name noOfHook").lean();
    const elasticById = new Map(elastics.map((e) => [e._id.toString(), e]));
    const lines = rawLines.map((l) => {
      const e = elasticById.get(l.elasticId);
      return { ...l, elasticName: e?.name || "Elastic", hooks: Number(e?.noOfHook) || 0 };
    });

    // Precompute rates for every (elastic, machine) pair we might use.
    const rate = new Map();
    await Promise.all(
      elasticIds.flatMap((eid) =>
        machines.map(async (m) => {
          if (!_compatible(m, elasticById.get(eid)?.noOfHook || 0)) return;
          rate.set(`${eid}|${m.id}`, await _rateForPair(eid, m, plantRate, avgHeads));
        })
      )
    );

    const linesById = new Map(lines.map((l) => [l.id, l]));
    const machinesById = new Map(machines.map((m) => [m.id, m]));

    // How long each loom stays busy with what is already on it. Falls
    // back to the machine's cold-start rate for an elastic the rate map
    // has no entry for (an in-flight job may run an elastic that is not
    // on any pending line, so it was never priced above).
    const backlog = await _machineBacklog(
      machines.map((m) => m.id),
      (elasticId, machineId) =>
        rate.get(`${elasticId}|${machineId}`)?.mpd
        ?? _coldStart(machinesById.get(machineId)?.heads || 0)
    );

    const ctx = { linesById, machinesById, rate, planDate: now, backlog };

    const { assignmentMap, unplaceable } = _greedy(lines, machines, ctx);
    const evalResult = _localSearch(assignmentMap, lines, machines, ctx);

    // Assemble the response grouped by machine.
    const detailByLine = new Map(evalResult.results.map((r) => [r.lineId, r]));
    const usedMachineIds = new Set([...assignmentMap.values()]);
    const machinePlans = machines
      .filter((m) => usedMachineIds.has(m.id))
      .map((m) => {
        const rows = evalResult.results
          .filter((r) => r.machineId === m.id)
          .sort((a, b) => a.sequence - b.sequence)
          .map((r) => {
            const line = linesById.get(r.lineId);
            return {
              orderId: line.orderId, orderNo: line.orderNo, customer: line.customer,
              elasticId: line.elasticId, elasticName: line.elasticName,
              qtyMeters: line.qtyMeters, heads: r.heads, sequence: r.sequence,
              weavingDays: r.weavingDays, startWorkingDay: r.startWorkingDay,
              projectedFinish: _fmt(r.projectedFinish), dueDate: _fmt(line.dueDate),
              late: r.late, lateWorkingDays: r.lateWorkingDays,
              changeover: r.changeover, rateSource: r.rateSource,
            };
          });
        return {
          machineId: m.id, machineID: m.ID, heads: m.heads,
          changeovers: rows.filter((r) => r.changeover).length,
          rows,
        };
      });

    const placed = assignmentMap.size;
    let late = 0;
    for (const r of detailByLine.values()) if (r.late) late += 1;

    const objective = {
      lines: lines.length,
      placed,
      unplaceable: unplaceable.length,
      // Said out loud, because `lines` now counts only what the horizon
      // admits. A number that quietly shrank when the selector moved
      // would look like work disappearing.
      beyondHorizon,
      onTime: placed - late,
      late,
      totalLateDays: Math.round(evalResult.totalLate),
      changeovers: evalResult.changeovers,
      machinesUsed: usedMachineIds.size,
    };

    // What each loom owes before any of this can start — the figure the
    // whole plan now sits on top of, so it should be legible rather than
    // buried in the start days.
    const committed = machines
      .filter((m) => (backlog.get(m.id) || 0) > 0)
      .map((m) => ({
        machineId: m.id, machineID: m.ID,
        committedWorkingDays: backlog.get(m.id),
        freeFrom: _fmt(C.addWorkingDays(now, backlog.get(m.id))),
      }));

    const assumptions = [
      "Rates use the Bayesian per-(elastic, machine) posterior where available, then the plant average scaled to the machine's head count, then a cold-start estimate.",
      `${C.SHIFTS_PER_DAY} shifts/day; Sundays off. One elastic per machine at a time, all heads dedicated.`,
      `A changeover to a different elastic adds ~${CHANGEOVER_DAYS} day of setup.`,
      `Only order lines due on or before ${_fmt(horizonEnd)} are planned; overdue and undated lines are always included.`,
      "Each machine starts from the work already on it — proposed runs are queued behind the current job, not on top of it.",
      "Accepting records the plan as the day's plan of record — it does not create jobs or move machines.",
    ];

    // Optional Claude rationale (narrative only).
    //
    // Every call — success OR failure — lands in the AI ledger. The
    // failure path used to be a console.warn and nothing else, which
    // meant a rationale that had been broken for a fortnight looked
    // exactly like a rationale nobody had asked for. The id comes back
    // in the response so POST /accept can close the row out: acceptance
    // here means "the plan this rationale explained was adopted", not
    // "the prose was correct" — the honest reading of the one signal a
    // narrative surface can actually give.
    let aiRationale = null, aiGenerated = false, aiSuggestionId = null;
    const claude = anthropic();
    if (claude && placed > 0) {
      const startedAt = Date.now();
      try {
        const facts = machinePlans.slice(0, 8).map((mp) =>
          `Machine ${mp.machineID}: ${mp.rows.map((r) => `${r.elasticName} (${Math.round(r.qtyMeters)} m${r.late ? `, LATE by ${r.lateWorkingDays}d` : ""})`).join(" → ")}`
        ).join("\n");
        const msg = await claude.messages.create({
          model: TEXT_MODEL,
          max_tokens: 400,
          system: systemPrompt("planner-rationale"),
          messages: [{ role: "user", content:
            `Proposed plan (${objective.placed} lines on ${objective.machinesUsed} machines, ` +
            `${objective.late} late, ${objective.changeovers} changeovers):\n${facts}\n\nExplain the plan.` }],
        });
        aiRationale = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        aiGenerated = true;
        aiSuggestionId = await ledger.record({
          surface: "planner-rationale",
          model: TEXT_MODEL,
          promptVersion: promptVersion("planner-rationale"),
          proposed: { rationale: aiRationale, objective },
          latencyMs: Date.now() - startedAt,
          usage: msg.usage,
        });
      } catch (err) {
        console.warn("[planner/suggest-plan] AI failed:", err?.message);
        await ledger.record({
          surface: "planner-rationale",
          model: TEXT_MODEL,
          promptVersion: promptVersion("planner-rationale"),
          latencyMs: Date.now() - startedAt,
          error: err?.message || String(err),
        });
      }
    }

    res.json({
      success: true,
      generatedAt: now.toISOString(),
      horizonDays,
      horizonEnd: _fmt(horizonEnd),
      objective,
      committed,
      machines: machinePlans,
      unplaceable: unplaceable.map((l) => ({
        orderId: l.orderId, orderNo: l.orderNo, customer: l.customer,
        elasticName: l.elasticName, qtyMeters: l.qtyMeters, dueDate: _fmt(l.dueDate),
        reason: "No compatible machine (hook count) with a known rate.",
      })),
      assumptions, aiRationale, aiGenerated,
      // Hand back to POST /accept so the outcome can be recorded.
      aiSuggestionId: aiSuggestionId ? String(aiSuggestionId) : null,
    });
  })
);

// ═══════════════════════════════════════════════════════════════════
//  POST /planner/accept — freeze a proposal as the plan of record
// ═══════════════════════════════════════════════════════════════════
router.post(
  "/accept",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const { generatedAt, horizonDays, objective, machines, assumptions, aiSuggestionId } = req.body || {};
    if (!Array.isArray(machines)) {
      return res.status(400).json({ success: false, message: "machines[] is required" });
    }

    const assignments = [];
    for (const mp of machines) {
      for (const r of mp.rows || []) {
        assignments.push({
          machine:    mongoose.Types.ObjectId.isValid(mp.machineId) ? mp.machineId : undefined,
          machineID:  mp.machineID || "",
          heads:      r.heads || mp.heads || 0,
          order:      mongoose.Types.ObjectId.isValid(r.orderId) ? r.orderId : undefined,
          orderNo:    r.orderNo,
          customer:   r.customer || "",
          elastic:    mongoose.Types.ObjectId.isValid(r.elasticId) ? r.elasticId : undefined,
          elasticName:r.elasticName || "",
          qtyMeters:  r.qtyMeters || 0,
          weavingDays:r.weavingDays || 0,
          sequence:   r.sequence || 0,
          startWorkingDay: r.startWorkingDay || 0,
          projectedFinish: r.projectedFinish ? new Date(r.projectedFinish) : undefined,
          dueDate:    r.dueDate ? new Date(r.dueDate) : undefined,
          late:       !!r.late,
          lateWorkingDays: r.lateWorkingDays || 0,
          changeover: !!r.changeover,
          rateSource: r.rateSource || "coldstart",
        });
      }
    }

    const actor = req.user?.name || req.user?.username || "admin";

    // Supersede-then-create, as one unit. Apart, two admins accepting at
    // the same moment each superseded what they could see and each
    // created a plan, leaving TWO accepted rows — and "the plan of
    // record" then meant whichever /latest happened to sort first. The
    // point of superseding is that exactly one plan is current.
    const session = await mongoose.startSession();
    let plan;
    try {
      await session.withTransaction(async () => {
        await ProductionPlan.updateMany(
          { status: "accepted" },
          { $set: { status: "superseded" } },
          { session }
        );
        const [created] = await ProductionPlan.create([{
          horizonDays: Number(horizonDays) || 7,
          generatedAt: generatedAt ? new Date(generatedAt) : new Date(),
          acceptedBy: actor,
          objective: objective || {},
          assignments,
          assumptions: Array.isArray(assumptions) ? assumptions : [],
          status: "accepted",
        }], { session });
        plan = created;
      });
    } finally {
      session.endSession();
    }

    // Close out the rationale row, if the client carried the id back.
    // Outside the transaction on purpose: a ledger failure must never
    // roll back an accepted plan of record.
    if (aiSuggestionId) {
      await ledger.settle(aiSuggestionId, {
        outcome: "accepted",
        decidedBy: req.user?._id,
      });
    }

    res.json({ success: true, planId: plan._id, acceptedAt: plan.acceptedAt });
  })
);

// ═══════════════════════════════════════════════════════════════════
//  GET /planner/latest — the current accepted plan of record
// ═══════════════════════════════════════════════════════════════════
router.get(
  "/latest",
  isAdmin("admin"),
  catchAsyncErrors(async (req, res) => {
    const plan = await ProductionPlan.findOne({ status: "accepted" })
      .sort({ acceptedAt: -1 }).lean();
    res.json({ success: true, plan: plan || null });
  })
);

// Exposed for unit tests (pure optimizer core, no DB).
router._planner = { _evaluate, _greedy, _localSearch, _compatible };

module.exports = router;
