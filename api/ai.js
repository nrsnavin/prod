"use strict";

const express          = require("express");
const router           = express.Router();
const Anthropic        = require("@anthropic-ai/sdk");
const JobOrder         = require("../models/JobOrder");
const ErrorHandler     = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");

// ── Initialise Anthropic client ───────────────────────────────
// Set ANTHROPIC_API_KEY in your .env file
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────────
//  POST /api/v2/ai/generate-warping-plan
//
//  Body: { jobId: string, warpingId: string }
//
//  Returns:
//  {
//    success: true,
//    plan: {
//      noOfBeams: 3,
//      beams: [
//        {
//          beamNo: 1,
//          totalEnds: 400,
//          sections: [
//            { warpYarnId: "...", warpYarnName: "40s Cotton", ends: 200 }
//          ]
//        }
//      ],
//      remarks: "AI rationale..."
//    }
//  }
// ─────────────────────────────────────────────────────────────
router.post(
  "/generate-warping-plan",
  catchAsyncErrors(async (req, res, next) => {
    const { jobId, warpingId } = req.body;
    if (!jobId) return next(new ErrorHandler("jobId is required", 400));

    // ── 1. Fetch job with full elastic population ─────────────
    const job = await JobOrder.findById(jobId).populate({
      path: "elastics.elastic",
      populate: [
        { path: "warpYarn.id",       model: "RawMaterial", select: "name" },
        { path: "warpSpandex.id",    model: "RawMaterial", select: "name" },
        { path: "spandexCovering.id",model: "RawMaterial", select: "name" },
        { path: "weftYarn.id",       model: "RawMaterial", select: "name" },
      ],
    });

    if (!job) return next(new ErrorHandler("Job not found", 404));
    if (!job.elastics?.length) {
      return next(new ErrorHandler("Job has no elastics configured", 400));
    }

    // ── 2. Build elastic context for the prompt ───────────────
    const elasticDetails = job.elastics
      .filter((e) => e.elastic)
      .map((e) => {
        const el = e.elastic;

        const warpYarns = (el.warpYarn || [])
          .filter((w) => w.id?._id)
          .map((w) => ({
            id:   w.id._id.toString(),
            name: w.id.name,
            ends: w.ends || 0,
          }));

        return {
          elasticId:   el._id.toString(),
          elasticName: el.name,
          weaveType:   el.weaveType,
          noOfHook:    el.noOfHook,
          pick:        el.pick,
          spandexEnds: el.spandexEnds || 0,
          yarnEnds:    el.yarnEnds    || 0,
          weight:      el.weight      || 0,
          warpYarns,
          warpSpandex: el.warpSpandex?.id
            ? { name: el.warpSpandex.id.name, ends: el.warpSpandex.ends || 0 }
            : null,
          plannedQty: e.quantity || 0,
        };
      });

    // ── 3. Build the Claude prompt ────────────────────────────
    const systemPrompt = `You are an expert elastic weaving engineer with deep knowledge of warping plans.
A warping plan defines how yarn beams are set up on a weaving machine before production starts.this is narrow weaving 

FACTORY CONSTRAINTS you must follow:
- Each beam has sections; each section specifies one warp yarn and the number of ends for that yarn.
- totalEnds on a beam = sum of ends across all its sections.
- Maximum 30 beams per plan.
- Maximum 600 ends per beam.
- Minimum 1 section per beam.
- noOfHook on the elastic = total hooks (ends) required per repeat unit.
- Use the warpYarns list provided to assign sections — never invent yarn names or IDs.
- All ends values must be positive integers.

OUTPUT FORMAT: Respond with ONLY a single valid JSON object — no explanation, no markdown, no code fences.

JSON schema:
{
  "noOfBeams": <number>,
  "beams": [
    {
      "beamNo": <number>,
      "totalEnds": <number>,
      "sections": [
        { "warpYarnId": "<id string>", "warpYarnName": "<name>", "ends": <number> }
      ]
    }
  ],
  "remarks": "<brief rationale — what guided your beam/section choices>"
}`;

    const userPrompt = `Generate a warping plan for the following job.
Job Order No: ${job.jobOrderNo}

Elastics to be warped:
${JSON.stringify(elasticDetails, null, 2)}

Instructions:
- Distribute the warp yarns across beams logically.
- Keep each beam's totalEnds below 600.
- If an elastic has multiple warp yarns, spread them as separate sections within a beam or across beams.
- noOfHook tells you how many hook ends each elastic needs.
- Pick a sensible beam count (typically 1-4 beams for a single elastic, 2-6 for multiple).
- In remarks briefly explain the beam/section logic you used.`;

    // ── 4. Call Claude ────────────────────────────────────────
    const message = await anthropic.messages.create({
      model:      "claude-opus-4-6",
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });

    const rawText = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    // ── 5. Parse the JSON response ────────────────────────────
    let plan;
    try {
      // Strip any accidental markdown fences
      const cleaned = rawText.replace(/```json|```/g, "").trim();
      plan = JSON.parse(cleaned);
    } catch (e) {
      console.error("Claude returned non-JSON:", rawText);
      return next(new ErrorHandler(
        "AI returned an unexpected response. Please try again.", 502
      ));
    }

    // ── 6. Basic sanity check ─────────────────────────────────
    if (!Array.isArray(plan.beams) || !plan.beams.length) {
      return next(new ErrorHandler("AI plan was malformed. Please try again.", 502));
    }

    // Recompute totalEnds to make sure it matches sections
    plan.beams = plan.beams.map((b) => ({
      ...b,
      totalEnds: (b.sections || []).reduce((s, sec) => s + (sec.ends || 0), 0),
    }));
    plan.noOfBeams = plan.beams.length;

    // Attach the warpingId for reference (Flutter uses it when saving)
    res.json({ success: true, plan, warpingId: warpingId || null });
  })
);

module.exports = router;

// ── Register in app.js / server.js ────────────────────────────
// const aiRouter = require("./routes/ai_warping_route");
// app.use("/api/v2/ai", aiRouter);
//
// Install SDK first:  npm install @anthropic-ai/sdk
// Add to .env:        ANTHROPIC_API_KEY=sk-ant-...