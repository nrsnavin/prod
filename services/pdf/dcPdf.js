'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DELIVERY CHALLAN AS A PDF
//
//  In the visual template designed in Settings → PDF Designer when it is
//  switched on, otherwise the built-in starter layout, so a challan
//  always downloads and a custom design takes over once enabled. One
//  place, so the office (api/deliveryChallan.js) and the customer portal
//  (api/portal/data.js) hand out the same document.
// ══════════════════════════════════════════════════════════════════

const { renderPdf } = require('../../utils/renderPdf');
const PdfTemplate = require('../../models/PdfTemplate');
const { starterTemplate } = require('./docTypes');
const { getPdfBranding } = require('../documentSettings');
const { dcToContext } = require('./dcContext');

/** `dc` is a lean challan with `items.elastic` populated (name). */
async function dcPdf(dc) {
  const [branding, saved] = await Promise.all([
    getPdfBranding(),
    PdfTemplate.findOne({ docType: 'delivery-challan' }).lean(),
  ]);
  const template = saved && saved.enabled ? saved : starterTemplate('delivery-challan');
  return renderPdf('template', template, dcToContext(dc, branding));
}

module.exports = { dcPdf };
