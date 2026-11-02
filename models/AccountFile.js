"use strict";
// The bytes of a bill photo or PDF attached to an accounts document,
// one document each. The document keeps only the name, type, size and
// this id, so five 5 MB attachments never push a bill past MongoDB's
// 16 MB document limit, and lists never carry file bytes.

const mongoose = require("mongoose");

const AccountFileSchema = new mongoose.Schema(
  {
    contentType: { type: String, required: true },
    size:        { type: Number, required: true },
    filename:    { type: String, default: "" },
    data:        { type: Buffer, required: true },
    owner:       { kind: { type: String, default: "" }, id: { type: mongoose.Types.ObjectId } },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AccountFile", AccountFileSchema);
