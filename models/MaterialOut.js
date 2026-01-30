import mongoose from 'mongoose';

const materialOutwardSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RawMaterial',
      required: true,
    },

    quantity: {
      type: Number, // Double
      required: true,
    },

    // 🔗 NEW REFERENCE
    job: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job', // 👈 future Job schema
      required: false, // optional for now
    },

    outwardDate: {
      type: Date,
      default: Date.now,
    },

    remarks: {
      type: String,
    },

    // 💰 Cost captured at issue time (FIFO / Avg)
    cost: {
      type: Number,
    },
  },
  { timestamps: true }
);

materialOutwardSchema.index({ rawMaterial: 1, outwardDate: -1 });
materialOutwardSchema.index({ job: 1 });

export default mongoose.model('MaterialOutward', materialOutwardSchema);
