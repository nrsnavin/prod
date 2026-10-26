"use strict";

const express           = require("express");
const router            = express.Router();
const mongoose          = require("mongoose");
const Covering          = require("../models/Covering");
const JobOrder          = require("../models/JobOrder");
const Order             = require("../models/Order");
const Elastic           = require("../models/Elastic");
const ErrorHandler      = require("../utils/ErrorHandler");
const catchAsyncErrors  = require("../middleware/catchAsyncErrors");
const { checkAndAdvanceToWeaving } = require("../utils/jobStatusHelper");
const { buildFingerprint, ACTION_CODES, actorFromRequest } = require("../utils/fingerprint");
const { isAuthenticated, isAdmin, requireFeature, requireFeatureRead } = require("../middleware/auth");

// All covering routes require login. Workers in the `covering` (and
// `warping`) departments need to read /list and /detail to monitor
// their jobs; covering operators also POST /beam-entry to record their
// own work. Mutations stay admin-only.
router.use(isAuthenticated);
// Per-user feature gate: the Covering data backs both the Warping and
// Covering screens, so either feature grants access — reads included.
router.use(requireFeature('/warping', '/covering'));
router.use(requireFeatureRead('/warping', '/covering'));

/**
 * The heaviest a single warp beam can plausibly be, in kg.
 *
 * Beam weights are keyed by hand off a floor scale, and producedWeight
 * is a running sum, so a slipped decimal is invisible the moment it
 * lands — there is no second figure anywhere to disagree with it.
 */
const BEAM_WEIGHT_MAX_KG = 2000;

