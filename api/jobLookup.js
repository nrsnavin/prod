'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS — A SCANNED NUMBER, STALE JOBS, OUTLIERS, THE PHONE'S DETAIL  (part of /api/v2/job)
//
//    GET  /by-number/:jobNo
//    GET  /stale
//    GET  /wastage-outliers
//    GET  /:jobId
//
//  api/job.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const { indiaDay } = require('../utils/indiaLabel');
const mongoose = require('mongoose');
const { sendError } = require('../utils/routeError');
const JobOrder    = require('../models/JobOrder');
const Wastage     = require('../models/Wastage');
const ShiftDetail = require('../models/ShiftDetail');
const { shiftFigures, clockToMinutes } = require('../utils/shiftFigures');
// Job status flow, transition rules, per-stage timestamps and the
// stampStage helper all live in domain/jobStatus.js — the single
// source of truth (was previously re-encoded three times in this file).
const { enteredAtField, liveJobStatus } = require('../domain/jobStatus');
const { outsourcingBlockers, outsourcingDerived } = require('../utils/outsourcingRecord');
const { machineOfWastage } = require('../utils/wastageMachine');
const factoryDay = require('../utils/factoryDay');
const { round3 } = require('../utils/quantity');
const router = express.Router();

// ══════════════════════════════════════════════════════════════
//  GET /by-number/:jobNo — OPEN A JOB FROM A SCANNED LABEL
//
//  Three of the four labels the mill prints name their job by NUMBER
//  rather than by id:
//
//    BOX|<packing id>|J:1042          packing box
//    WARP|J:1042|B:3|W:<warping id>   warping beam
//    COVB|J:1042|C:<id>|B:2|E:<id>    covering beam
//
//  The phone opens a job screen from an id on its own. From a number
//  it has to ask, and this is the ask. See flu scan_payload.dart for
//  the parser at the other end.
//
//  ── Why not reuse /dc/job-order ────────────────────────────────
//  That one resolves a job to its ORDER, for raising a challan, and
//  returns a whole order payload with its lines. This is the plain
//  hop — number to job — and a scanner that had to drag an order
//  across mill wifi to open a job screen would be slower for no
//  reason.
//
//  ── What comes back, and why more than an id ───────────────────
//  The number, the status and the customer, because the phone pushes
//  the job screen the moment this returns and the detail fetch has
//  not landed yet. Without them the screen is blank for a second or
//  two, which on mill wifi reads as a hang rather than as loading.
// ══════════════════════════════════════════════════════════════
router.get('/by-number/:jobNo', async (req, res) => {
  try {
    const raw = String(req.params.jobNo ?? '').trim();
    const n = Number(raw);

    // Anchored on purpose. `Number(' 12 ')` is 12 and `Number('')` is
    // 0, so a blank segment would otherwise look like job zero.
    if (!/^\d{1,9}$/.test(raw) || !Number.isInteger(n) || n <= 0) {
      return res.status(400).json({
        success: false,
        message: 'That is not a job number.',
      });
    }

    // jobOrderNo comes from an auto-increment counter, so duplicates
    // mean the data has been through surgery. Opening one anyway
    // would show a real job screen for the WRONG job, which is worse
    // than opening none — so it asks rather than guesses. Same rule
    // as /dc/job-order.
    const hits = await JobOrder.find({ jobOrderNo: n })
      .select('jobOrderNo status customer order')
      .populate('customer', 'name')
      .limit(2)
      .lean();

    if (hits.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No job numbered ${n}.`,
      });
    }
    if (hits.length > 1) {
      return res.status(409).json({
        success: false,
        message: `More than one job is numbered ${n}. Pick it from the list.`,
      });
    }

    const job = hits[0];
    return res.status(200).json({
      success: true,
      job: {
        id: String(job._id),
        jobOrderNo: job.jobOrderNo,
        status: job.status ?? '',
        customerName: job.customer?.name ?? '',
        orderId: job.order ? String(job.order) : null,
      },
    });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /stale?days=14
//  Jobs that have been sitting in the same status for more than
//  `days` days. Powers the AIAdvisor "stale jobs" card.
//
//  Each non-terminal stage records its entry timestamp on the
//  job document (weavingAt, finishingAt, checkingAt, packingAt).
//  The "entered current status at" is whichever timestamp the
//  status maps to; preparatory falls back to createdAt because no
//  preparatoryAt field exists.
// ══════════════════════════════════════════════════════════════
router.get('/stale', async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.query.days, 10) || 14);

    const jobs = await JobOrder.find({
      status: liveJobStatus(),
    })
      .select('jobOrderNo status createdAt weavingAt finishingAt checkingAt packingAt customer')
      .populate('customer', 'name')
      .lean();

    const enteredAt = (j) => {
      const field = enteredAtField(j.status);
      return (field && j[field]) || j.createdAt;
    };

    const stale = jobs
      .map((j) => {
        const enteredOn = enteredAt(j);
        const idleDays  = Math.floor(
          (Date.now() - new Date(enteredOn).getTime()) / 86_400_000
        );
        return { job: j, enteredOn, idleDays };
      })
      .filter((x) => x.idleDays > days)
      .sort((a, b) => b.idleDays - a.idleDays)
      .map((x) => ({
        jobId:        x.job._id,
        jobOrderNo:   x.job.jobOrderNo,
        status:       x.job.status,
        customerName: x.job.customer?.name ?? '—',
        enteredOn:    x.enteredOn,
        idleDays:     x.idleDays,
      }));

    return res.json({
      success:   true,
      windowDays: days,
      jobs:      stale,
      count:     stale.length,
    });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ══════════════════════════════════════════════════════════════
//  GET /wastage-outliers?lookbackDays=30&sigmaThreshold=2
//  Machines whose wastage over the last 7 days is more than
//  `sigmaThreshold` standard deviations above what a week normally
//  is on that machine. The phone's advisor shows the count.
//
//  ── Like with like ──────────────────────────────────────────────
//  The baseline is the machine's own DAILY totals over the days
//  before the last seven — quiet days counted as nothing — and the
//  last seven days are held against a week of that:
//
//      a normal week   = 7 × the daily average
//      its spread      = √7 × the daily standard deviation
//      high            = this week > normal + threshold × spread
//
//  This used to take the average size (and spread) of ONE wastage
//  entry as the baseline and compare the seven-day TOTAL with it. A
//  loom wasting a steady 20 m a day had entries averaging 20 m and a
//  week's total of 140 m, so it was "high" every day — as was any
//  loom with two entries in a week.
//
//  ── Which machine ───────────────────────────────────────────────
//  The entry's own (utils/wastageMachine.js): kept on the record,
//  else the loom its operator ran the job on, else the job's. Read
//  off the job alone, a loom's wastage vanished from here the moment
//  the job went to finishing and stopped pointing at it.
//
//  Guard: a machine needs at least 5 wastage entries in the baseline
//  days before it is judged at all. New machines, or ones with
//  sparse data, don't fire on their first dirty shift.
// ══════════════════════════════════════════════════════════════
router.get('/wastage-outliers', async (req, res) => {
  try {
    const recentDays = 7;
    const minSamples = 5;
    // At least a week of baseline behind the week being judged.
    const asked      = parseInt(req.query.lookbackDays, 10);
    const lookback   = Math.min(365, Math.max(2 * recentDays, asked > 0 ? asked : 30));
    const sigma      = parseFloat(req.query.sigmaThreshold);
    const threshold  = Math.max(1, Number.isFinite(sigma) ? sigma : 2);
    const baselineDays = lookback - recentDays;

    // Days are India's: an entry at one in the morning is that day's.
    const today      = factoryDay.calendarDay(new Date());
    const recentFrom = new Date(today.getTime() - (recentDays - 1) * factoryDay.DAY);
    const baseFrom   = new Date(today.getTime() - (lookback - 1) * factoryDay.DAY);

    const rows = await Wastage.aggregate([
      { $match: { createdAt: { $gte: factoryDay.dayStart(baseFrom) } } },
      { $lookup: {
          from:         JobOrder.collection.collectionName,
          localField:   'job',
          foreignField: '_id',
          as:           'jobDoc',
        } },
      { $unwind: { path: '$jobDoc', preserveNullAndEmptyArrays: true } },
      ...machineOfWastage(),
      { $match: { machineRef: { $ne: null } } },
      { $project: { machine: '$machineRef', quantity: 1, createdAt: 1 } },
    ]);

    // Per machine: each baseline day's total, and the last week's.
    const buckets = new Map();
    for (const r of rows) {
      const key = String(r.machine);
      if (!buckets.has(key)) buckets.set(key, { byDay: new Map(), entries: 0, recent: 0 });
      const b = buckets.get(key);
      const day = factoryDay.calendarDay(r.createdAt);
      const quantity = Number(r.quantity) || 0;
      if (day && day >= recentFrom) { b.recent += quantity; continue; }
      const dayKey = day ? day.getTime() : 0;
      b.byDay.set(dayKey, (b.byDay.get(dayKey) || 0) + quantity);
      b.entries += 1;
    }

    const r2 = (x) => Math.round(x * 100) / 100;
    const candidateIds = [];
    const meta         = new Map();
    for (const [mid, { byDay, entries, recent }] of buckets) {
      if (entries < minSamples) continue;
      const totals = [...byDay.values()];
      const mean = totals.reduce((a, x) => a + x, 0) / baselineDays;
      // Over every baseline day: the quiet ones are zeros, not missing.
      const variance = (
        totals.reduce((acc, x) => acc + (x - mean) ** 2, 0)
        + (baselineDays - totals.length) * mean ** 2
      ) / baselineDays;
      const stddev = Math.sqrt(variance);
      if (stddev <= 0) continue;
      const expectedTotal = recentDays * mean;
      const ceiling = expectedTotal + threshold * Math.sqrt(recentDays) * stddev;
      if (recent > ceiling) {
        candidateIds.push(mid);
        meta.set(mid, {
          recentTotal:   r2(recent),
          // What a week normally is on this machine, and the line crossed.
          expectedTotal: r2(expectedTotal),
          ceiling:       r2(ceiling),
          // Per day, over the baseline days.
          mean:          r2(mean),
          stddev:        r2(stddev),
          baselineDays,
        });
      }
    }

    if (candidateIds.length === 0) {
      return res.json({ success: true, machines: [], count: 0 });
    }

    const Machine = require('../models/Machine');
    const machines = await Machine.find({
      _id: { $in: candidateIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).select('ID manufacturer').lean();

    const out = machines
      .map((m) => ({
        machineId:    m._id,
        machineCode:  m.ID,
        manufacturer: m.manufacturer,
        ...meta.get(String(m._id)),
      }))
      .sort((a, b) => b.recentTotal - a.recentTotal);

    return res.json({ success: true, machines: out, count: out.length });
  } catch (err) {
    return sendError(req, res, err);
  }
});

// ─────────────────────────────────────────────────────────────
//  13. JOB DETAIL (alternate — used by Flutter /:jobId)
// ─────────────────────────────────────────────────────────────
router.get('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const job = await JobOrder.findById(jobId)
      // `phoneNumber`: this asked for `phone`, which a customer does not
      // have, so the phone on the job page was always blank.
      .populate('customer', 'name phoneNumber')
      .populate('order',    'orderNo status')
      .populate('machine',  'ID manufacturer NoOfHead NoOfHooks status elastics loading')
      .populate('createdBy',   'name role')
      .populate('updatedBy',   'name role')
      .populate('weavingBy',   'name role')
      .populate('finishingBy', 'name role')
      .populate('checkingBy',  'name role')
      .populate('packingBy',   'name role')
      .populate('completedBy', 'name role')
      .populate('cancelledBy', 'name role')
      .populate('elastics.elastic',        'name weaveType weight')
      .populate('producedElastic.elastic', 'name')
      .populate('packedElastic.elastic',   'name')
      .populate('wastageElastic.elastic',  'name')
      .populate({
        path: 'warping',
        populate: {
          path: 'warpingPlan',
          populate: [
            { path: 'beams.sections.warpYarn', model: 'RawMaterial', select: 'name unit' },
            { path: 'beams.sections.yarnLot', model: 'YarnLot', select: 'lotNo shade status' },
          ],
        },
      })
      .populate({ path: 'covering', populate: { path: 'elasticPlanned.elastic', select: 'name' } })
      // shiftDetails is NOT populated here — see below. The array on the
      // job was never written to by anything, so populating it returned
      // an empty list for every job that has ever existed.
      .populate({ path: 'wastages', model: 'Wastage', populate: [{ path: 'elastic', model: 'Elastic', select: 'name' }, { path: 'employee', model: 'Employee', select: 'name' }] })
      .populate({ path: 'packingDetails', model: 'Packing', populate: [{ path: 'elastic', model: 'Elastic', select: 'name' }, { path: 'checkedBy', model: 'Employee', select: 'name' }, { path: 'packedBy', model: 'Employee', select: 'name' }] })
      .lean();

    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    // ── The shifts run on this job ───────────────────────────────────
    // Read by their `job` ref, not off `JobOrder.shiftDetails`. That
    // array is denormalised and no code has ever pushed to it, so
    // populating it returned an empty list for every job that has ever
    // existed — a fact-shaped empty, which reads as "no shifts yet"
    // rather than as a bug. Querying the shifts themselves also picks up
    // every shift recorded before this was noticed.
    const shiftDocs = await ShiftDetail.find({ job: job._id })
      .populate('machine',  'ID NoOfHead status')
      .populate('employee', 'name department')
      .populate('elastics.elastic', 'name weaveType')
      .sort({ date: 1, _id: 1 })
      .lean();

    const fmtDate = d => d ? indiaDay(d, { day: '2-digit', month: 'short', year: 'numeric' }) : null;
    const mapElasticQty = arr => (arr || []).map(e => ({ elasticId: e.elastic?._id || null, elasticName: e.elastic?.name || 'Unknown', quantity: e.quantity || 0 }));
    const fpUser = u => u ? { name: u.name, role: u.role } : null;

    const w = job.warping; const wp = w?.warpingPlan;
    // The ids are what the job page links and acts on (its warping and
    // covering card); without them every link there was plain text.
    const warping = w ? {
      _id: String(w._id),
      hasPlan: !!wp,
      status: w.status || 'open', date: fmtDate(w.date), completedDate: fmtDate(w.completedDate),
      noOfBeams: wp?.noOfBeams || 0, remarks: wp?.remarks || '',
      beams: (wp?.beams || []).map(b => ({
        beamNo: b.beamNo,
        totalEnds: b.totalEnds,
        sections: (b.sections || []).map((s, i) => ({
          sectionNo: i + 1,
          yarnName: s.warpYarn?.name || 'Unknown',
          yarnUnit: s.warpYarn?.unit || '',
          ends: s.ends || 0,
          // Prefer the snapshot over the populated lot: it is what the
          // printed programme said, and it survives the lot record.
          lotNo: s.lotNo || s.yarnLot?.lotNo || '',
          shade: s.shade || s.yarnLot?.shade || '',
        })),
      })),
    } : null;

    const co = job.covering;
    const covering = co ? {
      _id: String(co._id),
      status: co.status || 'open', date: fmtDate(co.date), completedDate: fmtDate(co.completedDate), remarks: co.remarks || '', elasticPlanned: mapElasticQty(co.elasticPlanned),
      // The beams weighed so far, so the job page can show them and add one.
      beamEntries: (co.beamEntries || []).map((b) => ({ _id: String(b._id), beamNo: b.beamNo, weight: b.weight, note: b.note || '' })),
      // Summed from the beams themselves when there are any: the stored
      // total is only kept by the add-beam route.
      producedWeight: (co.beamEntries || []).length
        ? Math.round((co.beamEntries || []).reduce((t, b) => t + (Number(b.weight) || 0), 0) * 1000) / 1000
        : Number(co.producedWeight) || 0,
    } : null;

    const shiftDetails = shiftDocs.map(d => {
      // Until an admin verifies, the operator's numbers live in the
      // submitted* fields; the canonical ones are still 0. Reporting
      // those makes a shift that ran all night look idle, so
      // shiftFigures owns the fallback and `verified` says which it is.
      const { timer, meters } = shiftFigures(d);
      return {
        id: d._id, date: fmtDate(d.date), shift: d.shift, status: d.status,
        timer: timer || '00:00:00',
        productionMeters: meters,
        verified: d.status === 'closed',
        machineName: d.machine?.ID || '-', machineNoOfHead: d.machine?.NoOfHead || 0,
        operatorName: d.employee?.name || '-', operatorDept: d.employee?.department || '',
        elastics: (d.elastics || []).map(he => ({ head: he.head, elasticName: he.elastic?.name || '-' })),
        description: d.description || '', feedback: d.feedback || '',
      };
    });

    // ── What the shifts add up to ────────────────────────────────────
    // The list answers "which shifts", this answers "how much did they
    // make and how long did it take" without the reader adding up rows
    // by eye. Verified and merely-submitted are counted separately,
    // because a claim and a checked figure are not the same fact.
    const shiftSummary = shiftDocs.reduce((acc, d) => {
      const { timer, meters } = shiftFigures(d);
      acc.shifts += 1;
      acc.produced += meters;
      acc.workedMinutes += clockToMinutes(timer);
      if (d.shift === 'DAY' || d.shift === 'NIGHT') acc.byShift[d.shift] += meters;
      if (d.status === 'closed') acc.closed += 1;
      else if (d.status === 'pending_verification') acc.awaitingVerification += 1;
      else acc.open += 1;
      const at = d.date ? new Date(d.date) : null;
      if (at) {
        if (!acc.firstDate || at < acc.firstDate) acc.firstDate = at;
        if (!acc.lastDate  || at > acc.lastDate)  acc.lastDate  = at;
      }
      return acc;
    }, {
      shifts: 0, produced: 0, workedMinutes: 0,
      byShift: { DAY: 0, NIGHT: 0 },
      closed: 0, awaitingVerification: 0, open: 0,
      firstDate: null, lastDate: null,
    });
    // Both shifts run 12h, so this is output per hour actually worked —
    // not per hour rostered, which would flatter a machine that stood
    // idle for half of it.
    // Sums of decimals: 1000.2 + 2000.4 is 3000.6000000000004.
    shiftSummary.produced = round3(shiftSummary.produced);
    shiftSummary.byShift = { DAY: round3(shiftSummary.byShift.DAY), NIGHT: round3(shiftSummary.byShift.NIGHT) };
    shiftSummary.metresPerHour = shiftSummary.workedMinutes > 0
      ? Math.round((shiftSummary.produced / (shiftSummary.workedMinutes / 60)) * 10) / 10
      : 0;
    shiftSummary.firstDateLabel = fmtDate(shiftSummary.firstDate);
    shiftSummary.lastDateLabel  = fmtDate(shiftSummary.lastDate);

    const wastages = (job.wastages || []).map(wst => ({
      id: wst._id, elasticName: wst.elastic?.name || '-', employeeName: wst.employee?.name || '-',
      quantity: wst.quantity || 0, penalty: wst.penalty || 0, reason: wst.reason || '', date: fmtDate(wst.createdAt),
      // Who entered it — not always the person it is recorded against.
      recordedByName: wst.recordedByName || '',
    }));
    // ── The boxes packed ─────────────────────────────────────────────
    // A packing record is one box: its metres, joints, three weights, a
    // size and a stretch, who packed it and who checked it.
    //
    // This row used to be mapped from `quantity`, `rolls`,
    // `metersPerRoll`, `total`, `batch` and `status` — fields a packing
    // record has never had — so every box went out as 0 m, 0 rolls,
    // batch "-", status "open", and the phone's Packing tab on a job read
    // "Packed 0m" whatever had been packed.
    //
    // The first block is the box as it is. The second repeats it under
    // the names the phone app already reads, so an installed app shows
    // the metres too: one box is one roll, and a box has no dispatch
    // state of its own (a challan ships metres, not boxes), so its
    // status is simply "packed".
    const packingDetails = (job.packingDetails || []).map(pk => {
      const meter = Number(pk.meter) || 0;
      const packedBy = pk.packedBy?.name || '-';
      return {
        id: pk._id, elasticName: pk.elastic?.name || '-', date: fmtDate(pk.createdAt),
        meter, joints: Number(pk.joints) || 0,
        netWeight: Number(pk.netWeight) || 0, tareWeight: Number(pk.tareWeight) || 0, grossWeight: Number(pk.grossWeight) || 0,
        size: pk.size || '', stretch: pk.stretch || '',
        packedBy, checkedBy: pk.checkedBy?.name || '-',

        quantity: meter, total: meter, rolls: 1, metersPerRoll: meter,
        employeeName: packedBy, weight: Number(pk.netWeight) || 0,
        batch: '-', status: 'packed',
      };
    });

    // 🪪 Newest-first fingerprint feed for the timeline UI
    const fingerprints = (job.fingerprints || [])
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .map(f => ({
        code:    f.code,
        label:   f.label,
        hash:    f.hash,
        shortId: f.shortId,
        at:      f.at,
        actor:   f.actor || { id: 'system', name: 'System', role: 'system' },
        meta:    f.meta  || {},
      }));

    return res.json({
      success: true,
      data: {
        id: job._id, jobOrderNo: job.jobOrderNo, jobNo: `J-${job.jobOrderNo}`,
        // The version an edit sends back as expectedVersion (utils/versioning.js).
        __v: job.__v ?? 0,
        date: fmtDate(job.date), status: job.status,
        customerName: job.customer?.name || '-', customerPhone: job.customer?.phoneNumber || '',
        orderNo: job.order?.orderNo || '',
        machine: job.machine ? {
          machineId: job.machine._id, machineName: job.machine.ID || '-', machineNoOfHead: job.machine.NoOfHead || 0,
          // The heads this job's plan runs, and what is on each head of
          // the plan — null for a head marked free.
          headsInUse: (job.machine.elastics || []).length
            ? (job.machine.elastics || []).filter((h) => h && h.elastic).length
            : job.machine.NoOfHead || 0,
          headPlan: (job.machine.elastics || []).filter((h) => h && h.head != null)
            .map((h) => ({ head: h.head, elastic: h.elastic ? String(h.elastic) : null })),
          manufacturer: job.machine.manufacturer || '', status: job.machine.status || 'free',
          // Still being loaded for this job: nothing counted until marked running.
          loading: job.machine.status === 'running' && !!job.machine.loading,
        } : null,
        orderId: job.order?._id ?? job.order ?? null,
        plannedElastics: mapElasticQty(job.elastics).map((row, i) => ({
          ...row,
          frozen: !!job.elastics[i]?.frozen,
          plannedBeforeFreeze: job.elastics[i]?.plannedBeforeFreeze ?? null,
          addedMidRun: !!job.elastics[i]?.addedMidRun,
          reason: job.elastics[i]?.frozenReason || job.elastics[i]?.addedReason || '',
        })),
        producedElastics: mapElasticQty(job.producedElastic),
        packedElastics: mapElasticQty(job.packedElastic),
        wastageElastics: mapElasticQty(job.wastageElastic),
        warping, covering, shiftDetails, shiftSummary, wastages, packingDetails,
        // An outsourced job is made by a vendor, so it has no shifts of its
        // own — the detail page shows the vendor in place of the (empty)
        // shift list rather than an "unrecorded" empty state.
        productionMode:  job.productionMode || 'in_house',
        outsourceVendor: job.outsourceVendor || '',
        // The vendor record, with the figures the planner reads rather
        // than types, and what still blocks the move to finishing.
        outsourcing: job.productionMode === 'outsource'
          ? {
              ...(job.outsourcing?.toObject?.() ?? job.outsourcing ?? {}),
              derived:  outsourcingDerived(job.outsourcing),
              blockers: outsourcingBlockers(job.outsourcing),
            }
          : null,
        // ── Per-stage audit pointers ──
        createdBy:   fpUser(job.createdBy),
        createdAt:   job.createdAt || null,
        updatedBy:   fpUser(job.updatedBy),
        updatedAt:   job.updatedAt || null,
        weavingBy:   fpUser(job.weavingBy),
        weavingAt:   job.weavingAt   || null,
        finishingBy: fpUser(job.finishingBy),
        finishingAt: job.finishingAt || null,
        checkingBy:  fpUser(job.checkingBy),
        checkingAt:  job.checkingAt  || null,
        packingBy:   fpUser(job.packingBy),
        packingAt:   job.packingAt   || null,
        completedBy: fpUser(job.completedBy),
        completedAt: job.completedAt || null,
        cancelledBy: fpUser(job.cancelledBy),
        cancelledAt: job.cancelledAt || null,
        // 🪪 Full audit timeline (newest-first)
        fingerprints,
      },
    });
  } catch (err) {
    console.error('[GET /jobs/:jobId]', err);
    // Generic message — raw err.message can leak internals (driver
    // errors, paths) to the client.
    return res
      .status(500)
      .json({ success: false, message: 'Failed to load job detail' });
  }
});

module.exports = router;
