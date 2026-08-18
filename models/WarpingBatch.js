'use strict';

const mongoose = require('mongoose');

/**
 * 🧵 WARPING BATCH — one run of beams warped from a known set of yarn lots.
 *
 * A warping plan says what to build; a batch records what was actually
 * pulled off the rack to build it, and when. The two are separate because
 * one plan is routinely run in several sittings — beams 1–4 today from
 * lot D-4471, beams 5–8 next week from whatever is open then — and the
 * whole point of lot tracking is that those two sittings are distinct.
 *
 * Beams are recorded as plan beam numbers rather than references: the
 * plan's `beams` array is embedded and has no stable ids of its own.
 *
 * See models/YarnLot.js for why issuing a batch moves lot balances but
 * deliberately leaves `RawMaterial.stock` alone.
 */

const AllocationSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Types.ObjectId,
      ref: 'RawMaterial',
      required: true,
    },
    yarnLot: {
      type: mongoose.Types.ObjectId,
      ref: 'YarnLot',
      required: true,
    },
    // Snapshots taken at issue time. The lot document can be renamed or
    // archived years before someone comes asking about a shade complaint,
    // and the batch record has to still make sense on its own.
    lotNo: { type: String, trim: true, default: '' },
    shade: { type: String, trim: true, default: '' },
    materialName: { type: String, trim: true, default: '' },

    /** Kg drawn from this lot for this batch. */
    quantity: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const WarpingBatchSchema = new mongoose.Schema(
  {
    /** Human-facing running number, e.g. "WB-0042". */
    batchNo: { type: String, required: true, unique: true, trim: true },

    warping: {
      type: mongoose.Types.ObjectId,
      ref: 'Warping',
      required: true,
    },
    job: {
      type: mongoose.Types.ObjectId,
      ref: 'JobOrder',
      required: true,
    },

    /** Plan beam numbers this batch covers. */
    beamNos: { type: [Number], default: [] },

    /**
     * The elastic(s) this batch is warping for.
     *
     * Without it a lot can only be traced as far as the job, and a job
     * with three elastics on it gives three possible answers to "which
     * lot is in this roll". Filled automatically when the job has just
     * one elastic — that case is unambiguous and not worth asking about.
     *
     * Left empty when the operator does not say and the job has several:
     * the trail then reports the batch as job-wide rather than guessing,
     * because a confident wrong attribution is worse here than an
     * honest vague one. Someone chasing a shade complaint needs to know
     * which it is.
     */
    elastics: [{ type: mongoose.Types.ObjectId, ref: 'Elastic' }],

    allocations: { type: [AllocationSchema], default: [] },

    /**
     * planned   — lots chosen, nothing drawn yet; freely editable
     * issued    — yarn drawn; lot balances have moved
     * completed — beams warped
     * cancelled — abandoned; if it had been issued the lots were credited back
     */
    status: {
      type: String,
      enum: ['planned', 'issued', 'completed', 'cancelled'],
      default: 'planned',
    },

    issuedDate: { type: Date },
    completedDate: { type: Date },
    machine: { type: mongoose.Types.ObjectId, ref: 'Machine' },
    remarks: { type: String, trim: true, default: '' },

    createdBy: { type: mongoose.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// The batch list on a warping detail page, newest first.
WarpingBatchSchema.index({ warping: 1, createdAt: -1 });
WarpingBatchSchema.index({ job: 1 });
// Tracing forward from a lot: "which batches did this lot go into?"
WarpingBatchSchema.index({ 'allocations.yarnLot': 1 });
// Same trace, for batches issued against a lot recorded only by number.
WarpingBatchSchema.index({ 'allocations.lotNo': 1 });
// And backward, from a finished elastic to the lots behind it.
WarpingBatchSchema.index({ elastics: 1 });

module.exports = mongoose.model('WarpingBatch', WarpingBatchSchema);
