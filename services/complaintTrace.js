'use strict';
// ══════════════════════════════════════════════════════════════════
//  WHO ELSE GOT THE BAD YARN
//
//  One customer has called about a shade band. The question that
//  matters is not why — that is services/defectRootCause.js — but WHO
//  ELSE. The lot on that beam went into other beams, other jobs, other
//  orders, other customers, and some of those have already shipped.
//
//  The lot trail was built to answer "where did this lot go". This runs
//  it from a complaint: job → lots → every other job carrying them →
//  their orders, customers and challans.
//
//  ── There is no model here and there should not be ───────────────
//  This is joins. Every row is reproducible by hand from four
//  collections, which is the property you want when the output is a
//  list of customers somebody is about to telephone.
//
//  ── The bias, stated once ────────────────────────────────────────
//  Every judgement call in this file is resolved toward INCLUDING a
//  job rather than excluding it, because the two mistakes are not
//  equal. A job listed that turns out to be fine costs somebody five
//  minutes checking it. A job omitted is a customer who finds the
//  defect themselves. So:
//
//    • lots with no elastic attribution are included even when the
//      complaint names an elastic (a batch that did not record which
//      product it warped could have been this one);
//    • lots are matched by id AND by number, because a programme
//      written before lots were documents carries only the number;
//    • PLANNED lots count, not just issued ones — a programme naming
//      the lot is a job about to run it, and that is the one you can
//      still stop.
//
//  ── The honest limit: challans do not name jobs ──────────────────
//  DeliveryChallan links to an ORDER and lists elastics. It has no job
//  reference. So "has this shipped?" cannot always be answered at job
//  granularity: if an order carries two jobs for the same elastic and
//  one challan went out, the challan belongs to one of them and the
//  data does not say which.
//
//  That ambiguity is REPORTED, not resolved. Every exposure row
//  carries `certain`, and a false one means "a challan covering this
//  product went to this customer, but this job may not be what was on
//  it". Guessing would produce a confident list with the wrong names on
//  it, and somebody would ring a customer to apologise for a defect
//  they never received.
// ══════════════════════════════════════════════════════════════════

const mongoose        = require('mongoose');
const Complaint       = require('../models/Complaints');
const JobOrder        = require('../models/JobOrder');
const WarpingPlan     = require('../models/WarpingPlan');
const WarpingBatch    = require('../models/WarpingBatch');
const DeliveryChallan = require('../models/DeliveryChallan');

/** Challan statuses that mean goods have left the building. */
const GONE = ['dispatched', 'delivered'];

/** A job at or past this point has finished production. */
const FINISHED = ['completed'];

const idOf = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

// ── Step one: the lots behind the complained-of job ──────────────

/**
 * Every lot the job is committed to, from both places a lot is recorded.
 *
 * The warping PROGRAMME names the lot each beam section will run off;
 * the warping BATCH records what actually came off the rack. Both are
 * read, and `source` keeps them apart — a planned lot can still change
 * and an issued one cannot.
 *
 * `attribution` says whether the lot is tied to a specific elastic or
 * was recorded job-wide. Job-wide lots survive an elastic filter, for
 * the reason in the header.
 */
