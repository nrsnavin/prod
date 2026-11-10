'use strict';
// ══════════════════════════════════════════════════════════════════
//  JOB ORDERS — OUTSOURCING, PRODUCTION MODE, LOTS, MRP AND POS  (part of /api/v2/job)
//
//    PUT    /:jobId/outsourcing
//    PATCH  /:jobId/production-mode
//    GET    /:jobId/yarn-lots
//    GET    /:jobId/mrp
//    POST   /:jobId/raise-po
//    GET    /:jobId/purchase-orders
//    GET    /:jobId/mrp.pdf
//
//  api/job.js mounts this file; see there for why the order matters.
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const { renderPdf } = require('../utils/renderPdf');
const { onceAtATime }  = require('../utils/onceAtATime');
const { sendError } = require('../utils/routeError');
const { isAdmin } = require('../middleware/auth');
const JobOrder    = require('../models/JobOrder');
const WarpingBatch = require('../models/WarpingBatch');
const PurchaseOrder = require('../models/PurchaseOrder');
const { buildFingerprint, stampFingerprint, ACTION_CODES, actorFromRequest } = require('../utils/fingerprint');
const { computeMaterialRequirement } = require('../utils/materialRequirement');
const { triageShortfall, createShortfallPos, skipReasons } = require('../services/shortfallPo');
const { issuedForOrder, shareForJob } = require('../services/orderIssuance');
const { plannedLotsForJob, distinctLots } = require('../services/yarnLotTrail');
const { earmarksForJob } = require('../services/lotAllocation');
const { getPdfBranding } = require('../services/documentSettings.js');
const { isProductionLocked } = require('../utils/productionLock');
const { outsourcingBlockers, outsourcingDerived } = require('../utils/outsourcingRecord');
const router = express.Router();

// ════════════════════════════════════════════════════════════════
//  MATERIAL REQUIREMENT PROGRAM (MRP)
//
//  PATCH /:jobId/production-mode  — set in_house / outsource (+vendor)
//  GET   /:jobId/mrp              — computed MRP data as JSON
//  GET   /:jobId/mrp.pdf          — the MRP sheet as a PDF download
// ════════════════════════════════════════════════════════════════

/**
 * This job's material requirement, net of what its order already drew.
 *
 * A job only exists under an approved order, and approving that order
 * took its material out of stock. Comparing the job's full requirement
 * against the balance left behind reported every job as short of the
 * yarn standing on the floor for it, and the shortfall panel then
 * offered to buy it a second time.
 *
 * @param job  lean job with `order` populated (orderNo + rawMaterialRequired)
 */
async function jobRequirement(job) {
  // Which lots this job's warping programme has already committed to,
  // keyed by material so an MRP row can pick up its own. A programme
  // that names its lots is a stronger answer than any inference, and
  // it is already recorded — it was simply never carried onto the
  // sheet the floor prints. See services/yarnLotTrail.js.
  const committedLots = await committedLotsByMaterial(job._id, job);

  const materials = await computeMaterialRequirement(job.elastics || [], { committedLots });
  const orderId = job.order?._id || job.order;
  if (!orderId) return materials;

  const drawn = await issuedForOrder(orderId);
  if (drawn.size === 0) return materials;

  return computeMaterialRequirement(job.elastics || [], {
    allocated: shareForJob(drawn, job.order?.rawMaterialRequired || [], materials),
    committedLots,
  });
}

/**
 * The job's programmed lots, grouped by the material they belong to.
 *
 * The trail reports one entry per (elastic, lot), because a programme
 * commonly runs one lot across six sections of a beam and listing it
 * six times says nothing. The MRP is per MATERIAL, so those are folded
 * again here — the same lot named for two elastics of the same yarn is
 * one commitment on the sheet, not two.
 *
 * Entries with no material cannot be placed on a row and are dropped:
 * they come from programmes written before the section carried a
 * warpYarn reference, and putting them under a guessed material would
 * be worse than leaving the row's lots to the available list.
 */
