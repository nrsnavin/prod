"use strict";

// ══════════════════════════════════════════════════════════════
//  QUOTATION → template render context
//
//  Maps a Quote + Document-Settings branding into the
//  { fields, rows, logo } shape the template renderer consumes.
//
//  A rate per metre is a small number — around ₹5 — so it is shown to
//  two decimal places and NOT rounded to whole rupees the way a purchase
//  order's line amounts are. Rounding ₹4.91 to ₹5 is a 1.8% error on
//  every metre, which over a 50,000 m order is real money and would make
//  the printed rate disagree with the value beside it.
// ══════════════════════════════════════════════════════════════

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// "Rs." not ₹ — the built-in PDF font cannot encode U+20B9 and renders
// it as a stray "¹". Matches poContext and the payslip PDF.
function money(n, dp = 2) {
  const v = Number(n) || 0;
  return "Rs. " + v.toLocaleString("en-IN", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function quoteToContext(quote, branding = {}) {
  const lines = Array.isArray(quote.lines) ? quote.lines : [];

  // One row per product. The description carries the specification only
  // when there is one, so a line for a plain product does not print a
  // trailing dash.
  const rows = lines.map((l, i) => ({
    sno: i + 1,
    description: [l.productName, l.productSpec].filter(Boolean).join(' — '),
    unit: 'm',
    qty: Number(l.quantityMetres) || 0,
    rate: Number(l.rateBeforeTax) || 0,
    amount: Number(l.valueBeforeTax) || 0,
  }));

  const gstPercent = Number(quote.gstPercent) || 0;
  const anyQuantity = lines.some((l) => (Number(l.quantityMetres) || 0) > 0);

  // A quote for a rate with no quantity is a legitimate thing to send —
  // "what would 20mm cost?" — and printing Rs 0.00 against it would read
  // as a price rather than an absence.
  const totalOrDash = (n) => (anyQuantity ? money(n) : '—');

  return {
    logo: branding.logo || "",
    fields: {
      // Straight off the Document Settings shape — `company`, `gstin`,
      // `phone`/`email`, `addressLines[]`. Reading `companyName` and
      // friends instead put an EMPTY letterhead on every quotation: the
      // keys simply do not exist on the branding object, so the company
      // name, address, GSTIN and contact all rendered blank. Same mapping
      // poContext uses, so the two documents cannot disagree about who
      // sent them.
      companyName:    branding.company || "Balu Elastics",
      tagline:        branding.tagline || "",
      companyAddress: (branding.addressLines || []).join(", "),
      companyGstin:   branding.gstin ? `GSTIN: ${branding.gstin}` : "",
      companyContact: [branding.phone, branding.email, branding.website]
        .filter(Boolean).join("  ·  "),

      docTitle:    "QUOTATION",
      docNo:       quote.quoteNo ? `Quote No: ${quote.quoteNo}` : "",
      quoteNumber: quote.quoteNo || "",
      docDate:     fmtDate(quote.date),
      validTill:   fmtDate(quote.validTill),
      customerRef: quote.customerRef || "",

      partyName:    quote.customerName    || "",
      partyAddress: quote.customerAddress || "",
      partyGstin:   quote.customerGstin ? `GSTIN ${quote.customerGstin}` : "",

      // The product pane names what is being quoted. With one line that
      // is the product; with several it is the count, because listing
      // three names in a box sized for one truncates all three.
      productName: lines.length === 1
        ? (lines[0].productName || "")
        : `${lines.length} products`,
      productSpec: lines.length === 1
        ? (lines[0].productSpec || "")
        : lines.map((l) => l.productName).join(", "),

      // ── Document totals ──
      subTotal:   totalOrDash(quote.subTotal),
      gstLabel:   gstPercent > 0 ? `GST @ ${gstPercent}%` : "GST",
      gstAmount:  totalOrDash(quote.gstAmount),
      grandTotal: totalOrDash(quote.grandTotal),

      quantity: anyQuantity
        ? `${(Number(quote.totalQuantityMetres) || 0).toLocaleString("en-IN")} m`
        : "—",
      lineCount: String(lines.length),

      remarks: quote.remarks || "",
      termsText:
        branding.termsText ||
        "1. Rates are per metre, ex-works, and exclude freight unless stated.\n" +
        "2. This quotation is valid until the date shown above.\n" +
        "3. Rates are subject to yarn price movement after that date.\n" +
        "4. Orders are accepted subject to written confirmation.",
      footerNote:
        branding.footerNote || "This is a computer-generated quotation.",
    },
    rows,
  };
}

module.exports = { quoteToContext, fmtDate, money };