async function lotsForJob(jobId, { elasticId = null } = {}) {
  const [plans, batches] = await Promise.all([
    WarpingPlan.find({ job: jobId })
      .select('beams.elastic beams.sections.yarnLot beams.sections.lotNo beams.sections.shade')
      .populate('beams.elastic', 'name')
      // ── Deliberately NOT populating beams.sections.yarnLot ──
      //
      // Populate replaces the reference with the document, and with a
      // document that no longer exists it replaces it with null. A lot
      // that was archived — which is to say the OLD stock, the stock
      // most likely to be behind a complaint — would therefore vanish
      // from the trace entirely, and the report would come back clean.
      //
      // The raw id is kept instead and the lot numbers are fetched
      // separately below, so a missing lot costs a display label and
      // never costs the trace.
      .lean(),
    WarpingBatch.find({ job: jobId })
      .select('batchNo elastics allocations status')
      .populate('elastics', 'name')
      .lean(),
  ]);

  // Lot numbers for whatever the programme referenced, gathered in one
  // query. Absent entries stay absent rather than removing the lot.
  const planLotIds = [...new Set(plans.flatMap((p) =>
    (p.beams || []).flatMap((b) => (b.sections || []).map((s) => idOf(s.yarnLot)))
  ).filter(Boolean))];
  const lotDocs = planLotIds.length
    ? await mongoose.model('YarnLot').find({ _id: { $in: planLotIds } })
        .select('lotNo shade').lean()
    : [];
  const lotById = new Map(lotDocs.map((l) => [String(l._id), l]));

  const byKey = new Map();

  /** Fold one sighting of a lot into the set, strengthening what is known. */
  const add = ({ yarnLot, lotNo, shade, materialName, source, elasticIds, elasticNames }) => {
    const key = yarnLot || lotNo;
    if (!key) return;
    if (!byKey.has(key)) {
      byKey.set(key, {
        yarnLot: yarnLot || null,
        lotNo: lotNo || '',
        shade: shade || '',
        materialName: materialName || '',
        source,
        elasticIds: new Set(),
        elasticNames: new Set(),
      });
    }
    const row = byKey.get(key);
    // Issued beats planned: the yarn is off the rack, which is the
    // stronger fact and the one that cannot be revised.
    if (source === 'issued') row.source = 'issued';
    if (!row.shade && shade) row.shade = shade;
    if (!row.materialName && materialName) row.materialName = materialName;
    for (const e of elasticIds || []) if (e) row.elasticIds.add(String(e));
    for (const n of elasticNames || []) if (n) row.elasticNames.add(n);
  };

  for (const plan of plans) {
    for (const beam of plan.beams || []) {
      const eId = idOf(beam.elastic);
      const eName = beam.elastic?.name || null;
      for (const s of beam.sections || []) {
        const lotId = idOf(s.yarnLot);
        const doc = lotId ? lotById.get(lotId) : null;
        add({
          yarnLot: lotId,
          // The section's own snapshot first: it is what the programme
          // sheet printed and it outlives the lot document.
          lotNo: s.lotNo || doc?.lotNo || '',
          shade: s.shade || doc?.shade || '',
          source: 'planned',
          elasticIds: [eId],
          elasticNames: [eName],
        });
      }
    }
  }

  for (const b of batches) {
    const eIds = (b.elastics || []).map(idOf);
    const eNames = (b.elastics || []).map((e) => e?.name).filter(Boolean);
    for (const a of b.allocations || []) {
      add({
        yarnLot: idOf(a.yarnLot),
        lotNo: a.lotNo || '',
        shade: a.shade || '',
        materialName: a.materialName || '',
        source: 'issued',
        elasticIds: eIds,
        elasticNames: eNames,
      });
    }
  }

  const lots = [...byKey.values()].map((r) => ({
    yarnLot: r.yarnLot,
    lotNo: r.lotNo,
    shade: r.shade,
    materialName: r.materialName,
    source: r.source,
    elasticIds: [...r.elasticIds],
    elasticNames: [...r.elasticNames],
    // A lot recorded without an elastic could have warped anything on
    // the job, so an elastic filter must not remove it.
    attribution: r.elasticIds.size > 0 ? 'elastic' : 'job-wide',
  }));

  if (!elasticId) return lots;

  const want = String(elasticId);
  return lots.filter((l) => l.attribution === 'job-wide' || l.elasticIds.includes(want));
}

// ── Step two: everywhere else those lots went ────────────────────

/**
 * Every OTHER job carrying any of these lots, programmed or issued.
 *
 * Matched on lot id and lot number together. A programme written before
 * yarn lots were their own documents carries a number and no reference;
 * querying only ids would silently drop exactly the oldest stock, which
 * is the stock most likely to be the problem.
 */
