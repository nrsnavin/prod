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
//
//  The customer's purchase-order number is on the order, not the
//  challan, so it is looked up here for every caller.
// ══════════════════════════════════════════════════════════════════

const { renderPdf } = require('../../utils/renderPdf');
const PdfTemplate = require('../../models/PdfTemplate');
const Order = require('../../models/Order');
const { getPdfBranding, getDocumentSettings } = require('../documentSettings');
const { dcToContext } = require('./dcContext');

/** The customer's P.O. on the challan's order ('' with no order). */
async function customerPoOf(dc) {
  const o = dc.order;
  if (!o) return '';
  if (typeof o === 'object' && typeof o.po === 'string') return o.po;
  try {
    const order = await Order.findById(o._id || o).select('po').lean();
    return order?.po || '';
  } catch (_) {
    return ''; // a challan prints without it rather than not at all
  }
}

/** `dc` is a lean challan with `items.elastic` populated (name, hsn). */
async function dcPdf(dc) {
  const [branding, saved, customerPo] = await Promise.all([
    getPdfBranding(),
    PdfTemplate.findOne({ docType: 'delivery-challan' }).lean(),
    customerPoOf(dc),
  ]);
  const withPo = { ...dc, customerPo };
  if (saved && saved.enabled) return renderPdf('template', saved, dcToContext(withPo, branding));
  // The city, PIN and default HSN live with the invoice settings.
  let invoice = {};
  try { invoice = (await getDocumentSettings())?.invoice || {}; } catch (_) { /* the letterhead without them */ }
  return renderPdf('challan', { dc: withPo, branding, settings: { invoice } });
}

module.exports = { dcPdf };
