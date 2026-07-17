"use strict";
// Unit test for the report PDF renderer — asserts it emits a valid,
// non-trivial PDF for normal, empty, and multi-page (paginated) inputs.

const { renderReportPdf } = require("../../../services/reports/reportPdf.js");

const columns = [
  { key: "label", header: "Customer", format: "text" },
  { key: "dcs", header: "DCs", format: "number" },
  { key: "amount", header: "Value", format: "currency" },
];

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 5).toString() === "%PDF-" && buf.includes(Buffer.from("%%EOF"));

describe("renderReportPdf", () => {
  test("emits a valid PDF for a normal report", async () => {
    const pdf = await renderReportPdf({
      title: "Dispatch & Customer Sales",
      rangeLabel: "This month",
      summaryLine: "₹20,000 dispatched · 3 DCs",
      columns,
      rows: [
        { label: "Acme", dcs: 2, amount: 8000 },
        { label: "Beta", dcs: 1, amount: 12000 },
      ],
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(800);
  });

  test("handles an empty report without throwing", async () => {
    const pdf = await renderReportPdf({ title: "Empty", rangeLabel: "Today", columns, rows: [] });
    expect(isPdf(pdf)).toBe(true);
  });

  test("paginates a large report (200 rows)", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ label: `Customer ${i}`, dcs: i, amount: i * 100 }));
    const pdf = await renderReportPdf({ title: "Big", rangeLabel: "FY", columns, rows });
    expect(isPdf(pdf)).toBe(true);
    // Multiple page objects for 200 rows.
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    expect(pages).toBeGreaterThan(1);
  });
});