async function jobsCarryingLots(lots, { excludeJobId } = {}) {
  const ids = lots.map((l) => l.yarnLot).filter(Boolean);
  const nos = lots.map((l) => l.lotNo).filter(Boolean);
  if (ids.length === 0 && nos.length === 0) return new Map();

  const objectIds = ids.filter((i) => mongoose.Types.ObjectId.isValid(i));

  const planOr = [];
  const batchOr = [];
  if (objectIds.length) {
    planOr.push({ 'beams.sections.yarnLot': { $in: objectIds } });
    batchOr.push({ 'allocations.yarnLot': { $in: objectIds } });
  }
  if (nos.length) {
    planOr.push({ 'beams.sections.lotNo': { $in: nos } });
    batchOr.push({ 'allocations.lotNo': { $in: nos } });
  }

  const [plans, batches] = await Promise.all([
    WarpingPlan.find({ $or: planOr }).select('job beams.sections.yarnLot beams.sections.lotNo').lean(),
    WarpingBatch.find({ $or: batchOr }).select('job batchNo allocations.yarnLot allocations.lotNo').lean(),
  ]);

  const wantedIds = new Set(ids);
  const wantedNos = new Set(nos);
  const hit = (lotId, lotNo) =>
    (lotId && wantedIds.has(String(lotId))) || (lotNo && wantedNos.has(lotNo));

  const out = new Map();
  const note = (jobId, source, lotKey) => {
    if (!jobId) return;
    const id = String(jobId);
    if (excludeJobId && id === String(excludeJobId)) return;
    if (!out.has(id)) out.set(id, { jobId: id, sources: new Set(), lotKeys: new Set() });
    out.get(id).sources.add(source);
    if (lotKey) out.get(id).lotKeys.add(lotKey);
  };

  for (const p of plans) {
    for (const beam of p.beams || []) {
      for (const s of beam.sections || []) {
        // A plan matches the $or if ANY section holds a wanted lot; the
        // other sections are unrelated and must not be recorded as hits.
        if (hit(s.yarnLot, s.lotNo)) note(p.job, 'planned', idOf(s.yarnLot) || s.lotNo);
      }
    }
  }
  for (const b of batches) {
    for (const a of b.allocations || []) {
      if (hit(a.yarnLot, a.lotNo)) note(b.job, 'issued', idOf(a.yarnLot) || a.lotNo);
    }
  }

  return out;
}

// ── Step three: how exposed each of those jobs is ────────────────

/**
 * Classify each other job by whether its goods have reached the customer.
 *
 * Three buckets, and the split is the point of the whole report:
 *
 *   delivered  — a challan covering this product reached this customer.
 *                Too late to contain; these are the calls to make.
 *   inTransit  — dispatched, not yet marked delivered. Sometimes stoppable.
 *   inHouse    — nothing has gone out. This is the containable set, and
 *                it is the reason to run this before the phone rings.
 *
 * `certain` is false where a challan matched the order and product but
 * the order carries more than one job for that product — see the header.
 */