async function committedLotsByMaterial(jobId, job) {
  const out = new Map();

  // ── The order's earmarks come FIRST ─────────────────────────────
  // They are the older and broader claim: approving the order set
  // these bags aside for it before any beam existed. The programme's
  // choices are then layered on top, and where the two name the same
  // lot the programme's entry is skipped as a duplicate — so the
  // sheet shows one row per lot with the order's claim on it.
  //
  // Read through a separate try: a job whose order has been deleted
  // must not lose its programmed lots as well.
  try {
    const earmarks = await earmarksForJob(job || { order: null });
    for (const [materialId, rows] of earmarks) {
      const list = [];
      for (const r of rows) {
        if (!r.yarnLot && !r.lotNo) continue;
        list.push({
          yarnLot: r.yarnLot ? String(r.yarnLot) : null,
          lotNo: r.lotNo || "",
          shade: r.shade || "",
          quantity: Number(r.quantity) || 0,
          source: "order",
        });
      }
      if (list.length) out.set(String(materialId), list);
    }
  } catch (err) {
    console.warn(`MRP: could not read the order's earmarked lots for job ${jobId}:`, err.message);
  }

  try {
    const trail = await plannedLotsForJob(jobId);
    for (const e of trail.entries || []) {
      if (!e.materialId) continue;
      if (!out.has(e.materialId)) out.set(e.materialId, []);
      const list = out.get(e.materialId);
      const key = String(e.yarnLot || e.lotNo || "");
      if (!key || list.some((l) => String(l.yarnLot || l.lotNo) === key)) continue;
      list.push({ yarnLot: e.yarnLot, lotNo: e.lotNo, shade: e.shade, source: "programme" });
    }
  } catch (err) {
    // The requirement itself does not depend on this, and a sheet with
    // available lots instead of committed ones is still a usable sheet.
    // Said out loud rather than swallowed, because a programme that
    // silently stops reaching the MRP is exactly the kind of quiet
    // regression nobody reports.
    console.warn(`MRP: could not read programmed lots for job ${jobId}:`, err.message);
  }
  return out;
}

// Assemble the plain MRP data object the JSON route and the PDF
// renderer both consume. Returns null if the job doesn't exist.
async function _buildMrpData(jobId) {
  const job = await JobOrder.findById(jobId)
    .populate("customer", "name")
    // po + supplyDate come along so the sheet can say which customer
    // order it serves and when that order is due — the two questions
    // asked of an MRP sheet that it could not previously answer.
    // rawMaterialRequired divides the order's draw across its jobs.
    .populate("order",    "orderNo po supplyDate rawMaterialRequired")
    .populate("elastics.elastic", "name")
    .lean();
  if (!job) return null;

  const materials = await jobRequirement(job);

  return {
    jobId:           String(job._id),
    jobOrderNo:      job.jobOrderNo,
    orderNo:         job.order?.orderNo ?? null,
    customerPo:      job.order?.po || "",
    supplyDateLabel: job.order?.supplyDate
      ? new Date(job.order.supplyDate).toLocaleDateString("en-IN",
          { day: "2-digit", month: "short", year: "numeric" })
      : "",
    customerName:    job.customer?.name || "",
    dateLabel:       job.date
      ? new Date(job.date).toLocaleDateString("en-IN",
          { day: "2-digit", month: "short", year: "numeric" })
      : "",
    status:          job.status,
    productionMode:  job.productionMode || "in_house",
    outsourceVendor: job.outsourceVendor || "",
    elastics: (job.elastics || []).map((e) => ({
      // So the sheet can open the elastic to correct its recipe.
      id:       e.elastic?._id ? String(e.elastic._id) : null,
      name:     e.elastic?.name || "Unknown",
      quantity: Number(e.quantity) || 0,
    })),
    materials,
    // When this was worked out: the requirement is read from each
    // elastic's recipe as it stands at this moment.
    computedAt: new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════
//  PUT /:jobId/outsourcing — save the vendor job-work record.
//
//  Saved progressively: the consignment goes out, then comes back, and
//  the planner fills what they know as they know it. Completeness is not
//  required here — it is enforced at the finishing gate, so a half-filled
//  record can still be parked. Editing stays open after `finishing` on
//  purpose: spotting a typo in the efficiency you just entered should not
//  need a status rollback, and every write is fingerprinted.
// ════════════════════════════════════════════════════════════════
router.put('/:jobId/outsourcing', isAdmin('admin', 'production', 'accounts'), async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const job = await JobOrder.findById(jobId);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });
    if (job.productionMode !== 'outsource') {
      return res.status(409).json({
        success: false,
        message: 'This job is produced in-house — set it to outsourced before recording vendor work.',
      });
    }

    const b = req.body || {};
    const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
    const date = (v) => (v ? new Date(v) : null);

    const next = {
      qtySentMeters:      num(b.qtySentMeters),
      qtyReceivedMeters:  num(b.qtyReceivedMeters),
      efficiencyPct:      num(b.efficiencyPct),
      actualReturnDate:   date(b.actualReturnDate),
      notes:              typeof b.notes === 'string' ? b.notes.trim() : '',
      dispatchDate:       date(b.dispatchDate),
      expectedReturnDate: date(b.expectedReturnDate),
      rejectedMeters:     num(b.rejectedMeters),
      ratePerMeter:       num(b.ratePerMeter),
      outwardChallanNo:   typeof b.outwardChallanNo === 'string' ? b.outwardChallanNo.trim() : '',
      inwardChallanNo:    typeof b.inwardChallanNo === 'string' ? b.inwardChallanNo.trim() : '',
      recordedBy:         req.user?._id || null,
      recordedAt:         new Date(),
    };
    for (const [k, v] of Object.entries(next)) {
      if (Number.isNaN(v)) {
        return res.status(400).json({ success: false, message: `${k} must be a number.` });
      }
    }

    job.outsourcing = { ...(job.outsourcing?.toObject?.() ?? job.outsourcing ?? {}), ...next };
    job.fingerprints.push(buildFingerprint(ACTION_CODES.JOB_STAGE_UPDATED, {
      entityId: job._id,
      actor: actorFromRequest(req),
      meta: {
        vendorRecordSaved: true,
        vendor:            job.outsourceVendor || '',
        efficiencyPct:     next.efficiencyPct,
        qtySentMeters:     next.qtySentMeters,
        qtyReceivedMeters: next.qtyReceivedMeters,
      },
    }));
    await job.save();

    const rec = job.outsourcing?.toObject?.() ?? job.outsourcing;
    return res.json({ success: true, data: {
      ...rec,
      derived:  outsourcingDerived(rec),
      blockers: outsourcingBlockers(rec),
    }});
  } catch (err) {
    return sendError(req, res, err);
  }
});

