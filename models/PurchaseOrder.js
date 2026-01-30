import mongoose from 'mongoose';

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: {
      type: String,
      required: true,
      unique: true,
    },

    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
      required: true,
    },

    materials: [
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
        rate: {
          type: Number,
        },
      },
    ],

    status: {
      type: String,
      enum: ['CREATED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
      default: 'CREATED',
    },

    expectedDate: {
      type: Date,
    },
  },
  { timestamps: true }
);

export default mongoose.model('PurchaseOrder', purchaseOrderSchema);