async function classifyExposure(jobIds) {
  if (jobIds.length === 0) return [];

  const jobs = await JobOrder.find({ _id: { $in: jobIds } })
    // jobOrderNo, not jobNo — the field is auto-incremented under that
    // name and selecting the wrong one returns undefined silently.
    .select('jobOrderNo order customer status elastics.elastic date')
    .populate('customer', 'name')
    .populate('order', 'orderNo')
    .populate('elastics.elastic', 'name')
    .lean();

  const orderIds = [...new Set(jobs.map((j) => idOf(j.order)).filter(Boolean))];

  const [challans, siblings] = await Promise.all([
    orderIds.length
      ? DeliveryChallan.find({
          order: { $in: orderIds },
          status: { $in: GONE },
        }).select('dcNumber order status date createdAt items.elastic items.elasticName').lean()
      : [],
    // Every job on those orders, to find out whether a challan can be
    // pinned to one job or is shared between several.
    orderIds.length
      ? JobOrder.find({ order: { $in: orderIds } }).select('order elastics.elastic').lean()
      : [],
  ]);

  // order id → elastic id → how many jobs on that order carry it
  const jobsPerOrderElastic = new Map();
  for (const j of siblings) {
    const oId = idOf(j.order);
    if (!oId) continue;
    if (!jobsPerOrderElastic.has(oId)) jobsPerOrderElastic.set(oId, new Map());
    const m = jobsPerOrderElastic.get(oId);
    for (const e of j.elastics || []) {
      const eId = idOf(e.elastic);
      if (eId) m.set(eId, (m.get(eId) || 0) + 1);
    }
  }

  const challansByOrder = new Map();
  for (const dc of challans) {
    const oId = idOf(dc.order);
    if (!oId) continue;
    if (!challansByOrder.has(oId)) challansByOrder.set(oId, []);
    challansByOrder.get(oId).push(dc);
  }

  return jobs.map((job) => {
    const oId = idOf(job.order);
    const jobElastics = new Set((job.elastics || []).map((e) => idOf(e.elastic)).filter(Boolean));
    const dcs = challansByOrder.get(oId) || [];

    // A challan counts against this job only if it carries one of the
    // job's elastics. An order's challan for a different product says
    // nothing about whether this job shipped.
    const matching = dcs.filter((dc) =>
      (dc.items || []).some((it) => {
        const eId = idOf(it.elastic);
        return eId && jobElastics.has(eId);
      })
    );

    // Ambiguous only where a product THE CHALLAN ACTUALLY COVERS appears
    // on more than one job of the same order — then the challan belongs
    // to one of them, unknowably.
    //
    // Narrowed to the covered products deliberately. Asking whether ANY
    // of the job's products is shared marks a row uncertain when the
    // challan names a product unique to this job and the job merely also
    // carries a shared one — which is a hedge on a fact the data does
    // settle. A flag that fires when it need not is a flag people learn
    // to read past, and this one has to still mean something on the day
    // it is right.
    const perElastic = jobsPerOrderElastic.get(oId) || new Map();
    const covered = new Set();
    for (const dc of matching) {
      for (const it of dc.items || []) {
        const eId = idOf(it.elastic);
        if (eId && jobElastics.has(eId)) covered.add(eId);
      }
    }
    const shared = [...covered].some((eId) => (perElastic.get(eId) || 0) > 1);

    const delivered = matching.some((dc) => dc.status === 'delivered');
    const dispatched = matching.some((dc) => dc.status === 'dispatched');

    let exposure = 'inHouse';
    if (delivered) exposure = 'delivered';
    else if (dispatched) exposure = 'inTransit';

    return {
      jobId: String(job._id),
      jobNo: job.jobOrderNo ?? null,
      jobStatus: job.status,
      // Production is finished but nothing has gone out: the goods are
      // on the floor and can still be pulled. Worth saying separately
      // from a job still being woven, which nobody has to chase.
      finishedNotShipped: exposure === 'inHouse' && FINISHED.includes(job.status),
      orderId: oId,
      orderNo: job.order?.orderNo ?? null,
      customerId: idOf(job.customer),
      customerName: job.customer?.name || '',
      elastics: (job.elastics || [])
        .map((e) => ({ id: idOf(e.elastic), name: e.elastic?.name || '' }))
        .filter((e) => e.id),
      exposure,
      certain: exposure === 'inHouse' ? true : !shared,
      challans: matching.map((dc) => ({
        dcNumber: dc.dcNumber,
        status: dc.status,
        date: dc.date || dc.createdAt || null,
      })),
    };
  });
}

// ── The report ───────────────────────────────────────────────────