router.patch('/:jobId/production-mode', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const mode = req.body?.productionMode;
    if (!['in_house', 'outsource'].includes(mode))
      return res.status(400).json({ success: false, message: "productionMode must be 'in_house' or 'outsource'." });

    const update = { productionMode: mode };
    // Vendor only applies to outsource; clear it when switching back.
    if (mode === 'outsource') {
      update.outsourceVendor = typeof req.body?.outsourceVendor === 'string'
        ? req.body.outsourceVendor.trim() : '';
    } else {
      update.outsourceVendor = '';
    }

    // Once the job leaves the loom (finishing onward) how it was made is
    // history — flipping it to outsourced would rewrite the record of work
    // that is already done. Read the status BEFORE writing, so a locked
    // job is refused rather than updated and then complained about.
    const existing = await JobOrder.findById(jobId).select('jobOrderNo status');
    if (!existing) return res.status(404).json({ success: false, message: 'Job not found.' });
    if (isProductionLocked(existing.status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot change production mode — J-${existing.jobOrderNo} has moved to ${existing.status}. ` +
                 `Production closes once a job leaves the loom.`,
      });
    }

    const job = await JobOrder.findByIdAndUpdate(jobId, update, { new: true })
      .select('jobOrderNo productionMode outsourceVendor');
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    return res.json({ success: true, data: {
      jobOrderNo:      job.jobOrderNo,
      productionMode:  job.productionMode,
      outsourceVendor: job.outsourceVendor,
    }});
  } catch (err) {
    return sendError(req, res, err, 'Failed to update production mode');
  }
});

// ════════════════════════════════════════════════════════════════
//  GET /:jobId/yarn-lots
//
//  Which dye lots went into this job, grouped by the elastic they were
//  warped for. This is the backward half of lot traceability: the
//  forward half (/yarn-lots/:id/trace) answers "where did this lot go",
//  and this one answers "what is in this roll" — the question that
//  actually gets asked, months later, when a customer reports a shade
//  band and quotes a job number off the packing list.
//
//  Batches that were never attributed to an elastic come back under a
//  separate `unattributed` group rather than being spread across every
//  elastic on the job. Attributing them everywhere would be a guess
//  wearing the costume of a fact.
// ════════════════════════════════════════════════════════════════
router.get('/:jobId/yarn-lots', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const job = await JobOrder.findById(jobId)
      .select('jobOrderNo elastics')
      .populate('elastics.elastic', 'name')
      .lean();
    if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

    const batches = await WarpingBatch.find({ job: jobId })
      .populate('elastics', 'name')
      .sort({ createdAt: 1 })
      .lean();

    // Cancelled batches drew nothing in the end — their yarn went back on
    // the rack — so they are not part of what is in the goods.
    const live = batches.filter((b) => b.status !== 'cancelled');

    const groups = new Map();
    const groupFor = (key, name) => {
      if (!groups.has(key)) groups.set(key, { elasticId: key === 'unattributed' ? null : key, elasticName: name, lots: [] });
      return groups.get(key);
    };
    // Seed a group per planned elastic, so an elastic with no lots
    // recorded shows as "nothing recorded" rather than vanishing.
    for (const e of job.elastics || []) {
      if (e.elastic?._id) groupFor(String(e.elastic._id), e.elastic.name || 'Unknown');
    }

    // ── What the warping programme committed to ──────────────────────
    // A lot is chosen when the programme is written, which is days
    // before any batch is issued. Reading only the batches meant that
    // decision — already made, already printed on the sheet at the
    // machine — showed up nowhere at all until the yarn moved.
    const planned = await plannedLotsForJob(jobId);
    for (const p of planned.entries) {
      const g = groupFor(
        p.elasticId || 'unattributed',
        p.elasticName || 'Not attributed to an elastic'
      );
      g.lots.push({
        source: 'planned',
        planId: p.planId,
        batchId: null,
        batchNo: null,
        batchStatus: null,
        beamNos: p.beamNos,
        yarnLot: p.yarnLot,
        lotNo: p.lotNo,
        shade: p.shade,
        lotStatus: p.lotStatus,
        materialName: p.materialName,
        // Programming names the lot, it does not weigh it. A quantity
        // here would be invented; the section count is what was decided.
        quantity: null,
        sections: p.sections,
        sharedAcross: 1,
        issuedDate: null,
      });
    }

    for (const b of live) {
      const targets = (b.elastics || []).length
        ? b.elastics.map((e) => ({ key: String(e._id), name: e.name || 'Unknown' }))
        : [{ key: 'unattributed', name: 'Not attributed to an elastic' }];

      for (const t of targets) {
        const g = groupFor(t.key, t.name);
        for (const a of b.allocations || []) {
          g.lots.push({
            // Issued: the cones are off the rack. Never merged with the
            // planned row above — one can still change, the other cannot.
            source: 'issued',
            batchId: b._id,
            batchNo: b.batchNo,
            batchStatus: b.status,
            beamNos: b.beamNos || [],
            yarnLot: a.yarnLot,
            lotNo: a.lotNo || '',
            shade: a.shade || '',
            materialName: a.materialName || '',
            // A batch covering two elastics drew its yarn once, not twice.
            // The quantity is left whole and `sharedAcross` says how many
            // elastics it is answering for, rather than silently dividing
            // a number nobody measured that way.
            quantity: a.quantity,
            sharedAcross: targets.length,
            issuedDate: b.issuedDate || null,
          });
        }
      }
    }

    const byElastic = Array.from(groups.values()).filter(
      (g) => g.elasticId !== null || g.lots.length > 0
    );

    // The flat list of distinct lots in this job — what someone chasing a
    // complaint wants first, before drilling into which beam.
    const lots = distinctLots(byElastic.flatMap((g) => g.lots));

    return res.json({
      success: true,
      data: {
        jobId: job._id,
        jobOrderNo: job.jobOrderNo,
        byElastic,
        lots,
        // Sections the programme has left open. Not a fault — an undyed
        // yarn has no lot, and a plan can be written before the lot is
        // decided — but it is the difference between "no lot chosen" and
        // "no programme", which a blank list cannot express.
        sections: planned.sections,
        openBeamNos: planned.openBeamNos,
        // Batches exist but none say which elastic they were for — the
        // UI uses this to explain why the trail is job-wide.
        hasUnattributed: byElastic.some((g) => g.elasticId === null),
      },
    });
  } catch (err) {
    console.error('[GET /jobs/:jobId/yarn-lots]', err);
    return sendError(req, res, err, 'Failed to load yarn lots');
  }
});

router.get('/:jobId/mrp', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });
    const data = await _buildMrpData(jobId);
    if (!data) return res.status(404).json({ success: false, message: 'Job not found.' });
    return res.json({ success: true, data });
  } catch (err) {
    return sendError(req, res, err, 'Failed to build MRP');
  }
});

// ════════════════════════════════════════════════════════════════
//  POST /:jobId/raise-po
//
//  Turn this job's material shortfalls into purchase orders.
//
//  The shortfall is already on the MRP; what was missing was any way to
//  act on it without re-keying the same numbers into the PO screen and
//  losing the connection to the job that needed them. The POs raised
//  here carry that link, so the purchase stays answerable.
//
//  One PO per supplier, because a purchase order is a document sent to
//  one supplier — splitting is not a design choice, it is what the
//  document is. Materials with no supplier set cannot be ordered and
//  are reported back rather than silently dropped.
//
//  Body: { materials?: [id], expectedDate?, notes? }
//    materials — restrict to these material ids; omitted means every
//                material currently short.
// ════════════════════════════════════════════════════════════════
router.post('/:jobId/raise-po', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    // One at a time for a job: two taps together each found nothing on
    // order yet and each raised the purchase orders (utils/onceAtATime.js).
    return await onceAtATime(`raise-po:job:${jobId}`, async () => {
      const job = await JobOrder.findById(jobId)
        .select('jobOrderNo order elastics')
        .populate('order', 'rawMaterialRequired')
        .lean();
      if (!job) return res.status(404).json({ success: false, message: 'Job not found.' });

      const requirement = await jobRequirement(job);
      const { orderable, noSupplier, unresolved, anyShort, awaitingDelivery } =
        triageShortfall(requirement, req.body?.materials);

      if (!anyShort) {
        return res.status(400).json({
          success: false,
          message: awaitingDelivery.length
            ? `Already on order — ${awaitingDelivery
                .map((m) => m.name)
                .join(', ')} ${awaitingDelivery.length === 1 ? 'is' : 'are'} short but bought and awaiting delivery.`
            : 'Nothing is short on this job — no purchase order to raise.',
        });
      }
      if (orderable.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'None of the short materials has a supplier set — set one before raising a PO.',
          skipped: skipReasons(unresolved, noSupplier),
        });
      }

      const created = await createShortfallPos(
        orderable,
        // `order` is populated for the requirement split above, so take the
        // id off it — the PO's ref is an id, not the document.
        { forJob: job._id, forOrder: job.order?._id || job.order || undefined },
        {
          expectedDate: req.body?.expectedDate,
          notes: req.body?.notes,
          defaultNote: `Raised for job J-${job.jobOrderNo} material shortfall`,
        }
      );

      // Audit on the job: raising a PO commits money from this screen, and
      // the job is where someone looks for why.
      try {
        const jobDoc = await JobOrder.findById(jobId);
        if (jobDoc) {
          stampFingerprint(jobDoc, ACTION_CODES.PO_RAISED, {
            req,
            meta: {
              source: 'mrp-shortfall',
              purchaseOrders: created.map((c) => ({ poNo: c.poNo, supplier: c.supplierName })),
            },
          });
          await jobDoc.save();
        }
      } catch (fpErr) {
        // The POs exist either way; losing the audit line is not worth
        // failing the request and leaving the caller unsure what was made.
        console.warn('[raise-po] fingerprint failed:', fpErr.message);
      }

      return res.status(201).json({
        success: true,
        purchaseOrders: created,
        skipped: skipReasons(unresolved, noSupplier),
      });
    }, { what: 'Purchase orders for this job' });
  } catch (err) {
    console.error('[POST /jobs/:jobId/raise-po]', err);
    return sendError(req, res, err, 'Failed to raise purchase orders');
  }
});

// ════════════════════════════════════════════════════════════════
//  GET /:jobId/purchase-orders — what has been ordered for this job
// ════════════════════════════════════════════════════════════════
router.get('/:jobId/purchase-orders', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });

    const pos = await PurchaseOrder.find({ forJob: jobId })
      .populate('supplier', 'name')
      .populate('items.rawMaterial', 'name')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, purchaseOrders: pos });
  } catch (err) {
    console.error('[GET /jobs/:jobId/purchase-orders]', err);
    return sendError(req, res, err, 'Failed to load purchase orders');
  }
});

router.get('/:jobId/mrp.pdf', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(jobId))
      return res.status(400).json({ success: false, message: 'Invalid job ID.' });
    const data = await _buildMrpData(jobId);
    if (!data) return res.status(404).json({ success: false, message: 'Job not found.' });

    data.branding = await getPdfBranding();
    const pdf = await renderPdf('mrp', data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="MRP-job-${data.jobOrderNo ?? jobId}.pdf"`
    );
    return res.send(pdf);
  } catch (err) {
    return sendError(req, res, err, 'Failed to render MRP PDF');
  }
});

module.exports = router;
