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
  const qty = Number(quote.quantityMetres) || 0;

  // One line: a quote covers one product. The row still goes through the
  // table so the layout is the same family as the PO and the challan,
  // and so a second product can be added later without a new template.
  const rows = [
    {
      sno: 1,
      description: [quote.productName, quote.productSpec]
        .filter(Boolean)
        .join(" — "),
      unit: "m",
      qty,
      rate: Number(quote.rateBeforeTax) || 0,
      amount: Number(quote.valueBeforeTax) || 0,
    },
  ];

  const gstPercent = Number(quote.gstPercent) || 0;

  return {
    logo: branding.logo || null,
    fields: {
      companyName:    branding.companyName    || "",
      tagline:        branding.tagline        || "",
      companyAddress: branding.companyAddress || "",
      companyGstin:   branding.companyGstin ? `GSTIN ${branding.companyGstin}` : "",
      companyContact: branding.companyContact || "",

      docTitle:    "QUOTATION",
      docNo:       quote.quoteNo ? `Quote No: ${quote.quoteNo}` : "",
      quoteNumber: quote.quoteNo || "",
      docDate:     fmtDate(quote.date),
      validTill:   fmtDate(quote.validTill),
      customerRef: quote.customerRef || "",

      partyName:    quote.customerName    || "",
      partyAddress: quote.customerAddress || "",
      partyGstin:   quote.customerGstin ? `GSTIN ${quote.customerGstin}` : "",

      productName: quote.productName || "",
      productSpec: quote.productSpec || "",

      rateExclTax: money(quote.rateBeforeTax),
      // The rate is part of the label so the buyer is never left working
      // out which percentage produced the figure beside it.
      gstLabel:    gstPercent > 0 ? `GST @ ${gstPercent}%` : "GST",
      gstAmount:   money(quote.gstAmount),
      rateInclTax: money(quote.rateInclTax),

      quantity: qty > 0 ? `${qty.toLocaleString("en-IN")} m` : "—",
      valueBeforeTax: qty > 0 ? money(quote.valueBeforeTax) : "—",
      valueInclTax:   qty > 0 ? money(quote.valueInclTax)   : "—",

      remarks: quote.remarks || "",
      termsText:
        branding.quoteTerms ||
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
