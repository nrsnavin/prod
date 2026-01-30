import mongoose from "mongoose";

const ComplaintSchema = new mongoose.Schema(
  {
    // 📅 COMPLAINT DATE
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },

    // 👤 CUSTOMER
    customer: {
      type: mongoose.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },

    // 🔗 LINKED JOB / ORDER
    order: {
      type: mongoose.Types.ObjectId,
      ref: "JobOrder",
      required: true,
      index: true,
    },

    // 🔄 COMPLAINT STATUS
    status: {
      type: String,
      enum: ["Open", "InReview", "Resolved", "Rejected", "Closed"],
      default: "Open",
      required: true,
    },

    // ❗ REASON / ISSUE
    reason: {
      type: String,
      required: true,
      trim: true,
    },

    // 📝 CUSTOMER / INTERNAL FEEDBACK
    feedback: {
      type: String,
      trim: true,
    },

    // 🧑‍🏭 ACTION TAKEN BY
    actionTakenBy: {
      type: mongoose.Types.ObjectId,
      ref: "Employee",
    },

    // 🛠 ROOT CAUSE / RESOLUTION NOTES
    resolution: {
      type: String,
    },

    // 📎 OPTIONAL EVIDENCE (IMAGE / DOC)
    attachments: [
      {
        type: String, // file URL / path
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model("Complaint", ComplaintSchema);
