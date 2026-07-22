"use strict";

// ══════════════════════════════════════════════════════════════
//  PDF TEMPLATE  (visual layout designer)
//
//  One template per document type (delivery-challan, purchase-order,
//  report, …). Holds free-positioned elements laid out on an A4 page
//  in PDF points (1pt = 1/72"), designed in the web canvas editor and
//  rendered server-side by services/pdf/templateRenderer.js against a
//  document's live data.
//
//  Element types:
//    text  — static text (el.text)
//    field — bound to a data key (el.field, e.g. "companyName")
//    image — the company logo (context.logo)
//    line  — a horizontal/diagonal rule (x,y → x+w,y+h)
//    box   — a rectangle (stroke, optional fill)
//    table — the line-items grid; el.columns bind to context.rows,
//            paginates down the page. At most one table per template.
// ══════════════════════════════════════════════════════════════

const mongoose = require("mongoose");

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const columnSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },       // key in a row object
    header: { type: String, default: "" },
    width: { type: Number, default: 1 },           // relative weight
    align: { type: String, enum: ["left", "right", "center"], default: "left" },
    format: { type: String, enum: ["text", "number", "currency"], default: "text" },
  },
  { _id: false }
);

const elementSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, enum: ["text", "field", "image", "line", "box", "table"], required: true },
    x: { type: Number, default: 40 },
    y: { type: Number, default: 40 },
    w: { type: Number, default: 200 },
    h: { type: Number, default: 20 },

    // text / field
    text: { type: String, default: "" },
    field: { type: String, default: "" },
    fontSize: { type: Number, default: 10, min: 5, max: 48 },
    bold: { type: Boolean, default: false },
    italic: { type: Boolean, default: false },
    align: { type: String, enum: ["left", "right", "center"], default: "left" },
    color: { type: String, default: "#0D1B2A", validate: { validator: (v) => !v || HEX.test(v), message: "color must be hex" } },

    // line / box
    lineWidth: { type: Number, default: 1 },
    fill: { type: String, default: "" }, // "" = no fill; else hex

    // table
    columns: { type: [columnSchema], default: undefined },
    headerBg: { type: String, default: "#1D6FEB" },
    zebra: { type: Boolean, default: true },
  },
  { _id: false }
);

const pdfTemplateSchema = new mongoose.Schema(
  {
    docType: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: "" },
    pageSize: { type: String, enum: ["A4", "LETTER"], default: "A4" },
    orientation: { type: String, enum: ["portrait", "landscape"], default: "portrait" },
    // Whether this template is used for rendering (vs the built-in
    // code-driven generator). Off by default so nothing changes until an
    // admin explicitly designs + enables a template.
    enabled: { type: Boolean, default: false },
    elements: { type: [elementSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PdfTemplate", pdfTemplateSchema);