router.get(
  "/list",
  catchAsyncErrors(async (req, res, next) => {
    const { status = "open", search = "" } = req.query;

    // Clamped. `page=0` produced a negative skip, which Mongo rejects
    // outright — the listing 500'd on a query string a paginator can
    // easily send while the user is still on the first page.
    const page  = Math.max(Number(req.query.page)  || 1,  1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    const skip  = (page - 1) * limit;

    // "all" (the default tab in the web UI) means no status filter; any
    // other value must be a real status. Mirrors api/warping.js so the two
    // sibling list endpoints behave the same.
    const validStatuses = ["open", "in_progress", "completed", "cancelled"];
    const filter = {};
    if (status && status !== "all") {
      if (!validStatuses.includes(status)) {
        return next(new ErrorHandler(`Invalid status: ${status}`, 400));
      }
      filter.status = status;
    }

    if (search && search.trim()) {
      const jobNo = parseInt(search.trim(), 10);
      if (!isNaN(jobNo)) {
        const matchedJobs = await JobOrder.find({ jobOrderNo: jobNo }).select("_id");
        filter.job = { $in: matchedJobs.map((j) => j._id) };
      }
    }

    const [data, total] = await Promise.all([
      Covering.find(filter)
        .populate({
          path:   "job",
          select: "jobOrderNo status customer",
          populate: { path: "customer", select: "name" },
        })
        .populate({ path: "elasticPlanned.elastic", select: "name" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Covering.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: { total, page, limit, hasMore: skip + data.length < total },
    });
  })
);

// ─────────────────────────────────────────────────────────────
//  GET /covering/:id/programme.pdf — the covering programme, printable
//
//  Drawn on the server (utils/programmePdf.js), like the warping one.
// ─────────────────────────────────────────────────────────────
const { renderPdf } = require("../utils/renderPdf");
const { getPdfBranding } = require("../services/documentSettings.js");
const { sheetRefOf } = require("../utils/coveringBeamOcr");

router.get(
  "/:id/programme.pdf",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Invalid covering id", 400));
    const covering = await Covering.findById(req.params.id)
      .populate({
        path: "job", select: "jobOrderNo date customer order",
        populate: [{ path: "customer", select: "name" }, { path: "order", select: "orderNo" }],
      })
      .populate({
        path: "elasticPlanned.elastic",
        select: "name spandexEnds warpSpandex spandexCovering",
        populate: [
          { path: "warpSpandex.id", model: "RawMaterial", select: "name" },
          { path: "spandexCovering.id", model: "RawMaterial", select: "name" },
        ],
      })
      .lean();
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    const d = covering.date || covering.createdAt;
    const data = {
      jobOrderNo: covering.job?.jobOrderNo ?? null,
      customerName: covering.job?.customer?.name || "",
      orderNo: covering.job?.order?.orderNo ?? null,
      dateLabel: d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "",
      status: String(covering.status || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
      sheetRef: sheetRefOf(covering._id),
      remarks: covering.remarks || "",
      // Total weight a metre = warp spandex + spandex covering, as the
      // covering page works it out.
      lines: (covering.elasticPlanned || []).map((l) => {
        const el = l.elastic || {};
        return {
          name: el.name || "Unknown",
          quantity: Number(l.quantity) || 0,
          warpSpandex: el.warpSpandex?.id?.name || "",
          spandexCovering: el.spandexCovering?.id?.name || "",
          spandexEnds: el.spandexEnds ?? null,
          totalWeight: (Number(el.warpSpandex?.weight) || 0) + (Number(el.spandexCovering?.weight) || 0),
        };
      }),
      beamEntries: (covering.beamEntries || []).map((b) => ({ beamNo: b.beamNo, weight: b.weight, note: b.note || "" })),
      producedWeight: covering.producedWeight ?? null,
      branding: await getPdfBranding(),
    };
    const pdf = await renderPdf("coveringProgramme", data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="covering-programme-J-${data.jobOrderNo ?? covering._id}.pdf"`);
    res.send(pdf);
  })
);

router.get(
  "/detail",
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.query;
    if (!id) return next(new ErrorHandler("Covering ID is required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid covering id", 400));
    }

    const covering = await Covering.findById(id)
      .populate({
        path: "job",
        populate: [
          { path: "customer", select: "name" },
          { path: "order",    select: "orderNo po status" },
        ],
      })
      .populate({
        path: "elasticPlanned.elastic",
        populate: [
          { path: "warpSpandex.id",    model: "RawMaterial", select: "name category" },
          { path: "spandexCovering.id", model: "RawMaterial", select: "name category" },
        ],
      })
      .populate({
        path:   "beamEntries.enteredBy",
        select: "name role",
      })
      .lean();

    if (!covering) {
      return next(new ErrorHandler("Covering not found", 404));
    }

    res.status(200).json({ success: true, covering });
  })
);

router.post(
  "/start",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status !== "open") {
          throw new ErrorHandler(
            `Only OPEN covering can be started (current: ${covering.status})`, 400
          );
        }

        covering.status = "in_progress";
        await covering.save({ session });

        const fp = buildFingerprint(ACTION_CODES.COVERING_STARTED, {
          entityId: covering.job,
          actor:    actorFromRequest(req),
          meta:     { coveringId: covering._id.toString() },
        });
        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(fp);
          await job.save({ session });
        }

        resp = { covering, fingerprint: fp };
      });
      res.status(200).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.post(
  "/complete",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status !== "in_progress") {
          throw new ErrorHandler(
            `Only IN-PROGRESS covering can be completed (current: ${covering.status})`, 400
          );
        }

        covering.status        = "completed";
        covering.completedDate = new Date();
        if (remarks?.trim()) covering.remarks = remarks.trim();
        await covering.save({ session });

        // FIX: pass the session so the helper sees the just-written
        // covering.status = "completed". Without this, the helper
        // reads the pre-write snapshot and the job never advances.
        const { advanced, jobStatus } = await checkAndAdvanceToWeaving(
          covering.job,
          session
        );

        const actor = actorFromRequest(req);
        const fp = buildFingerprint(ACTION_CODES.COVERING_COMPLETED, {
          entityId: covering.job,
          actor,
          meta: {
            coveringId:    covering._id.toString(),
            completedDate: covering.completedDate,
            jobAdvanced:   advanced,
            jobStatus,
          },
        });

        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(fp);
          await job.save({ session });

          if (job.order) {
            const order = await Order.findById(job.order).session(session);
            if (order) {
              order.fingerprints.push(buildFingerprint(ACTION_CODES.COVERING_COMPLETED, {
                entityId: order._id,
                actor,
                meta: {
                  jobId:          job._id.toString(),
                  jobOrderNo:     job.jobOrderNo,
                  coveringId:     covering._id.toString(),
                  relatedHash:    fp.hash,
                  relatedShortId: fp.shortId,
                },
              }));
              await order.save({ session });
            }
          }
        }

        resp = {
          covering,
          job: { advanced, status: jobStatus },
          fingerprint: fp,
        };
      });
      res.status(200).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.post(
  "/cancel",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { id, remarks } = req.body;
    if (!id) return next(new ErrorHandler("Covering ID required", 400));
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return next(new ErrorHandler("Invalid covering id", 400));
    }

    const session = await mongoose.startSession();
    try {
      let covering;
      await session.withTransaction(async () => {
        covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status === "completed") {
          throw new ErrorHandler("Completed covering cannot be cancelled", 400);
        }
        // Cancelling an already-cancelled covering used to succeed and
        // stamp nothing, so the trail showed one cancellation for any
        // number of clicks — and said nothing about which one landed.
        if (covering.status === "cancelled") {
          throw new ErrorHandler("Covering is already cancelled", 400);
        }

        const previous = covering.status;
        covering.status = "cancelled";
        if (remarks?.trim()) covering.remarks = remarks.trim();
        await covering.save({ session });

        // Cancelling is the one covering transition that left no mark.
        // Start, complete and every beam entry write to the job's
        // timeline; the transition that stops the job advancing to
        // weaving — the one someone will come asking about — did not.
        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(buildFingerprint(ACTION_CODES.COVERING_CANCELLED, {
            entityId: covering.job,
            actor:    actorFromRequest(req),
            meta: {
              coveringId: covering._id.toString(),
              previousStatus: previous,
              remarks: remarks?.trim() || undefined,
            },
          }));
          await job.save({ session });
        }
      });
      res.status(200).json({ success: true, covering });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

// Operators in the covering department record their own beam weights.
router.post(
  "/beam-entry",
  catchAsyncErrors(async (req, res, next) => {
    const { id, beamNo, weight, note = "" } = req.body;

    if (!id)     return next(new ErrorHandler("Covering ID required", 400));
    if (!beamNo) return next(new ErrorHandler("beamNo is required", 400));
    // Beams are counted, so the number has to be one. Unchecked it went
    // to the model as NaN and came back as a cast error — a 500 for a
    // mistyped field.
    const beam = Number(beamNo);
    if (!Number.isInteger(beam) || beam <= 0) {
      return next(new ErrorHandler("beamNo must be a positive whole number", 400));
    }

    const w = Number(weight);
    if (isNaN(w) || w <= 0) {
      return next(new ErrorHandler("weight must be a positive number (kg)", 400));
    }
    // A warp beam this size does not exist. The cap is the same idea as
    // the metre cap on a packing record: the figure is keyed by hand at
    // a scale, and a slipped decimal otherwise lands in producedWeight
    // with nothing downstream to catch it.
    if (w > BEAM_WEIGHT_MAX_KG) {
      return next(new ErrorHandler(
        `weight ${w} kg exceeds ${BEAM_WEIGHT_MAX_KG} kg for a single beam`, 400));
    }

    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        const covering = await Covering.findById(id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);

        if (covering.status === "completed" || covering.status === "cancelled") {
          throw new ErrorHandler(
            `Cannot add beam entry to a ${covering.status} covering`, 400
          );
        }

        // One beam, one weight. The same beam logged twice doubles
        // producedWeight for yarn that was covered once, and nothing
        // downstream can tell the pair apart from two real beams — the
        // number is a sum, so the duplicate simply disappears into it.
        // Correcting a weight means deleting the entry and re-adding it.
        const already = covering.beamEntries.find((e) => Number(e.beamNo) === beam);
        if (already) {
          throw new ErrorHandler(
            `Beam ${beam} is already recorded at ${already.weight} kg — ` +
            `delete that entry first if the weight was wrong`,
            409
          );
        }

        covering.beamEntries.push({
          beamNo:    beam,
          weight:    w,
          note:      note?.trim() || "",
          enteredAt: new Date(),
          enteredBy: req.user?._id || undefined,
        });

        covering.producedWeight = covering.beamEntries.reduce(
          (sum, e) => sum + e.weight,
          0
        );

        await covering.save({ session });

        const fp = buildFingerprint(ACTION_CODES.COVERING_BEAM_ENTRY, {
          entityId: covering.job,
          actor:    actorFromRequest(req),
          meta: {
            coveringId:     covering._id.toString(),
            beamNo:         beam,
            weight:         w,
            unit:           'kg',
            producedWeight: covering.producedWeight,
            totalBeams:     covering.beamEntries.length,
            note:           note?.trim() || undefined,
          },
        });
        const job = await JobOrder.findById(covering.job).session(session);
        if (job) {
          job.fingerprints.push(fp);
          await job.save({ session });
        }

        console.log(
          `[covering/beam-entry] Covering ${id}: beam ${beam} = ${w} kg ` +
          `| total = ${covering.producedWeight.toFixed(3)} kg`
        );

        const refreshed = await Covering.findById(covering._id)
          .populate({ path: "beamEntries.enteredBy", select: "name role" })
          .session(session)
          .lean();
        const newest = refreshed.beamEntries[refreshed.beamEntries.length - 1];

        resp = {
          beamEntry:      newest,
          producedWeight: covering.producedWeight,
          totalBeams:     covering.beamEntries.length,
          fingerprint:    fp,
        };
      });
      res.status(201).json({ success: true, ...resp });
    } catch (err) {
      return next(err);
    } finally {
      session.endSession();
    }
  })
);

router.delete(
  "/beam-entry",
  isAdmin('admin', 'production'),
  catchAsyncErrors(async (req, res, next) => {
    const { coveringId, entryId } = req.query;

    if (!coveringId) return next(new ErrorHandler("coveringId is required", 400));
    if (!entryId)    return next(new ErrorHandler("entryId is required", 400));
    // Unchecked, these reached the query as raw strings and Mongo threw
    // a cast error — a 500 for what is plainly a bad request.
    if (!mongoose.Types.ObjectId.isValid(coveringId)) {
      return next(new ErrorHandler("Invalid coveringId", 400));
    }
    if (!mongoose.Types.ObjectId.isValid(entryId)) {
      return next(new ErrorHandler("Invalid entryId", 400));
    }

    // Status check before opening a session — cheap pre-condition.
    const peek = await Covering.findById(coveringId).select("status").lean();
    if (!peek) return next(new ErrorHandler("Covering not found", 404));
    if (peek.status === "completed" || peek.status === "cancelled") {
      return next(
        new ErrorHandler(
          `Cannot remove beam entry from a ${peek.status} covering`, 400
        )
      );
    }

    // Atomic $pull so two concurrent deletes of different entryIds
    // can't race on a stale in-memory `beamEntries` array. The
    // findOneAndUpdate returns the post-pull doc so we can recompute
    // producedWeight in the same transaction.
    const session = await mongoose.startSession();
    try {
      let resp;
      await session.withTransaction(async () => {
        // `{ new: false }` — the PRE-pull document. The post-pull doc
        // cannot answer whether the entry was ever there: $pull removes
        // it when it matches and leaves the array alone when it doesn't,
        // and in both cases the entry is absent afterwards. The old
        // post-check looked for the entry in the post-pull array, which
        // is empty of it by construction, so its 404 could never fire
        // and deleting a beam entry that did not exist reported success
        // — with a recomputed weight, as if something had happened.
        const before = await Covering.findOneAndUpdate(
          { _id: coveringId, status: { $nin: ["completed", "cancelled"] } },
          { $pull: { beamEntries: { _id: entryId } } },
          { new: false, session }
        );
        if (!before) {
          throw new ErrorHandler(
            "Covering changed status before delete could apply", 409
          );
        }
        const existed = (before.beamEntries || []).some(
          (e) => e._id?.toString() === String(entryId)
        );
        if (!existed) {
          throw new ErrorHandler("Beam entry not found", 404);
        }

        const updated = await Covering.findById(coveringId).session(session);
        if (!updated) throw new ErrorHandler("Covering not found", 404);

        updated.producedWeight = updated.beamEntries.reduce(
          (sum, e) => sum + (e.weight || 0),
          0
        );
        await updated.save({ session });

        resp = {
          success:        true,
          producedWeight: updated.producedWeight,
          totalBeams:     updated.beamEntries.length,
        };
      });
      res.status(200).json(resp);
    } catch (err) {
      return next(err);
    } finally {
      await session.endSession();
    }
  })
);

// ─────────────────────────────────────────────────────────────
//  THE FILLED COVERING PROGRAMME, READ FROM A PHOTO
//
//    POST /covering/:id/beam-sheet     multipart "photos" (1–4, or a PDF)
//      → { available, reading: { rows: [...each with a status] }, warnings, suggestionId }
//    POST /covering/:id/beam-entries   { beams: [{ beamNo, weight, note }], suggestionId? }
//      → the checked rows saved together, as /beam-entry saves one
//    GET  /covering/:id/beam-labels.pdf[?beams=1,2,3]
//      → one label a weighed beam, to tie on it
//
//  Reading saves nothing: the rows come back marked new / already
//  recorded (same or a different weight) / duplicated on the sheet /
//  not readable, and a person checks them before saving. Open to the
//  same people as /beam-entry — covering operators record their own.
// ─────────────────────────────────────────────────────────────
const multer = require("multer");
const ledger = require("../services/aiLedger");
const { PROMPTS } = require("../utils/aiPrompts");
const { readCoveringBeams, MAX_PAGES } = require("../utils/coveringBeamOcr");

const BEAM_SURFACE = "covering-beam-ocr";
const beamSheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: MAX_PAGES },
});
const round3 = (n) => Math.round(n * 1000) / 1000;
const dayLabel = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");

/** Each read row, marked against what is already recorded on the covering. */
function markRows(rows, recorded) {
  const seen = new Set();
  return rows.map((r) => {
    const out = { ...r, status: "new", recordedWeight: null };
    if (r.beamNo == null || r.weight == null || r.weight > BEAM_WEIGHT_MAX_KG) {
      out.status = "invalid";
      return out;
    }
    if (seen.has(r.beamNo)) {
      out.status = "duplicate";
      return out;
    }
    seen.add(r.beamNo);
    const had = recorded.get(r.beamNo);
    if (had) {
      out.recordedWeight = had.weight;
      out.status = Math.abs(had.weight - r.weight) < 0.0005 ? "recorded_same" : "recorded_different";
    }
    return out;
  });
}

router.post(
  "/:id/beam-sheet",
  (req, res, next) => beamSheetUpload.array("photos", MAX_PAGES)(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") return next(new ErrorHandler("That photo is too large (over 8 MB). Try again with a smaller one.", 400));
    if (err?.code === "LIMIT_FILE_COUNT" || err?.code === "LIMIT_UNEXPECTED_FILE") {
      return next(new ErrorHandler(`At most ${MAX_PAGES} photos at a time.`, 400));
    }
    return next(err);
  }),
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Invalid covering id", 400));
    const covering = await Covering.findById(req.params.id)
      .select("status beamEntries job")
      .populate({ path: "job", select: "jobOrderNo" })
      .lean();
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    let result;
    try {
      result = await readCoveringBeams(req.files || []);
    } catch (err) {
      if (err.statusCode) return next(new ErrorHandler(err.message, err.statusCode));
      return next(err);
    }
    if (!result.available) {
      return res.json({ success: true, available: false, message: "Reading photos is not set up (no AI key). Enter the beams by hand." });
    }

    const { reading } = result;
    const recorded = new Map((covering.beamEntries || []).map((b) => [Number(b.beamNo), b]));
    const rows = markRows(reading.rows, recorded);
    const jobOrderNo = covering.job?.jobOrderNo ?? null;
    const sheetRef = sheetRefOf(covering._id);

    const warnings = [];
    if (reading.jobOrderNo != null && jobOrderNo != null && reading.jobOrderNo !== jobOrderNo) {
      warnings.push(`This sheet says J-${reading.jobOrderNo}; this covering is for J-${jobOrderNo}.`);
    }
    if (reading.sheetRef && reading.sheetRef !== sheetRef) {
      warnings.push(`This sheet's reference is ${reading.sheetRef}; this covering's is ${sheetRef}.`);
    }
    if (covering.status === "completed" || covering.status === "cancelled") {
      warnings.push(`This covering is ${covering.status}; no beams can be added to it.`);
    }

    const suggestionId = await ledger.record({
      surface: BEAM_SURFACE,
      model: result.model,
      promptVersion: PROMPTS[BEAM_SURFACE]?.version,
      refType: "covering",
      refId: covering._id,
      // Keyed by beam, so settling diffs each beam's weight on its own.
      proposed: {
        beams: Object.fromEntries(rows.filter((r) => r.status !== "invalid" && r.status !== "duplicate").map((r) => [String(r.beamNo), r.weight])),
      },
      latencyMs: result.latencyMs,
      usage: result.usage,
    });

    res.json({
      success: true,
      available: true,
      reading: { ...reading, rows },
      warnings,
      suggestionId,
      covering: { _id: String(covering._id), jobOrderNo, sheetRef, status: covering.status },
    });
  })
);

router.post(
  "/:id/beam-entries",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Invalid covering id", 400));
    const list = req.body?.beams;
    if (!Array.isArray(list) || !list.length) return next(new ErrorHandler("Send at least one beam", 400));
    if (list.length > 200) return next(new ErrorHandler("At most 200 beams at a time", 400));

    // The same checks /beam-entry makes, row by row, before anything is written.
    const beams = [];
    const inRequest = new Set();
    for (const [i, b] of list.entries()) {
      const beam = Number(b?.beamNo);
      const w = Number(b?.weight);
      const where = `Row ${i + 1}`;
      if (!Number.isInteger(beam) || beam <= 0) return next(new ErrorHandler(`${where}: beam number must be a positive whole number`, 400));
      if (!Number.isFinite(w) || w <= 0) return next(new ErrorHandler(`${where} (beam ${beam}): weight must be a positive number (kg)`, 400));
      if (w > BEAM_WEIGHT_MAX_KG) return next(new ErrorHandler(`${where} (beam ${beam}): weight ${w} kg exceeds ${BEAM_WEIGHT_MAX_KG} kg for a single beam`, 400));
      if (inRequest.has(beam)) return next(new ErrorHandler(`Beam ${beam} is listed twice`, 400));
      inRequest.add(beam);
      beams.push({ beamNo: beam, weight: round3(w), note: typeof b.note === "string" ? b.note.trim().slice(0, 200) : "" });
    }

    const session = await mongoose.startSession();
    let resp;
    try {
      await session.withTransaction(async () => {
        const covering = await Covering.findById(req.params.id).session(session);
        if (!covering) throw new ErrorHandler("Covering not found", 404);
        if (covering.status === "completed" || covering.status === "cancelled") {
          throw new ErrorHandler(`Cannot add beam entries to a ${covering.status} covering`, 400);
        }

        // A beam already recorded at the same weight is the same beam sent
        // again (a second press of Save) and is skipped; at a different
        // weight it is a disagreement nobody has settled, so nothing is
        // saved until it is — the same rule /beam-entry keeps for one.
        const recorded = new Map(covering.beamEntries.map((e) => [Number(e.beamNo), e]));
        const clashes = beams.filter((b) => recorded.has(b.beamNo) && Math.abs(recorded.get(b.beamNo).weight - b.weight) >= 0.0005);
        if (clashes.length) {
          const err = new ErrorHandler(
            clashes.map((b) => `Beam ${b.beamNo} is already recorded at ${recorded.get(b.beamNo).weight} kg`).join("; ") +
            " — delete that entry first if the weight was wrong", 409);
          err.code = "BEAM_ALREADY_RECORDED";
          err.details = { beams: clashes.map((b) => ({ beamNo: b.beamNo, weight: b.weight, recordedWeight: recorded.get(b.beamNo).weight })) };
          throw err;
        }
        const adding = beams.filter((b) => !recorded.has(b.beamNo));
        const skipped = beams.filter((b) => recorded.has(b.beamNo)).map((b) => b.beamNo);

        const now = new Date();
        for (const b of adding) {
          covering.beamEntries.push({ ...b, enteredAt: now, enteredBy: req.user?._id || undefined });
        }
        covering.producedWeight = covering.beamEntries.reduce((sum, e) => sum + (e.weight || 0), 0);
        await covering.save({ session });

        if (adding.length) {
          const job = await JobOrder.findById(covering.job).session(session);
          if (job) {
            let total = covering.beamEntries.length - adding.length;
            for (const b of adding) {
              total += 1;
              job.fingerprints.push(buildFingerprint(ACTION_CODES.COVERING_BEAM_ENTRY, {
                entityId: covering.job,
                actor:    actorFromRequest(req),
                meta: {
                  coveringId:     covering._id.toString(),
                  beamNo:         b.beamNo,
                  weight:         b.weight,
                  unit:           "kg",
                  producedWeight: covering.producedWeight,
                  totalBeams:     total,
                  note:           b.note || undefined,
                  source:         "beam-sheet",
                },
              }));
            }
            await job.save({ session });
          }
        }

        const addedNos = new Set(adding.map((b) => b.beamNo));
        resp = {
          added: covering.beamEntries.filter((e) => addedNos.has(Number(e.beamNo))).map((e) => ({
            _id: String(e._id), beamNo: e.beamNo, weight: e.weight, note: e.note || "",
          })),
          skipped,
          producedWeight: round3(covering.producedWeight),
          totalBeams: covering.beamEntries.length,
        };
      });
    } catch (err) {
      return next(err);
    } finally {
      await session.endSession();
    }

    // What the person saved, against what was read — after the commit, and
    // never a reason to fail the save.
    if (req.body.suggestionId && mongoose.Types.ObjectId.isValid(String(req.body.suggestionId))) {
      await ledger.settle(String(req.body.suggestionId), {
        accepted: { beams: Object.fromEntries(beams.map((b) => [String(b.beamNo), b.weight])) },
        decidedBy: req.user?._id,
        expectSurface: BEAM_SURFACE,
        ignoreMissing: true,
      });
    }
    res.status(201).json({ success: true, ...resp });
  })
);

router.get(
  "/:id/beam-labels.pdf",
  catchAsyncErrors(async (req, res, next) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return next(new ErrorHandler("Invalid covering id", 400));
    const covering = await Covering.findById(req.params.id)
      .select("job elasticPlanned beamEntries")
      .populate({ path: "job", select: "jobOrderNo customer", populate: { path: "customer", select: "name" } })
      .populate({ path: "elasticPlanned.elastic", select: "name" })
      .lean();
    if (!covering) return next(new ErrorHandler("Covering not found", 404));

    // ?beams=3,4 — just those (the ones just saved); otherwise every beam.
    const only = req.query.beams
      ? new Set(String(req.query.beams).split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))
      : null;
    const beams = [...(covering.beamEntries || [])]
      .filter((b) => !only || only.has(Number(b.beamNo)))
      .sort((a, b) => a.beamNo - b.beamNo)
      .map((b) => ({ entryId: String(b._id), beamNo: b.beamNo, weight: b.weight, note: b.note || "", dateLabel: dayLabel(b.enteredAt) }));

    const names = [...new Set((covering.elasticPlanned || []).map((l) => l.elastic?.name).filter(Boolean))];
    const data = {
      jobOrderNo: covering.job?.jobOrderNo ?? null,
      coveringId: String(covering._id),
      customerName: covering.job?.customer?.name || "",
      elasticName: names.join(" + "),
      beams,
      branding: await getPdfBranding(),
    };
    const pdf = await renderPdf("coveringBeamLabels", data);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="covering-beam-labels-J-${data.jobOrderNo ?? covering._id}.pdf"`);
    res.send(pdf);
  })
);

module.exports = router;
