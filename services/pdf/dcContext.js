"use strict";

// ══════════════════════════════════════════════════════════════
//  DELIVERY-CHALLAN → template render context
//
//  Maps a DeliveryChallan document + Document-Settings branding into
//  the { fields, rows, logo } shape the template renderer consumes.
//  The letterhead (company*) comes from branding; the party + line
//  items come from the DC itself.
// ══════════════════════════════════════════════════════════════

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function dcToContext(dc, branding = {}) {
  const items = Array.isArray(dc.items) ? dc.items : [];
  return {
    logo: branding.logo || "",
    fields: {
      // ── letterhead (from Document Settings) ──
      companyName: branding.company || "Balu Elastics",
      tagline: branding.tagline || "",
      companyAddress: (branding.addressLines || []).join(", "),
      companyGstin: branding.gstin ? `GSTIN: ${branding.gstin}` : "",
      companyContact: [branding.phone, branding.email].filter(Boolean).join("  ·  "),
      // ── document identity ──
      docTitle: "DELIVERY CHALLAN",
      docNo: dc.dcNumber || "",
      docDate: fmtDate(dc.dispatchDate || dc.createdAt),
      // ── party (from the DC) ──
      partyName: dc.customerName || "",
      partyAddress: dc.customerAddress || "",
      partyGstin: dc.customerGstin ? `GSTIN: ${dc.customerGstin}` : "",
      // Held on the DC record but never printed: the driver may need to
      // ring ahead, and the consignee's number is the one thing on the
      // paperwork that lets them.
      partyContact: dc.customerPhone || "",
      // ── totals ──
      //
      // Quantity only. A delivery challan accompanies goods; it is not a
      // tax invoice, and putting a value on it invites it being treated as
      // one. Rate and amount are deliberately absent from this context, so
      // a template cannot bind them even by hand.
      totalQty: `${Number(dc.totalQuantity || 0).toLocaleString("en-IN")}`,
      lineCount: String(items.length),
      // ── transport ──
      vehicleNo: dc.vehicleNo || "",
      // Captured alongside the vehicle, and until now only ever shown on
      // screen — the gate clerk checking the lorry out has no other copy.
      driverName: dc.driverName || "",
      transporter: dc.transporter || "",
      lrNumber: dc.lrNumber || "",
      // Free text the dispatcher typed on this challan. It was being
      // dropped entirely, so an instruction meant for whoever receives
      // the goods never travelled with them.
      remarks: dc.remarks || "",
      orderNo: dc.orderNo != null ? `Order #${dc.orderNo}` : "",
      // ── footer / terms (from Document Settings) ──
      footerNote: branding.footerNote || "",
      termsText: branding.termsText || "",
    },
    rows: items.map((it, i) => ({
      sno: i + 1,
      description: it.elasticName || it.description || (it.elastic && it.elastic.name) || "—",
      unit: it.unit || "",
      qty: Number(it.quantity || 0),
      // `rate` and `amount` are not carried. The DC document still stores
      // them (the create form captures a value), but they are not part of
      // what a challan presents.
    })),
  };
}

module.exports = { dcToContext };
