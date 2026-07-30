const mongoose = require("mongoose");

/**
 * A bill attached to a machine's service log — either the service/labour
 * invoice or a bill for a spare part fitted during the job.
 *
 * Deliberately its OWN collection rather than a sub-document on the
 * ServiceLog. Service logs are embedded in the Machine document, and with
 * the file bytes inline a machine that is serviced regularly would march
 * straight into MongoDB's 16 MB per-document limit and start failing saves
 * on an unrelated write. Keeping the bytes out here bounds the blob per
 * *bill* instead of per *machine*, and lets every listing endpoint skip the
 * payload with a plain `.select("-data")`.
 *
 * The file itself is a base64 data URL, matching how QcRecord photos and
 * the DocumentSettings logo are already stored — this deployment has no
 * object storage configured. If S3 is added later, `data` becomes a key
 * and only this model plus the download route change.
 */

const BILL_KINDS = ["service_bill", "spare_bill"];

// Bills arrive as a phone photo or the vendor's PDF.
const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
];

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const MachineServiceBillSchema = new mongoose.Schema(
  {
    machine: {
      type: mongoose.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
    // _id of the ServiceLog sub-document this bill belongs to.
    serviceLog: {
      type: mongoose.Types.ObjectId,
      required: true,
    },
    kind: {
      type: String,
      enum: BILL_KINDS,
      required: true,
    },
    filename: { type: String, trim: true, default: "" },
    contentType: {
      type: String,
      enum: ALLOWED_CONTENT_TYPES,
      required: true,
    },
    /** Size of the original file in bytes, before base64 inflation. */
    size: { type: Number, required: true, min: 0 },
    /** data:<mime>;base64,<payload> */
    data: { type: String, required: true },

    // ── Bookkeeping, all optional ──────────────────────────────
    /** What the bill is for; rolled up and shown against the log's cost. */
    amount: { type: Number, default: 0, min: 0 },
    vendor: { type: String, trim: true, default: "" },
    billNo: { type: String, trim: true, default: "" },
    billDate: { type: Date, default: null },
    /** Spare bills describe the part fitted. */
    partName: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },

    uploadedBy: {
      type: mongoose.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// Serves "all bills for this log" and "all bills for this machine".
MachineServiceBillSchema.index({ machine: 1, serviceLog: 1, createdAt: -1 });

const MachineServiceBill = mongoose.model(
  "MachineServiceBill",
  MachineServiceBillSchema
);

module.exports = MachineServiceBill;
module.exports.BILL_KINDS = BILL_KINDS;
module.exports.ALLOWED_CONTENT_TYPES = ALLOWED_CONTENT_TYPES;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;
