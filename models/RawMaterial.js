import mongoose from 'mongoose';

const rawMaterialSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
    },

    category: {
      type: String,
      enum: ['warp', 'weft', 'covering', 'rubber', 'chemicals'],
      required: true,
    },

    stock: {
      type: Number, // Double
      default: 0,
    },

    minStock: {
      type: Number, // Double
      default: 0,
    },

    totalConsumption: {
      type: Number, // Double
      default: 0,
    },
  },
  { timestamps: true }
);

// 🔍 Index for fast lookup
rawMaterialSchema.index({ name: 1, category: 1 });

export default mongoose.model('RawMaterial', rawMaterialSchema);
