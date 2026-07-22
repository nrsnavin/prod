"use strict";

// ══════════════════════════════════════════════════════════════
//  PDF TEMPLATES API  —  /api/v2/pdf-templates
//
//    GET  /doc-types              registered doc types + field catalog
//    GET  /:docType               saved template (or starter default)
//    PUT  /:docType               admin — save the template
//    POST /:docType/preview       admin — render the posted (unsaved)
//                                 template with sample + real branding,
//                                 returns application/pdf
// ══════════════════════════════════════════════════════════════

const express = require("express");
const router = express.Router();
const ErrorHandler = require("../utils/ErrorHandler");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const { isAuthenticated, isAdmin } = require("../middleware/auth");
const PdfTemplate = require("../models/PdfTemplate");
const { listDocTypes, getDocType, starterTemplate } = require("../services/pdf/docTypes");
const { renderTemplatePdf } = require("../services/pdf/templateRenderer");
const { getPdfBranding } = require("../services/documentSettings");

const EDITABLE = ["name", "pageSize", "orientation", "enabled", "elements"];

// Build a live preview context: sample party + line items, but the
// company block reflects the REAL Document Settings so the two features
// stay in sync.
async function previewContext(docType) {
  const dt = getDocType(docType);
  const branding = await getPdfBranding();
  const sample = dt.sample();
  sample.logo = branding.logo || "";
  sample.fields = {
    ...sample.fields,
    companyName: branding.company || sample.fields.companyName,
    tagline: branding.tagline || sample.fields.tagline,
    companyAddress: (branding.addressLines || []).join(", ") || sample.fields.companyAddress,
    companyGstin: branding.gstin || sample.fields.companyGstin,
    companyContact:
      [branding.phone, branding.email].filter(Boolean).join("  ·  ") || sample.fields.companyContact,
    footerNote: branding.footerNote || sample.fields.footerNote,
  };
  return sample;
}

router.get(
  "/doc-types",
  isAuthenticated,
  catchAsyncErrors(async (_req, res) => {
    res.status(200).json({ success: true, docTypes: listDocTypes() });
  })
);

router.get(
  "/:docType",
  isAuthenticated,
  catchAsyncErrors(async (req, res, next) => {
    const { docType } = req.params;
    if (!getDocType(docType)) return next(new ErrorHandler(`Unknown document type: ${docType}`, 404));
    const saved = await PdfTemplate.findOne({ docType }).lean();
    res.status(200).json({ success: true, template: saved || starterTemplate(docType) });
  })
);

router.put(
  "/:docType",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { docType } = req.params;
    if (!getDocType(docType)) return next(new ErrorHandler(`Unknown document type: ${docType}`, 404));

    const update = { docType };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    if (update.elements !== undefined) {
      if (!Array.isArray(update.elements)) {
        return next(new ErrorHandler("elements must be an array", 400));
      }
      if (update.elements.filter((e) => e && e.type === "table").length > 1) {
        return next(new ErrorHandler("A template can have at most one table element", 400));
      }
    }

    const template = await PdfTemplate.findOneAndUpdate(
      { docType },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean();

    res.status(200).json({ success: true, template });
  })
);

router.post(
  "/:docType/preview",
  isAuthenticated,
  isAdmin("admin"),
  catchAsyncErrors(async (req, res, next) => {
    const { docType } = req.params;
    if (!getDocType(docType)) return next(new ErrorHandler(`Unknown document type: ${docType}`, 404));

    // Render the template from the request body (the in-editor draft) so
    // the preview reflects unsaved changes; fall back to the saved one.
    const template = req.body && Array.isArray(req.body.elements)
      ? req.body
      : (await PdfTemplate.findOne({ docType }).lean()) || starterTemplate(docType);

    const context = await previewContext(docType);
    const pdf = await renderTemplatePdf(template, context);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${docType}-preview.pdf"`);
    res.send(pdf);
  })
);

module.exports = router;