/**
 * The blast radius behind one complaint.
 *
 * Returns `{ ok: false, reason }` rather than throwing when there is
 * nothing to trace, because "this job has no warping programme yet" is
 * an ordinary answer and not an error.
 */
async function trace(complaintId) {
  const complaint = await Complaint.findById(complaintId)
    .populate('customer', 'name')
    .populate('elastic', 'name')
    .populate({ path: 'job', select: 'jobOrderNo order status', populate: { path: 'order', select: 'orderNo' } })
    .lean();

  if (!complaint) return { ok: false, reason: 'not-found' };
  if (!complaint.job) {
    return { ok: false, reason: 'no-job', message: 'This complaint is not linked to a job, so there is no trail to follow.' };
  }

  const jobId = idOf(complaint.job);
  const elasticId = idOf(complaint.elastic);

  const lots = await lotsForJob(jobId, { elasticId });

  const head = {
    complaintId: String(complaint._id),
    date: complaint.date,
    category: complaint.category,
    status: complaint.status,
    reason: complaint.reason,
    customerId: idOf(complaint.customer),
    customerName: complaint.customer?.name || '',
    jobId,
    jobNo: complaint.job?.jobOrderNo ?? null,
    orderNo: complaint.job?.order?.orderNo ?? null,
    elasticId,
    elasticName: complaint.elastic?.name || null,
  };

  if (lots.length === 0) {
    return {
      ok: true,
      complaint: head,
      lots: [],
      exposure: { delivered: [], inTransit: [], inHouse: [] },
      summary: { lots: 0, otherJobs: 0, otherCustomers: 0, delivered: 0, inTransit: 0, inHouse: 0, uncertain: 0 },
      caveats: [
        'No yarn lot is recorded against this job — neither in its warping programme nor in an issued batch. ' +
        'Without a lot there is nothing to trace, and this is not evidence that no other order is affected.',
      ],
    };
  }

  const carrying = await jobsCarryingLots(lots, { excludeJobId: jobId });
  const rows = await classifyExposure([...carrying.keys()]);

  for (const r of rows) {
    const c = carrying.get(r.jobId);
    r.via = c ? [...c.sources] : [];
  }

  const bucket = (name) => rows.filter((r) => r.exposure === name)
    .sort((a, b) => (a.customerName || '').localeCompare(b.customerName || ''));

  const exposure = {
    delivered: bucket('delivered'),
    inTransit: bucket('inTransit'),
    inHouse: bucket('inHouse'),
  };

  const caveats = [];
  const uncertain = rows.filter((r) => !r.certain).length;
  if (uncertain > 0) {
    caveats.push(
      `${uncertain} job(s) share an order and a product with another job, and a delivery challan names ` +
      'the order and the product but not the job. Those are marked uncertain: the goods that shipped may ' +
      'have come from the sibling job instead.'
    );
  }
  const jobWide = lots.filter((l) => l.attribution === 'job-wide').length;
  if (elasticId && jobWide > 0) {
    caveats.push(
      `${jobWide} lot(s) are recorded against the job without naming an elastic, so they are included even ` +
      `though the complaint names ${head.elasticName || 'one product'}. They may have warped something else.`
    );
  }
  const plannedOnly = lots.filter((l) => l.source === 'planned').length;
  if (plannedOnly > 0) {
    caveats.push(
      `${plannedOnly} lot(s) are programmed but not yet issued. A programme can still be changed — those ` +
      'are the ones you can act on before the yarn comes off the rack.'
    );
  }

  return {
    ok: true,
    complaint: head,
    lots,
    exposure,
    summary: {
      lots: lots.length,
      otherJobs: rows.length,
      otherCustomers: new Set(rows.map((r) => r.customerId).filter(Boolean)).size,
      delivered: exposure.delivered.length,
      inTransit: exposure.inTransit.length,
      inHouse: exposure.inHouse.length,
      uncertain,
    },
    caveats,
  };
}

module.exports = { trace, lotsForJob, jobsCarryingLots, classifyExposure, GONE };
