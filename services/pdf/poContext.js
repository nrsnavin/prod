"use strict";

// ══════════════════════════════════════════════════════════════
//  PURCHASE-ORDER → template render context
//
//  Maps a PurchaseOrder (supplier + items populated) + Document-Settings
//  branding into the { fields, rows, logo } shape the template renderer
//  consumes. Letterhead comes from branding; the vendor + line items
//  come from the PO. Amount is price × quantity per line.
// ══════════════════════════════════════════════════════════════

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}
// "Rs." not ₹ — the built-in PDF font cannot encode U+20B9 and renders it
// as a stray "¹". Matches templateRenderer and the payslip PDF.
function inr(n) {
  return "Rs. " + Math.round(Number(n) || 0).toLocaleString("en-IN");
}

function poToContext(po, branding = {}) {
  const items = Array.isArray(po.items) ? po.items : [];
  const rows = items.map((it, i) => {
    const qty = Number(it.quantity || 0);
    const rate = Number(it.price || 0);
    const name =
      (it.rawMaterial && it.rawMaterial.name) ||
      it.name ||
      "—";
    return {
      sno: i + 1,
      description: name,
      unit: (it.rawMaterial && it.rawMaterial.unit) || it.unit || "",
      qty,
      rate,
      amount: qty * rate,
    };
  });
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const totalAmount = rows.reduce((s, r) => s + r.amount, 0);
  const supplier = po.supplier && typeof po.supplier === "object" ? po.supplier : {};

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
      docTitle: "PURCHASE ORDER",
      docNo: po.poNo != null ? `PO #${po.poNo}` : "",
      docDate: fmtDate(po.date || po.createdAt),
      // ── vendor (from the PO's supplier) ──
      partyName: supplier.name || "",
      partyAddress: supplier.address || "",
      partyGstin: supplier.gstin ? `GSTIN: ${supplier.gstin}` : "",
      partyContact: [supplier.phoneNumber, supplier.email].filter(Boolean).join("  ·  "),
      // ── extras available to bind ──
      expectedDate: po.expectedDate ? `Expected: ${fmtDate(po.expectedDate)}` : "",
      poStatus: po.status || "",
      // Bare equivalents for a layout that supplies its own labels — the
      // prefixed versions above read as "EXPECTED DELIVERY / Expected: …"
      // inside a labelled box. Both are kept so a saved template that binds
      // the old keys is unaffected.
      poNumber: po.poNo != null ? String(po.poNo) : "",
      expectedDelivery: fmtDate(po.expectedDate),
      // What this PO was bought for. A purchase raised from a job's
      // material shortfall carries the link, and the supplier's copy is
      // where "why did we buy this?" gets answered months later.
      raisedFor: (() => {
        const job = po.forJob && typeof po.forJob === "object" ? po.forJob : null;
        const order = po.forOrder && typeof po.forOrder === "object" ? po.forOrder : null;
        const bits = [];
        if (job?.jobOrderNo != null) bits.push(`Job J-${job.jobOrderNo}`);
        if (order?.orderNo != null) bits.push(`Order #${order.orderNo}`);
        return bits.length ? `For ${bits.join("  ·  ")}` : "";
      })(),
      // ── totals ──
      totalQty: totalQty.toLocaleString("en-IN"),
      totalAmount: inr(totalAmount),
      lineCount: String(rows.length),
      // ── footer / terms (from Document Settings) ──
      footerNote: branding.footerNote || "",
      termsText: branding.termsText || po.notes || "",
    },
    rows,
  };
}

module.exports = { poToContext };
