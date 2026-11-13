'use strict';
// ══════════════════════════════════════════════════════════════════
//  A DELIVERY CHALLAN AS A PDF
//
//  In the visual template designed in Settings → PDF Designer when it is
//  switched on; otherwise on the ruled sheet the tax invoice uses
//  (utils/challanPdf.js), so a challan always downloads and a custom
//  design takes over once enabled. One place, so the office
//  (api/deliveryChallan.js) and the customer portal (api/portal/data.js)
//  hand out the same document.
// ══════════════════════════════════════════════════════════════════

const { renderPdf } = require('../../utils/renderPdf');
const PdfTemplate = require('../../models/PdfTemplate');
const { getPdfBranding, getDocumentSettings } = require('../documentSettings');
const { dcToContext } = require('./dcContext');

/** `dc` is a lean challan with `items.elastic` populated (name, hsn). */
async function dcPdf(dc) {
  const [branding, saved] = await Promise.all([
    getPdfBranding(),
    PdfTemplate.findOne({ docType: 'delivery-challan' }).lean(),
  ]);
  if (saved && saved.enabled) return renderPdf('template', saved, dcToContext(dc, branding));
  // The city, PIN and default HSN live with the invoice settings.
  let invoice = {};
  try { invoice = (await getDocumentSettings())?.invoice || {}; } catch (_) { /* the letterhead without them */ }
  return renderPdf('challan', { dc, branding, settings: { invoice } });
}

module.exports = { dcPdf };
