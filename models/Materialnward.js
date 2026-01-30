import mongoose from 'mongoose';

const materialInwardSchema = new mongoose.Schema(
  {
    rawMaterial: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RawMaterial',
      required: true,
    },

    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseOrder',
    },

    quantity: {
      type: Number, // Double
      required: true,
    },

    inwardDate: {
      type: Date,
      default: Date.now,
    },

    remarks: {
      type: String,
    },
  },
  { timestamps: true }
);

materialInwardSchema.index({ rawMaterial: 1, inwardDate: -1 });

export default mongoose.model('MaterialInward', materialInwardSchema);
