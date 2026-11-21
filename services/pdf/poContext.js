"use strict";

const { indiaDay } = require("../../utils/indiaLabel");
const { pricePo } = require("../purchaseTax");
const { amountInWords } = require("../gst");

// ══════════════════════════════════════════════════════════════
//  PURCHASE-ORDER → template render context
//
//  Maps a PurchaseOrder (supplier + items populated) + Document-Settings
//  branding into the { fields, rows, logo } shape the template renderer
//  consumes. Letterhead comes from branding; the vendor + line items
//  come from the PO. Amount is price × quantity per line, before GST —
//  as it always was, so a saved layout binding `amount` and
//  `totalAmount` reads as before. The GST (services/purchaseTax.js:
//  the line's rate, else the material's, else the default) is in the
//  added keys: hsn, gst, taxAmount and total per row; taxableAmount,
//  the CGST/SGST or IGST lines and grandTotal in the fields.
// ══════════════════════════════════════════════════════════════

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return indiaDay(dt, { day: "2-digit", month: "short", year: "numeric" });
}
// "Rs." not ₹ — the built-in PDF font cannot encode U+20B9 and renders it
// as a stray "¹". Matches templateRenderer and the payslip PDF: whole
// rupees as they are, paise kept where there are any.
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function inr(n) {
  const v = r2(n);
  return "Rs. " + v.toLocaleString("en-IN", Number.isInteger(v) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const pct = (n) => `${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;

/**
 * The tax lines under the taxable value: CGST and SGST for a supplier
 * in our state, IGST for one outside it, or a word on why there is none.
 * The rate is printed in the label when every line carries the same one.
 */
function taxLines(tax) {
  const t = tax.totals;
  if (tax.noGst) return [["No GST (composition / unregistered supplier)", "—"], ["", ""]];
  const rates = [...new Set(tax.lines.filter((l) => l.taxable > 0).map((l) => l.gstPercent))];
  const one = rates.length === 1 ? rates[0] : null;
  if (tax.supplyType === "inter") {
    return [[one != null ? `IGST @ ${pct(one)}` : "IGST", inr(t.igst)], ["", ""]];
  }
  return [
    [one != null ? `CGST @ ${pct(one / 2)}` : "CGST", inr(t.cgst)],
    [one != null ? `SGST @ ${pct(one / 2)}` : "SGST", inr(t.sgst)],
  ];
}

/**
 * @param po          supplier and items.rawMaterial populated
 * @param branding    getPdfBranding()
 * @param taxSettings purchaseTaxSettings(): our state and the default rate
 */
function poToContext(po, branding = {}, taxSettings = {}) {
  const items = Array.isArray(po.items) ? po.items : [];
  const tax = pricePo(po, taxSettings);
  const rows = items.map((it, i) => {
    const qty = Number(it.quantity || 0);
    const rate = Number(it.price || 0);
    const name =
      (it.rawMaterial && it.rawMaterial.name) ||
      it.name ||
      "—";
    const line = tax.lines[i];
    const lineTax = r2(line.cgst + line.sgst + line.igst);
    return {
      sno: i + 1,
      description: name,
      hsn: line.hsn,
      unit: (it.rawMaterial && it.rawMaterial.unit) || it.unit || "",
      qty,
      rate,
      gst: tax.noGst ? "—" : pct(line.gstPercent),
      amount: r2(qty * rate),
      taxAmount: lineTax,
      total: r2(r2(qty * rate) + lineTax),
    };
  });
  const totalQty = rows.reduce((s, r) => s + r.qty, 0);
  const totalAmount = r2(rows.reduce((s, r) => s + r.amount, 0));
  const supplier = po.supplier && typeof po.supplier === "object" ? po.supplier : {};
  const [[tax1Label, tax1Amount], [tax2Label, tax2Amount]] = taxLines(tax);

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
      // ── GST ──
      taxableAmount: inr(tax.totals.taxable),
      tax1Label, tax1Amount, tax2Label, tax2Amount,
      cgstAmount: inr(tax.totals.cgst),
      sgstAmount: inr(tax.totals.sgst),
      igstAmount: inr(tax.totals.igst),
      taxAmount: inr(tax.totals.tax),
      roundOffLabel: tax.totals.roundOff ? "Round off" : "",
      roundOff: tax.totals.roundOff ? inr(tax.totals.roundOff) : "",
      grandTotal: inr(tax.totals.grand),
      amountInWords: amountInWords(tax.totals.grand),
      // ── footer / terms (from Document Settings) ──
      footerNote: branding.footerNote || "",
      termsText: branding.termsText || po.notes || "",
    },
    rows,
  };
}

module.exports = { poToContext };
