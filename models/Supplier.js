import mongoose from 'mongoose';

const supplierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    gstin: {
      type: String,
      trim: true,
      uppercase: true,
      unique: true,
      sparse: true, // allows multiple nulls
      match: [
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/,
        'Invalid GSTIN format',
      ],
    },

    phone: {
      type: String,
      trim: true,
    },

    address: {
      type: String,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model('Supplier', supplierSchema);
