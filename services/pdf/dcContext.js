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

function inr(n) {
  return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");
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
      // ── totals ──
      totalQty: `${Number(dc.totalQuantity || 0).toLocaleString("en-IN")}`,
      totalAmount: inr(dc.totalAmount),
      // ── transport (available to bind if the template wants it) ──
      vehicleNo: dc.vehicleNo || "",
      transporter: dc.transporter || "",
      lrNumber: dc.lrNumber || "",
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
      rate: Number(it.rate || 0),
      amount: Number(it.amount || 0),
    })),
  };
}

module.exports = { dcToContext };
